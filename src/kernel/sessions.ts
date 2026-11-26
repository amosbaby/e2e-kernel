import { randomBytes } from 'node:crypto';
import { lstatSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DriverError } from '../driver/types.ts';
import type { Decision, Driver, Instance, Page, RequestInfo } from '../driver/types.ts';
import { buildResult, resolveSuperseded } from '../report/result.ts';
import type { ClosedBy, RunResult } from '../report/result.ts';
import { pruneRuns, runDirName, writeRun } from '../report/store.ts';
import { E2kError } from '../shared/errors.ts';
import type { Viewport } from '../shared/ops.ts';
import { ensurePrivateDir, resolveInside } from '../shared/paths.ts';
import type { Home } from '../shared/paths.ts';
import type { CloseParams, CloseResult, Mode, OpenParams, OpenResult, SessionInfo, StepParams, StepResult }
  from '../shared/protocol.ts';
import { redactText, redactUrl } from '../shared/redact.ts';
import { exitFor, runOps, tally } from './executor.ts';
import type { ModeResolver } from './mode.ts';
import { DEFAULT_PROFILE, recordLogin } from './profiles.ts';
import { Recorder, isWrite, safely, toWriteRecord } from './recorder.ts';
import type { WriteRecord } from './recorder.ts';
import type { WritePolicy } from './write-policy.ts';

// 会话管理（设计 5.2、5.5、5.6）：实例的懒启动和复用、会话的开、执行、收尾、闲置超时、关停。
// 「主机」一律指 URL.hostname（不带端口）。

export interface SessionDeps {
  driver: Driver; home: Home; modes: ModeResolver; policy: WritePolicy;
  idleMs: number; keepRuns: number; now(): Date; kernelVersion: string; log(line: string): void;
}

const DEFAULT_NAME = 'session';
const MAX_SNAPSHOT = 20_000;
const MAX_UNATTRIBUTED = 200;

// opening：页面已登记、首屏还没读完，对外当作不存在；closing：收尾中，再来的 step、close 都是 busy。
type State = 'opening' | 'idle' | 'stepping' | 'closing';

interface Session {
  readonly id: string;
  readonly name: string;
  readonly nameDir: string;
  readonly dirName: string;
  readonly runDir: string;
  readonly startedAt: Date;
  readonly instance: Instance;               // 会话的页所在的实例
  readonly start: { url: string; viewport: Viewport | null; touch: boolean; profile: string };
  readonly page: Page;                       // 会话的主页面，操作只作用在它上面
  readonly pages: Map<string, Page | null>;  // 本会话的所有页（含弹窗）；只知道 id、还没拿到对象的记 null
  readonly recorder: Recorder;
  url: string;                               // 首屏读数里的地址（已脱敏），给 list()
  state: State;
  gone: boolean;                             // 主页面已关或会话已在收尾：同步置位，step 的后续操作据此不再执行
  lastActive: number;
  timer: NodeJS.Timeout | undefined;
  finished: Promise<CloseResult> | undefined;
}

// 登录页（设计 5.5）：内核开的那一页，加上它弹出的窗口。这些页的请求一律放行、不记录。
interface Login {
  readonly id: string;
  readonly instance: Instance;
  readonly host: string;                     // 起始地址的主机（URL.hostname），人按回车结束时记进登录记录
  readonly pages: Map<string, Page | null>;  // 只知道 id、还没拿到对象的记 null
}

function busy(): E2kError {
  return new E2kError('busy', '会话正忙', '稍后重试');
}

// 关停开始以后，所有入口一律拒绝。
function stopping(): E2kError {
  return new E2kError('busy', '内核正在关停', '等内核重新启动后再试');
}

// 错误只留第一行并脱敏：驱动的消息里可能带着 URL 或选择器。
function firstLine(e: unknown): string {
  return safely(() => redactText(String(e instanceof Error ? e.message : e).split('\n', 1)[0] ?? ''));
}

function errorText(e: unknown): string {
  if (e instanceof DriverError) return `${e.kind}: ${firstLine(e)}`;
  if (e instanceof E2kError) return `${e.code}: ${firstLine(e)}`;
  return firstLine(e);
}

// 先脱敏再截断：反过来会把 token 切成认不出来的半截。
function cappedSnapshot(raw: string): string {
  return safely(() => {
    const s = redactText(raw);
    return s.length > MAX_SNAPSHOT ? `${s.slice(0, MAX_SNAPSHOT)}…[truncated ${s.length}]` : s;
  });
}

type LoginWall = { blocked: 'login' | null; next: string | null };

// 主页面顶层文档里有没有可见的密码框。这只是给人的提示，不是安全判断：驱动查不出（抛 DriverError）就当没有，少提示一次。
// 别的错误（内核自己的毛病）照常往上抛。next 里的地址先脱敏。
async function loginWall(page: Page, startUrl: string): Promise<LoginWall> {
  let found = false;
  try {
    found = await page.hasVisiblePasswordField();
  } catch (e) {
    if (!(e instanceof DriverError)) throw e;
  }
  if (!found) return { blocked: null, next: null };
  return {
    blocked: 'login',
    next: `页面停在登录页（有可见的密码框）：请人运行 login ${safely(() => redactUrl(startUrl))} 登录后重试；若这是预期页面（如修改密码页）可忽略。会话仍开着，用完请 close`,
  };
}

function hostOf(url: string): string {
  return new URL(url).hostname;
}

function randomHex(): string {
  return randomBytes(3).toString('hex');
}

// lstat：悬空的符号链接也算占用。
function taken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export class SessionManager {
  private readonly deps: SessionDeps;
  private readonly sessions = new Map<string, Session>();
  // 已经抽到 id、还没建成会话（或已放弃）的 open：id → 报告目录名。
  private readonly reserved = new Map<string, string>();
  private readonly logins = new Map<string, Login>();
  // 内核级的「未归属的写」：归不到任何会话或登录页的写请求，只留最近 MAX_UNATTRIBUTED 条。
  private readonly unattributed: WriteRecord[] = [];
  private instance: Instance | undefined;
  private acquiring: Promise<Instance> | undefined;
  // 关停是终态：一旦开始，不再接受任何调用，也不再启动浏览器。
  private stopping = false;
  private stopped: Promise<void> | undefined;
  // 还没有结果的 open 和 loginBegin：关停要等它们落定后才停实例。
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  open(p: OpenParams): Promise<OpenResult> {
    return this.track(() => this.openSession(p));
  }

  private async openSession(p: OpenParams): Promise<OpenResult> {
    const host = new URL(p.url).hostname;
    const mode = this.deps.modes.resolve(host);
    // M1 没有域名规则，到不了这里；到了就宁可拒绝，不开任何页面。
    if (mode !== 'default') throw new E2kError('internal', '这个版本只支持「默认」模式');
    const instance = await this.acquireInstance();
    if (this.stopping) throw stopping();

    const name = p.name ?? DEFAULT_NAME;
    const startedAt = this.deps.now();
    const nameDir = resolveInside(this.deps.home.runsDir, name);
    const id = this.drawSessionId(nameDir, startedAt);
    const dirName = runDirName(startedAt, id);
    this.reserved.set(id, dirName);
    try {
      ensurePrivateDir(this.deps.home.runsDir);
      ensurePrivateDir(nameDir);
      const runDir = resolveInside(nameDir, dirName);
      ensurePrivateDir(runDir);
      return await this.openPage(instance, p, { id, name, nameDir, dirName, runDir, startedAt, host, mode });
    } finally {
      this.reserved.delete(id);
    }
  }

  async step(p: StepParams): Promise<StepResult> {
    if (this.stopping) throw stopping();
    // 检查和置位之间没有 await：同一会话的两次 step 不会交错。
    const s = this.live(p.session);
    if (s.state !== 'idle') throw busy();
    s.state = 'stepping';
    this.pauseIdle(s);
    try {
      const results = await runOps(s.page, p.ops, { recorder: s.recorder, runDir: s.runDir, now: () => this.deps.now() },
        { keepGoing: p.keepGoing === true, aborted: () => s.gone });
      const tallies = tally(results);
      const wall = await loginWall(s.page, s.start.url);
      // 登录墙优先于不符和失败：人得先登录，别的结果之后再看。会话状态不变。
      return { session: s.id, results, tallies, exit: wall.blocked === 'login' ? 20 : exitFor(tallies), ...wall };
    } finally {
      // 执行期间会话可能已经被关停收尾，那就不再计时。
      if (s.state === 'stepping') {
        s.state = 'idle';
        this.restartIdle(s);
      }
    }
  }

  // step 在跑或已在收尾时都是 busy：不在操作进行到一半时关页、出报告。
  async close(p: CloseParams, closedBy: ClosedBy = 'agent'): Promise<CloseResult> {
    if (this.stopping) throw stopping();
    const s = this.live(p.session);
    if (s.state !== 'idle') throw busy();
    // 声明的「谁取代谁」在收尾之前对着记录校验：不合格就 usage，会话保持打开，可以改好再 close。
    resolveSuperseded(s.recorder.actions, p.superseded ?? []);
    return this.finish(s, closedBy, p);
  }

  list(): SessionInfo[] {
    const now = this.deps.now().getTime();
    return [...this.sessions.values()]
      .filter((s) => s.state === 'idle' || s.state === 'stepping')
      .map((s) => ({
        session: s.id,
        name: s.name,
        url: s.url,
        idleSec: s.state === 'stepping' ? 0 : Math.max(0, Math.floor((now - s.lastActive) / 1000)),
      }));
  }

  // 在 default profile 里开一个不属于任何会话的页让人登录（设计 5.5）。登录过程不套写策略，也不检查模式。
  loginBegin(p: { url: string }): Promise<{ loginId: string }> {
    return this.track(() => this.beginLogin(p));
  }

  private async beginLogin(p: { url: string }): Promise<{ loginId: string }> {
    const instance = await this.acquireInstance();
    if (this.stopping) throw stopping();
    let id = `l-${randomHex()}`;
    while (this.logins.has(id)) id = `l-${randomHex()}`;
    let login: Login | undefined;
    let host = '';
    try {
      host = hostOf(p.url);
    } catch {
      // 取不到主机不挡登录；登录记录写不出来时只记日志。
    }
    try {
      const page = await instance.openPage({});
      // 先登记再导航：登录页的首个请求就按登录页放行。关停已经开始的，登记后由下面的 catch 关页。
      login = { id, instance, host, pages: new Map([[page.id, page]]) };
      this.logins.set(id, login);
      if (this.stopping) throw stopping();
      await page.goto(p.url);
      if (this.stopping) throw stopping();
      return { loginId: id };
    } catch (e) {
      if (login !== undefined) await this.endLogin(login);
      if (this.stopping) throw stopping();
      if (e instanceof DriverError) throw new E2kError('action-failed', firstLine(e));
      throw e;
    }
  }

  // 关掉登录页和它弹出的窗口；登录态留在 user data 目录里。
  async loginEnd(p: { loginId: string }): Promise<Record<string, never>> {
    if (this.stopping) throw stopping();
    const login = this.logins.get(p.loginId);
    if (login === undefined) throw new E2kError('not-found', '没有这个登录');
    await this.endLogin(login);
    // 登录记录只用来给 doctor 和 status 看：写不了就记日志，不影响这次 login 结束。
    try {
      recordLogin(this.deps.home, DEFAULT_PROFILE, this.deps.now(), login.host);
    } catch (e) {
      this.logFailure(null, `写登录记录`, e);
    }
    return {};
  }

  instanceState(): 'stopped' | 'running' {
    return this.instance === undefined ? 'stopped' : 'running';
  }

  // 关停是终态，可以重复调用（返回同一个结果）。先等还在进行的 open、loginBegin 落定：它们看到关停后清理并拒绝，
  // 不会建成会话。再让所有会话出报告（kernel-shutdown，正在执行 step 的也收尾），关登录页，最后停实例。
  shutdown(): Promise<void> {
    this.stopping = true;
    this.stopped ??= this.drainAndStop();
    return this.stopped;
  }

  private async drainAndStop(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
    const pending: Promise<unknown>[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.state === 'closing') {
        if (s.finished !== undefined) pending.push(s.finished.catch(() => undefined));
        continue;
      }
      pending.push(this.finish(s, 'kernel-shutdown').catch((e: unknown) => { this.logFailure(s.id, '关停收尾', e); }));
    }
    await Promise.all(pending);
    for (const login of [...this.logins.values()]) await this.endLogin(login);
    if (this.acquiring !== undefined) await this.acquiring.catch(() => undefined);
    const inst = this.instance;
    // 先摘掉再停：stop() 触发的 onClosed 是自己引起的，不算浏览器没了。
    this.instance = undefined;
    if (inst !== undefined) await this.stopQuietly(inst);
  }

  // 记下还没有结果的调用，关停时等它们落定。
  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(stopping());
    const pr = run();
    this.inflight.add(pr);
    pr.then(() => { this.inflight.delete(pr); }, () => { this.inflight.delete(pr); });
    return pr;
  }

  // ---- 实例 ----

  // 冷启动串行化：正在启动（或正在检查健康）时再来的调用等同一个结果，不 launch 第二次。
  private acquireInstance(): Promise<Instance> {
    this.acquiring ??= this.ensureInstance().finally(() => { this.acquiring = undefined; });
    return this.acquiring;
  }

  private async ensureInstance(): Promise<Instance> {
    const current = this.instance;
    if (current !== undefined) {
      if (await this.healthy(current)) return current;
      this.instance = undefined;
      await this.stopQuietly(current);
    }
    if (this.stopping) throw stopping();
    const profileDir = resolveInside(this.deps.home.profilesDir, DEFAULT_PROFILE);
    ensurePrivateDir(this.deps.home.profilesDir);
    ensurePrivateDir(profileDir);
    const inst = await this.deps.driver.launch({ name: DEFAULT_PROFILE, userDataDir: profileDir });
    inst.setRequestHandler((r) => this.onRequest(r));
    inst.onRequestDone((e) => { this.onRequestDone(e); });
    inst.onPageOpened((page, openerId) => { this.onPageOpened(page, openerId); });
    inst.onClosed(() => { this.browserGone(inst); });
    this.instance = inst;
    return inst;
  }

  private async healthy(inst: Instance): Promise<boolean> {
    try {
      return (await inst.health()).ok;
    } catch (e) {
      this.logFailure(null, '实例健康检查', e);
      return false;
    }
  }

  private async stopQuietly(inst: Instance): Promise<void> {
    try {
      await inst.stop();
    } catch (e) {
      this.logFailure(null, '停实例', e);
    }
  }

  // ---- 会话 ----

  // s- 加 6 位随机十六进制；和在用的、正在开的会话撞了，或者报告目录已经存在，就重取。
  private drawSessionId(nameDir: string, at: Date): string {
    for (;;) {
      const id = `s-${randomBytes(3).toString('hex')}`;
      if (this.sessions.has(id) || this.reserved.has(id)) continue;
      if (taken(join(nameDir, runDirName(at, id)))) continue;
      return id;
    }
  }

  private async openPage(instance: Instance, p: OpenParams, o: { id: string; name: string; nameDir: string; dirName: string;
    runDir: string; startedAt: Date; host: string; mode: Mode }): Promise<OpenResult> {
    let page: Page | undefined;
    let registered = false;
    try {
      page = await instance.openPage({ ...(p.viewport === undefined ? {} : { viewport: p.viewport }), ...(p.touch === true ? { touch: true } : {}) });
      if (this.stopping) throw stopping();
      const s: Session = {
        id: o.id, name: o.name, nameDir: o.nameDir, dirName: o.dirName, runDir: o.runDir, startedAt: o.startedAt, instance,
        start: { url: p.url, viewport: p.viewport ?? null, touch: p.touch === true, profile: DEFAULT_PROFILE },
        page, pages: new Map([[page.id, page]]), recorder: new Recorder(),
        url: '', state: 'opening', gone: false, lastActive: 0, timer: undefined, finished: undefined,
      };
      // 先登记再导航：首屏的请求才归得到这个会话。
      this.sessions.set(s.id, s);
      registered = true;
      page.onClosed(() => { s.gone = true; void this.mainPageClosed(s); });
      s.recorder.addHost(o.host, o.mode);
      await page.goto(p.url);
      if (this.stopping) throw stopping();
      const snapshot = await page.snapshot({});
      if (this.stopping) throw stopping();
      const loc = await page.location();
      // 关停已经开始：不建成会话，由下面的 catch 清理并拒绝。
      if (this.stopping) throw stopping();
      const wall = await loginWall(page, p.url);
      if (this.stopping) throw stopping();
      s.url = safely(() => redactUrl(loc.url));
      s.state = 'idle';
      this.restartIdle(s);
      return {
        session: s.id, name: s.name, url: s.url, title: safely(() => redactText(loc.title)), mode: o.mode, runDir: s.runDir,
        snapshot: cappedSnapshot(snapshot), ...wall,
      };
    } catch (e) {
      // 先清理（关页、删空的报告目录、撤销登记），会话不建立；再把驱动的错误换成 action-failed，别的原样抛。
      if (page !== undefined) await this.closePageQuietly(o.id, page);
      try {
        rmdirSync(o.runDir);
      } catch (err) {
        this.logFailure(o.id, '删空的报告目录', err);
      }
      if (registered) this.sessions.delete(o.id);
      if (this.stopping) throw stopping();
      if (e instanceof DriverError) throw new E2kError('action-failed', firstLine(e));
      throw e;
    }
  }

  // 未知的、还没建成的、已经收尾完的会话一律 not-found。
  private live(id: string): Session {
    const s = this.sessions.get(id);
    if (s === undefined || s.state === 'opening') throw new E2kError('not-found', '没有这个会话');
    return s;
  }

  private finish(s: Session, closedBy: ClosedBy, p?: CloseParams): Promise<CloseResult> {
    s.state = 'closing';
    s.gone = true;
    this.pauseIdle(s);
    s.finished = this.wrapUp(s, closedBy, p);
    return s.finished;
  }

  // 收尾的每一步各自接住异常、记日志、继续往下（页面可能已经没了）。报告没写成时最后抛 internal。
  private async wrapUp(s: Session, closedBy: ClosedBy, p: CloseParams | undefined): Promise<CloseResult> {
    let webSockets = 0;
    try {
      webSockets = (await s.page.location()).webSockets;
    } catch (e) {
      this.logFailure(s.id, '读 WebSocket 数', e);
    }
    for (const page of s.pages.values()) {
      if (page !== null) await this.closePageQuietly(s.id, page);
    }
    const endedAt = this.deps.now();
    this.sessions.delete(s.id);

    let result: RunResult | undefined;
    let paths: { reportPath: string; resultPath: string } | undefined;
    try {
      result = buildResult({
        kernelVersion: this.deps.kernelVersion, session: s.id, name: s.name, startedAt: s.startedAt, endedAt, closedBy,
        start: s.start, driver: { name: this.deps.driver.name, capabilities: this.deps.driver.capabilities },
        actions: s.recorder.actions, writes: s.recorder.writes, unattributedWrites: this.unattributedDuring(s.startedAt, endedAt), hosts: s.recorder.hosts, webSockets,
        verdict: p?.verdict ?? null, findings: p?.findings ?? [], notDone: p?.notDone ?? [], superseded: p?.superseded ?? [],
      });
      paths = writeRun(s.runDir, result);
    } catch (e) {
      this.logFailure(s.id, '写报告', e);
    }
    try {
      pruneRuns(s.nameDir, this.deps.keepRuns, this.dirsInUse(s));
    } catch (e) {
      this.logFailure(s.id, '清理旧报告', e);
    }
    if (result === undefined || paths === undefined) throw new E2kError('internal', '报告没有写成，详见内核日志');
    return {
      session: s.id, runDir: s.runDir, ...paths, tallies: result.tallies, consistency: result.consistency, conflicts: result.conflicts,
      exit: result.tallies.mismatch > 0 ? 10 : 0,
    };
  }

  // 清理旧报告时不能删的目录：所有还在进行中的会话（含正在开的），以及刚收尾、要交给调用方的这一份。
  private dirsInUse(closing: Session): Set<string> {
    return new Set([closing.dirName, ...this.reserved.values(), ...[...this.sessions.values()].map((s) => s.dirName)]);
  }

  private async closePageQuietly(sessionId: string, page: Page): Promise<void> {
    try {
      await page.close();
    } catch (e) {
      this.logFailure(sessionId, '关页面', e);
    }
  }

  private unattributedDuring(from: Date, to: Date): WriteRecord[] {
    const [a, b] = [from.getTime(), to.getTime()];
    return this.unattributed.filter((w) => {
      const t = Date.parse(w.at);
      return t >= a && t <= b;
    }).map((w) => ({ ...w }));
  }

  // ---- 页面没了、浏览器没了 ----

  // 会话的主页面没了（不是会话自己在收尾）：实例不健康按浏览器没了处理，否则这个会话按 page-gone 出报告。
  // 浏览器没了时页面的监听器先触发、此时 health() 已经不 ok；健康检查要等，实例的事件可能先到，所以等完再看一次状态。
  private async mainPageClosed(s: Session): Promise<void> {
    if (!this.isActive(s)) return;
    const ok = await this.healthy(s.instance);
    if (!this.isActive(s)) return;
    if (!ok) {
      this.browserGone(s.instance);
      return;
    }
    this.finish(s, 'page-gone').catch((e: unknown) => { this.logFailure(s.id, '页面关闭后收尾', e); });
  }

  // 实例没了：被关、崩了，或者自己停掉的（停之前会话都已经在收尾，这里不会再出一份）。
  // 这个实例上还在用的会话各出一份 browser-gone 报告；它的登录页表清空。可以重入：已在收尾的会话跳过。
  private browserGone(inst: Instance): void {
    if (this.instance === inst) this.instance = undefined;
    for (const s of [...this.sessions.values()]) {
      if (s.instance !== inst || !this.isActive(s)) continue;
      this.finish(s, 'browser-gone').catch((e: unknown) => { this.logFailure(s.id, '浏览器关闭后收尾', e); });
    }
    for (const [id, login] of this.logins) {
      if (login.instance === inst) this.logins.delete(id);
    }
  }

  // 已建成、没在收尾、还登记着的会话。
  private isActive(s: Session): boolean {
    return this.sessions.get(s.id) === s && (s.state === 'idle' || s.state === 'stepping');
  }

  private async endLogin(login: Login): Promise<void> {
    this.logins.delete(login.id);
    for (const page of login.pages.values()) {
      if (page === null) continue;
      try {
        await page.close();
      } catch (e) {
        // 已经被人关掉的页再关会抛 DriverError，不算错。
        if (!(e instanceof DriverError)) this.logFailure(null, `登录 ${login.id} 关页面`, e);
      }
    }
  }

  // ---- 请求和新页面 ----

  private sessionOfPage(pageId: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.pages.has(pageId)) return s;
    return undefined;
  }

  private loginOfPage(pageId: string): Login | undefined {
    for (const l of this.logins.values()) if (l.pages.has(pageId)) return l;
    return undefined;
  }

  // 请求回调（写策略接在这里）。分三种：会话的页、登录页、其余。
  // 失败关闭：主机名解析不了、模式定不下来、策略抛错，一律中止这个请求，不放行。
  private onRequest(req: RequestInfo): Decision {
    try {
      return this.decideRequest(req);
    } catch (e) {
      this.logFailure(null, '处理请求', e);
      return { action: 'abort' };
    }
  }

  private decideRequest(req: RequestInfo): Decision {
    const { pageId, openerPageId } = req;
    let s = pageId === null ? undefined : this.sessionOfPage(pageId);
    let login = s !== undefined || pageId === null ? undefined : this.loginOfPage(pageId);
    // 页面还没认领、但开启者是会话或登录页的：这一页一并收过去（这时可能还没拿到页面对象，先记 id）。
    if (s === undefined && login === undefined && pageId !== null && openerPageId !== null) {
      s = this.sessionOfPage(openerPageId);
      if (s !== undefined) s.pages.set(pageId, null);
      else {
        login = this.loginOfPage(openerPageId);
        login?.pages.set(pageId, null);
      }
    }
    if (login !== undefined) return { action: 'continue' };       // 登录过程不套写策略，也不记录
    if (s !== undefined) {
      // topUrl 可能是 null（判断不出顶层页面），这时退回请求自己的地址。
      const topHost = hostOf(req.topUrl ?? req.url);
      const mode = this.deps.modes.resolve(topHost);
      const host = hostOf(req.url);
      const targetMode = this.deps.modes.resolve(host);
      // 这个版本只实现了「默认」模式（open 时也这样把关）：顶层页面或请求目标有一边不是默认模式，就中止，不交给策略。
      const decision: Decision = mode !== 'default' || targetMode !== 'default' ? { action: 'abort' } : this.deps.policy.decide(req, { mode, topHost });
      s.recorder.addRequest(req, decision, targetMode, this.deps.now());
      if (req.isNavigation && req.topFrame) s.recorder.addHost(host, targetMode);
      return decision;
    }
    // 归不到任何会话或登录页（pageId 为 null，或是人手开的标签页之类）。
    const decision = this.deps.policy.decideUnattributed(req);
    if (isWrite(req.method)) {
      this.unattributed.push(toWriteRecord(req, decision, this.deps.modes.resolve(hostOf(req.url)), this.deps.now()));
      if (this.unattributed.length > MAX_UNATTRIBUTED) this.unattributed.shift();
    }
    return decision;
  }

  private onRequestDone(e: { id: string; status: number | null; failed: boolean }): void {
    for (const s of this.sessions.values()) {
      if (s.recorder.completeRequest(e.id, e.status, e.failed)) return;
    }
    for (let i = this.unattributed.length - 1; i >= 0; i--) {
      const w = this.unattributed[i];
      if (w !== undefined && w.id === e.id) {
        w.status = e.status;
        w.failed = e.failed;
        return;
      }
    }
  }

  // 弹窗和新标签页：开启者属于会话就归这个会话（close 时一起关），属于登录页就收为登录页，否则不管。
  // 先前只凭请求记了 id 的页，这里补上对象。
  private onPageOpened(page: Page, openerId: string | null): void {
    let s = this.sessionOfPage(page.id);
    let login = s === undefined ? this.loginOfPage(page.id) : undefined;
    if (s === undefined && login === undefined && openerId !== null) {
      s = this.sessionOfPage(openerId);
      if (s === undefined) login = this.loginOfPage(openerId);
    }
    if (s !== undefined) {
      const owner = s;
      owner.pages.set(page.id, page);
      // 会话的弹窗被关，只把它从会话的页面表里去掉。
      page.onClosed(() => { owner.pages.delete(page.id); });
    } else if (login !== undefined) {
      login.pages.set(page.id, page);
    }
  }

  // ---- 闲置计时 ----

  private pauseIdle(s: Session): void {
    if (s.timer !== undefined) {
      clearTimeout(s.timer);
      s.timer = undefined;
    }
  }

  private restartIdle(s: Session): void {
    this.pauseIdle(s);
    s.lastActive = this.deps.now().getTime();
    s.timer = setTimeout(() => {
      s.timer = undefined;
      if (s.state !== 'idle' || this.sessions.get(s.id) !== s) return;
      // 定时器里的收尾是异步的：整体接住，不让未处理的拒绝带走内核进程。
      this.finish(s, 'idle-timeout').catch((e: unknown) => { this.logFailure(s.id, '闲置收尾', e); });
    }, this.deps.idleMs);
    // 闲置计时本身不让进程多活。
    s.timer.unref();
  }

  // ---- 日志 ----

  // 日志里的错误一律脱敏；写日志本身出错也不往外抛。
  private logFailure(sessionId: string | null, what: string, e: unknown): void {
    try {
      this.deps.log(`${sessionId === null ? '实例' : `会话 ${sessionId}`}：${what}失败：${errorText(e)}`);
    } catch {
      // 日志写不了也不能影响收尾。
    }
  }
}
