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
import { tally } from '../shared/protocol.ts';
import type { CloseParams, CloseResult, Mode, OpenParams, OpenResult, SessionInfo, StepParams, StepResult }
  from '../shared/protocol.ts';
import { redactText, redactUrl, safely } from '../shared/redact.ts';
import { MAX_SNAPSHOT, exitFor, redactCap, runOps } from './executor.ts';
import { pendingError } from './approval.ts';
import type { Approvals, DialogRequest } from './approval.ts';
import type { ApprovalStore } from './approval-store.ts';
import type { ModeResolver } from './mode.ts';
import { DEFAULT_PROFILE, prepareProfileDir, recordLogin } from './profiles.ts';
import { Recorder, isWrite, toWriteRecord } from './recorder.ts';
import type { WriteRecord } from './recorder.ts';
import type { PolicyVerdict, WritePolicy } from './write-policy.ts';

// 会话管理（设计 5.2、5.5、5.6）：实例的懒启动和复用、会话的开、执行、收尾、闲置超时、关停。
// 「主机」一律指 URL.hostname（不带端口）。

export interface SessionDeps {
  driver: Driver; home: Home; modes: ModeResolver; policy: WritePolicy;
  store: ApprovalStore;   // 批准记录：放行声明、主机模式的批准存在这里（调用方在后面的任务里接上）
  idleMs: number; keepRuns: number; now(): Date; kernelVersion: string; log(line: string): void;
  approvals: Approvals;   // 待批表：弹框和结果都在这里（调用方在后面的任务里接上）
}

const DEFAULT_NAME = 'session';
const APPROVAL_TIMEOUT_SEC = 120;
const MAX_UNATTRIBUTED = 200;
// 同时在跑（含正在启动）的浏览器实例上限：每个 profile 一个实例，每个实例是一整个有头浏览器。
const MAX_INSTANCES = 4;

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
  readonly start: { url: string; viewport: Viewport | null; touch: boolean; profile: string };   // profile 存 key（`组` 或 `组@槽`）
  readonly page: Page;                       // 会话的主页面，操作只作用在它上面
  readonly pages: Map<string, Page | null>;  // 本会话的所有页（含弹窗）；只知道 id、还没拿到对象的记 null
  readonly recorder: Recorder;
  readonly forced: boolean;                  // open --readonly：不管规则，整场会话只读
  topHost: string;                           // 主页面已确认的顶层主机（URL.hostname）：模式跟着页面走，只在有「已提交」的证据时更新
  // 已放行、但还没有证据说明提交了的顶层导航目标（下载、204、没人看见的重定向都可能让导航根本没提交）：
  // 和 topHost 一起参与有效模式的计算，直到页面自己的请求或页面地址证明落在哪里。
  readonly pendingHosts: Set<string>;
  lastWall: 'login' | null;                  // 最近一次读到的登录墙状态（open 和每次 step 之后更新）
  url: string;                               // 首屏读数里的地址（已脱敏），给 list()
  state: State;
  gone: boolean;                             // 主页面已关或会话已在收尾：同步置位，step 的后续操作据此不再执行
  lastActive: number;
  timer: NodeJS.Timeout | undefined;
  finished: Promise<CloseResult> | undefined;
}

// 登录页（设计 5.5）：内核开的那一页，加上它弹出的窗口。这些页的请求不进任何会话记录；
// loginHosts 之外的写照只读规则拦（目标主机或请求所在页的顶层主机在 loginHosts 里的免拦）。
interface Login {
  readonly id: string;
  readonly instance: Instance;
  readonly profile: string;                  // 登录用的 profile（key）：人按回车结束时，登录记录记到它名下
  readonly host: string;                     // 起始地址的主机（URL.hostname），人按回车结束时记进登录记录
  readonly mode: Mode;                       // resolve(起始主机)：起点只读，登录里的写就都按只读
  readonly pages: Map<string, Page | null>;  // 只知道 id、还没拿到对象的记 null
  readonly places: Map<string, LoginPlace>;  // 每个登录页现在在哪个主机上（照会话的 topHost / pendingHosts 那套）
  blocked: number;                           // 登录期间被拦下的写（含放行后发现重定向被拒的）
  // 放行时带 followRedirects: false 的请求 id → 日志行，onRequestDone 发现重定向被拒时用它补记一条拦截。
  readonly requestIds: Map<string, string>;
}

// 登录页所在的主机：committed 是已提交的证据，pending 是放行了、但还不确定会不会提交的顶层导航目标。
interface LoginPlace { committed: string; readonly pending: Set<string> }

// 一个 profile 的实例槽：已在跑的实例，和正在启动（或正在检查健康）的那一次。两者都没有的槽要摘掉。
interface InstanceSlot { instance?: Instance; acquiring?: Promise<Instance> }

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

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

function cappedSnapshot(raw: string): string {
  return redactCap(raw, MAX_SNAPSHOT);
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
  // 每个 profile（key）一个浏览器实例，懒启动。
  private readonly slots = new Map<string, InstanceSlot>();
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

  // profile 是 profile key；协议里还没有选 profile 的参数，调用方都用 default（选 profile 是后面的任务）。
  private async openSession(p: OpenParams, profile: string = DEFAULT_PROFILE): Promise<OpenResult> {
    const host = new URL(p.url).hostname;
    // 规则先刷新一遍：文件有错就不开新会话（已开的会话按旧规则继续）。
    this.deps.modes.refresh();
    if (this.deps.modes.state().error !== null) throw new E2kError('usage', '规则文件有错，修好之前不能 open', 'e2k rule list 看错误');
    this.gateRules();
    const forced = p.readonly === true;
    const mode: Mode = forced ? 'readonly' : this.deps.modes.resolve(host);
    // 「denied」是 M3 的事，规则文件现在不收；到了这里也宁可拒绝，不开任何页面。
    if (mode === 'denied') throw new E2kError('internal', '这个版本还不支持「denied」模式');
    // 只读靠拦网络请求落实：驱动拦不了就不能开，不开页（失败关闭）。
    if (mode === 'readonly' && !this.deps.driver.capabilities.networkInterception) {
      throw new E2kError('internal', '这个驱动不能拦网络请求，不能以只读方式打开');
    }
    const instance = await this.acquireInstance(profile);
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
      return await this.openPage(instance, p, { id, name, nameDir, dirName, runDir, startedAt, host, mode, forced, profile });
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
      const blockedBefore = s.recorder.blockedEvents();
      const results = await runOps(s.page, p.ops, { recorder: s.recorder, runDir: s.runDir, now: () => this.deps.now() },
        { keepGoing: p.keepGoing === true, aborted: () => s.gone });
      // 口径：本批执行期间被拦下的本会话请求。执行结束之后才到的「重定向被拒」算进下一批；未归属的请求不算（它们不属于任何会话的记录）。
      const writesBlocked = s.recorder.blockedEvents() - blockedBefore;
      const tallies = tally(results);
      await this.syncTopHost(s);
      const wall = await loginWall(s.page, s.start.url);
      s.lastWall = wall.blocked;
      const notices: string[] = [];
      if (writesBlocked > 0) notices.push(`本批被拦 ${writesBlocked} 条写（只读模式），详见报告`);
      const rules = this.deps.modes.state();
      if (rules.error !== null) notices.push('规则文件有错：已开的会话按旧规则继续，新的 open 会被拒绝');
      if (rules.pending !== null) notices.push('规则文件有未批准的改动（收紧的部分已生效）');
      if (rules.approvalsChanged) notices.push('批准记录被内核以外的进程改过，已忽略');
      // 登录墙优先于不符和失败：人得先登录，别的结果之后再看。会话状态不变。退出码不受 notices 影响。
      return { session: s.id, results, tallies, exit: wall.blocked === 'login' ? 20 : exitFor(tallies), ...wall, writesBlocked, notices };
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

  // 入口闸门（设计 5.4）：规则文件有待批的改动时，新的 open 和 login 先过人工批准，含收紧、含删文件。
  // 收紧的部分在批准前已经按「更严合并」生效；这里只管放宽要不要放。批准的是内存里待批的那份（完整哈希），不重读磁盘。
  // 弹框在后台，这里同步返回：没批准就抛错，调用方等人点完再原样重试（重试靠内容键对上同一个框）。
  private gateRules(): void {
    const { modes, approvals } = this.deps;
    for (;;) {
      const pending = modes.pending();
      if (pending === null) return;
      const short = modes.state().pendingHash ?? '文件被删了';   // 对外只露短哈希
      // 键里有三样：已批准基线的完整哈希、待批的完整哈希。基线变了（别的批准落了盘）旧答案就对不上，
      // 所以没用掉的旧批准不会在新基线上直接生效（比如改回一份早先批准过的文本，必须重新问）。
      const key = `rules:${pending.baseHash ?? 'none'}:${pending.hash ?? 'deleted'}`;
      // 改动太多框里放不下：只给「拒绝」一个按钮，必然 denied，让人先看完整差异、拆开再改。
      const request: DialogRequest = pending.tooLong
        ? { title: 'e2k：域名规则改了', lines: [`规则文件改动太多，框里放不下（${short}）：`, '先运行 e2k rule diff 看完整差异，再拆成几次改。', '', '拒绝：继续按上一次批准的规则（收紧的部分已经先生效）'],
          buttons: ['拒绝'], defaultButton: '拒绝', timeoutSec: APPROVAL_TIMEOUT_SEC }
        : { title: 'e2k：域名规则改了', lines: [`规则文件有改动（${short}），批准后才生效：`, ...pending.summary, '', '拒绝：继续按上一次批准的规则（收紧的部分已经先生效）'],
          buttons: ['拒绝', '批准'], defaultButton: '拒绝', timeoutSec: APPROVAL_TIMEOUT_SEC };
      const asked = approvals.ask(key, 'rules', request, pending.tooLong ? [] : ['批准']);
      switch (asked.status) {
        case 'pending':
          throw pendingError(asked.id, '域名规则的改动');
        case 'denied':
          if (asked.cooling) throw new E2kError('usage', '刚被人拒过，过一会儿再试', '把 rules.json 改回去或改成别的再试；内核重启前同一份改动不会再问');
          if (pending.tooLong) {
            throw new E2kError('usage', '规则改动太多，框里放不下，没有批准；按上一次批准的规则，新的 open 和 login 也不开',
              '运行 e2k rule diff 看完整差异，再拆成几次改');
          }
          throw new E2kError('usage', '人拒绝了这次规则改动；按上一次批准的规则，新的 open 和 login 也不开',
            '把 rules.json 改回去或改成别的再试；内核重启前同一份改动不会再问');
        case 'unavailable':
          throw new E2kError('needs-human', `规则改了但弹不出批准框：${asked.why}`, '在有桌面的终端里起内核');
        case 'approved': {
          // 写盘失败时 approvePending 抛 needs-human，原样往上走；这里不接。
          const done = modes.approvePending(pending.hash);
          // 基线变了：这期间问过、批准了却没用掉的 rules: 答案一并作废（被拒的键保留）。
          approvals.forgetApproved((k) => k.startsWith('rules:'));
          // pending() 和 approvePending 之间没有 await，false 只能是内核自己的 bug；不放行。
          if (!done) throw new E2kError('internal', '待批的规则在批准时对不上');
          break;   // 回到循环顶：待批已清，返回
        }
      }
    }
  }

  // 在 default profile 里开一个不属于任何会话的页让人登录（设计 5.5）。登录窗口里 loginHosts 之外的写照只读规则拦。
  loginBegin(p: { url: string }): Promise<{ loginId: string }> {
    return this.track(() => this.beginLogin(p));
  }

  private async beginLogin(p: { url: string }, profile: string = DEFAULT_PROFILE): Promise<{ loginId: string }> {
    // 规则先刷新一遍：文件有错就不开登录页（和 open 一致）。
    this.deps.modes.refresh();
    if (this.deps.modes.state().error !== null) throw new E2kError('usage', '规则文件有错，修好之前不能 open', 'e2k rule list 看错误');
    this.gateRules();
    const instance = await this.acquireInstance(profile);
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
    // 取不到主机：resolve('') 会失败关闭成只读，登录里的写（loginHosts 之外）就都拦。
    const mode = this.deps.modes.resolve(host);
    try {
      const page = await instance.openPage({});
      // 先登记再导航：登录页的首个请求就按登录页放行。关停已经开始的，登记后由下面的 catch 关页。
      login = { id, instance, profile, host, mode, pages: new Map([[page.id, page]]), places: new Map([[page.id, { committed: host, pending: new Set() }]]), blocked: 0, requestIds: new Map() };
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
  async loginEnd(p: { loginId: string }): Promise<{ writesBlocked: number }> {
    if (this.stopping) throw stopping();
    const login = this.logins.get(p.loginId);
    if (login === undefined) throw new E2kError('not-found', '没有这个登录');
    await this.endLogin(login);
    // 登录记录只用来给 doctor 和 status 看：写不了就记日志，不影响这次 login 结束。
    try {
      recordLogin(this.deps.home, login.profile, this.deps.now(), login.host);
    } catch (e) {
      this.logFailure(null, `写登录记录`, e);
    }
    return { writesBlocked: login.blocked };
  }

  // 任一实例在跑就是 running。
  instanceState(): 'stopped' | 'running' {
    return [...this.slots.values()].some((x) => x.instance !== undefined) ? 'running' : 'stopped';
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
    // 还在启动的实例等它落定，再把所有实例一起停。
    for (const x of [...this.slots.values()]) if (x.acquiring !== undefined) await x.acquiring.catch(() => undefined);
    const live = [...this.slots.values()].flatMap((x) => (x.instance === undefined ? [] : [x.instance]));
    // 先摘掉再停：stop() 触发的 onClosed 是自己引起的，不算浏览器没了。
    this.slots.clear();
    await Promise.all(live.map((inst) => this.stopQuietly(inst)));
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

  // 每个 profile 一个实例，按 key 懒启动。冷启动串行化：同一个 key 正在启动（或正在检查健康）时再来的调用等同一个结果，
  // 不 launch 第二次。同时在跑（含正在启动）的实例最多 MAX_INSTANCES 个，要启动第 5 个就 busy。上限在这里同步判断，
  // 所以并发的几个新 key 不会一起越过它。
  private acquireInstance(key: string): Promise<Instance> {
    const slot = this.slots.get(key) ?? {};
    if (slot.acquiring !== undefined) return slot.acquiring;
    if (slot.instance === undefined) {
      let others = 0;
      for (const [k, x] of this.slots) if (k !== key && (x.instance !== undefined || x.acquiring !== undefined)) others++;
      if (others >= MAX_INSTANCES) {
        return Promise.reject(new E2kError('busy', '同时开着的 profile 太多，先关掉一些会话', '关掉一些会话，等它们的浏览器停了再开新的 profile'));
      }
    }
    this.slots.set(key, slot);
    slot.acquiring = this.ensureInstance(key, slot).finally(() => {
      slot.acquiring = undefined;
      this.dropIfEmpty(key, slot);
    });
    return slot.acquiring;
  }

  // 槽里没有实例也没有正在启动的：摘掉，不让空槽占着表（上限只数有实例或正在启动的，这里是清理）。
  private dropIfEmpty(key: string, slot: InstanceSlot): void {
    if (slot.instance === undefined && slot.acquiring === undefined && this.slots.get(key) === slot) this.slots.delete(key);
  }

  private async ensureInstance(key: string, slot: InstanceSlot): Promise<Instance> {
    const current = slot.instance;
    if (current !== undefined) {
      if (await this.healthy(current)) return current;
      slot.instance = undefined;
      await this.stopQuietly(current);
    }
    if (this.stopping) throw stopping();
    // 名字、目录类型、权限、不逃出 profiles 的检查都在启动之前：不对就不启动浏览器。
    const profileDir = prepareProfileDir(this.deps.home, key);
    const inst = await this.deps.driver.launch({ name: key, userDataDir: profileDir });
    // 回调都挂在这个实例上：别的实例的事不会走到这里，这个实例的事也不会碰别的实例的会话。
    inst.setRequestHandler((r) => this.onRequest(r));
    inst.onRequestDone((e) => { this.onRequestDone(e); });
    inst.onPageOpened((page, openerId) => { this.onPageOpened(page, openerId); });
    inst.onClosed(() => { this.browserGone(inst); });
    slot.instance = inst;
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
    runDir: string; startedAt: Date; host: string; mode: Mode; forced: boolean; profile: string }): Promise<OpenResult> {
    let page: Page | undefined;
    let registered = false;
    try {
      page = await instance.openPage({ ...(p.viewport === undefined ? {} : { viewport: p.viewport }), ...(p.touch === true ? { touch: true } : {}) });
      if (this.stopping) throw stopping();
      const s: Session = {
        id: o.id, name: o.name, nameDir: o.nameDir, dirName: o.dirName, runDir: o.runDir, startedAt: o.startedAt, instance,
        start: { url: p.url, viewport: p.viewport ?? null, touch: p.touch === true, profile: o.profile },
        page, pages: new Map([[page.id, page]]), recorder: new Recorder(), forced: o.forced, topHost: o.host, pendingHosts: new Set(), lastWall: null,
        url: '', state: 'opening', gone: false, lastActive: 0, timer: undefined, finished: undefined,
      };
      // 先登记再导航：首屏的请求才归得到这个会话。
      this.sessions.set(s.id, s);
      registered = true;
      page.onClosed(() => { s.gone = true; void this.mainPageClosed(s); });
      s.recorder.addHost(o.host, o.mode);
      this.recordMode(s);
      await page.goto(p.url);
      if (this.stopping) throw stopping();
      const snapshot = await page.snapshot({});
      if (this.stopping) throw stopping();
      const loc = await page.location();
      // 关停已经开始：不建成会话，由下面的 catch 清理并拒绝。
      if (this.stopping) throw stopping();
      this.followTopHost(s, loc.url);
      const wall = await loginWall(page, p.url);
      if (this.stopping) throw stopping();
      s.lastWall = wall.blocked;
      s.url = safely(() => redactUrl(loc.url));
      s.state = 'idle';
      this.restartIdle(s);
      return {
        session: s.id, name: s.name, url: s.url, title: safely(() => redactText(loc.title)), mode: this.sessionMode(s, []), runDir: s.runDir,
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
        modes: s.recorder.modes, rules: this.rulesInForce(), blocked: s.lastWall, forced: s.forced,
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

  // 收尾时生效的规则：hash、count 是已批准的快照（规则文件有错时也不变）；pendingHash 是同时按「更严合并」生效的待批文件。
  private rulesInForce(): { hash: string | null; count: number; pendingHash: string | null } {
    const { hash, count, pendingHash } = this.deps.modes.state();
    return { hash, count, pendingHash };
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
  // 只收尾这个实例上还在用的会话（各出一份 browser-gone 报告）和它的登录页；别的实例不受影响。可以重入：已在收尾的会话跳过。
  private browserGone(inst: Instance): void {
    for (const [key, x] of this.slots) {
      if (x.instance !== inst) continue;
      x.instance = undefined;
      this.dropIfEmpty(key, x);
    }
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
    if (login !== undefined) return this.decideForLogin(login, req);
    if (s !== undefined) return this.decideForSession(s, req);
    // 归不到任何会话或登录页（pageId 为 null，或是人手开的标签页之类）：有任一只读会话活着就按「只读」拦写。
    // 请求所在页自己的顶层主机只读也算（模式跟着页面走），不用等有只读会话。
    const anyReadonly = [...this.sessions.values()].some((x) => this.sessionMode(x, []) === 'readonly')
      || this.deps.modes.resolve(hostOf(req.topUrl ?? req.url)) === 'readonly';
    const verdict = this.deps.policy.decideUnattributed(req, { anyReadonly });
    if (isWrite(req.method) || verdict.reason !== null) {
      const targetMode = this.deps.modes.resolve(hostOf(req.url));
      this.unattributed.push(toWriteRecord(req, verdict, { mode: anyReadonly ? 'readonly' : 'default', targetMode }, this.deps.now()));
      if (this.unattributed.length > MAX_UNATTRIBUTED) this.unattributed.shift();
    }
    return verdict.decision;
  }

  // 登录页（和它弹出的窗口）的请求：不进任何记录。免拦两种：请求目标主机是 loginHost；或是顶层导航（SAML POST 绑定、
  // OIDC form_post 回调），而发起它的页停在（或待定在）loginHost 上。真驱动给顶层导航的 topUrl 是导航目标，所以「发起页在哪」
  // 得自己跟：place 记着已提交的主机和待定的主机。loginHost 页上的 fetch/XHR 去别的主机不免拦，照只读规则判。
  // 其余请求的有效模式：登录起点、页面已提交和待定的主机、请求自己的顶层主机，任一只读就按只读。
  private decideForLogin(login: Login, req: RequestInfo): Decision {
    const { modes } = this.deps;
    const topHost = hostOf(req.topUrl ?? req.url);
    const place = this.loginPlace(login, req.pageId, req.openerPageId);
    const isNav = req.isNavigation && req.topFrame;
    // 顶层导航带着发起页已提交的地址（initiatorUrl）：这是页面在哪的直接证据（经重定向进入、又没发过子资源的页面也靠它），
    // 先据此定下发起页的主机，再判断；没有就用跟踪到的 committed/pending。
    if (isNav && req.initiatorUrl !== null) {
      place.committed = hostOf(req.initiatorUrl);
      place.pending.clear();
    }
    const exempt = modes.isLoginHost(hostOf(req.url), 'default')
      || (isNav && [place.committed, ...place.pending].some((h) => modes.isLoginHost(h, 'default')));
    let decision: Decision;
    if (exempt) decision = { action: 'continue' };
    else {
      const all = [login.mode, ...[place.committed, ...place.pending, topHost].map((h) => modes.resolve(h))];
      const mode: Mode = all.includes('readonly') ? 'readonly' : all.includes('denied') ? 'denied' : 'default';
      const verdict = this.deps.policy.decide(req, { mode });
      decision = verdict.decision;
      const method = KNOWN_METHODS.has(req.method.toUpperCase()) ? req.method.toUpperCase() : 'OTHER';
      const line = `登录 ${login.id}：拦下 ${method} ${safely(() => redactText(hostOf(req.url)))}`;
      if (verdict.reason !== null) {
        login.blocked++;
        this.logLine(line);
      } else if (decision.action === 'continue' && decision.followRedirects === false) {
        login.requestIds.set(req.id, line);
      }
    }
    // 判定之后才动主机：放行的顶层导航记成待定；非导航请求带着的顶层地址是「已提交」的证据，主机据此确定下来。
    if (isNav) {
      if (decision.action === 'continue') place.pending.add(topHost);
    } else if (req.topUrl !== null) {
      place.pending.clear();
      place.committed = topHost;
    }
    return decision;
  }

  // 登录页的位置表：没有就建。弹窗在拿到自己的证据之前，按开启者已提交的主机算；开启者也不认识就退回登录起点。
  private loginPlace(login: Login, pageId: string | null, openerId: string | null): LoginPlace {
    const key = pageId ?? '';
    let place = login.places.get(key);
    if (place === undefined) {
      place = { committed: (openerId === null ? undefined : login.places.get(openerId)?.committed) ?? login.host, pending: new Set() };
      login.places.set(key, place);
    }
    return place;
  }

  // 会话页（主页面、弹窗）的请求。模式跟着页面走（设计 5.2）：有效模式 = 会话主页面的顶层主机和请求所在页的顶层主机取并，
  // 任何一边只读就按只读；默认模式的页面发往只读主机的写照旧放行，只记录（targetMode）。
  private decideForSession(s: Session, req: RequestInfo): Decision {
    // topUrl 可能是 null（判断不出顶层页面），这时退回请求自己的地址。
    const topHost = hostOf(req.topUrl ?? req.url);
    const isMain = req.pageId === s.page.id;
    const mainNav = isMain && req.isNavigation && req.topFrame;
    // 主页面的顶层导航：规则可能刚被人改过，先刷新。导航前的主机（s.topHost）和目标一起算，所以只读页跨主机的表单 POST 也拦得住。
    if (mainNav) this.deps.modes.refresh();
    // 发起页已提交的地址是主页面在哪的直接证据：先据此定下 topHost（待定的丢掉），再算模式。
    if (mainNav && req.initiatorUrl !== null) this.converge(s, hostOf(req.initiatorUrl));
    const mode = this.sessionMode(s, [topHost]);
    const host = hostOf(req.url);
    const targetMode = this.deps.modes.resolve(host);
    const verdict: PolicyVerdict = this.deps.policy.decide(req, { mode });
    s.recorder.addRequest(req, verdict, { mode, targetMode }, this.deps.now());
    if (req.isNavigation && req.topFrame) s.recorder.addHost(host, targetMode);
    // 判定之后才动主机。放行的顶层导航只记成待定（不确定它会不会提交）；主页面的其他请求带着的顶层地址是「已提交」的证据，
    // 主机据此确定下来（重定向落地也在这里跟上）。被拦的导航什么都不改。
    if (mainNav) {
      if (verdict.decision.action === 'continue') s.pendingHosts.add(topHost);
    } else if (isMain && req.topUrl !== null) this.converge(s, topHost);
    return verdict.decision;
  }

  // 会话的有效模式：被 --readonly 强制，或 [主页面顶层主机, ...extraHosts] 里任一只读 → readonly；任一 denied → denied；否则 default。
  private sessionMode(s: Session, extraHosts: string[]): Mode {
    if (s.forced) return 'readonly';
    const modes = [s.topHost, ...s.pendingHosts, ...extraHosts].map((h) => this.deps.modes.resolve(h));
    if (modes.includes('readonly')) return 'readonly';
    if (modes.includes('denied')) return 'denied';
    return 'default';
  }

  // 记一条模式变更（和上一条同模式的由 Recorder 去重）：reason 看这个主机有没有命中规则。
  private recordMode(s: Session): void {
    const { modes } = this.deps;
    const { hash, pendingHash } = modes.state();
    s.recorder.noteMode({
      at: this.deps.now().toISOString(), host: s.topHost, mode: this.sessionMode(s, []),
      reason: s.forced ? 'forced' : modes.ruleFor(s.topHost) === null ? 'no-rule' : 'rule', rulesHash: hash, pendingRulesHash: pendingHash,
    });
  }

  // 有「已提交」的证据：主机定为 host，待定的丢掉；模式变了才进时间线（Recorder 去重）。
  private converge(s: Session, host: string): void {
    s.pendingHosts.clear();
    s.topHost = host;
    this.recordMode(s);
  }

  // 用主页面的实际地址确定顶层主机（页面地址是已提交的证据）；不是 http(s) 地址（about:blank、浏览器的错误页）就什么都不动，沿用上一个主机和待定的主机。
  private followTopHost(s: Session, url: string): void {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') this.converge(s, u.hostname);
    } catch {
      // 地址解析不了：沿用上一个主机。
    }
  }

  private async syncTopHost(s: Session): Promise<void> {
    try {
      this.followTopHost(s, (await s.page.location()).url);
    } catch (e) {
      // 页面已经没了或驱动查不出：不更新，沿用上一个主机。
      if (!(e instanceof DriverError)) throw e;
    }
  }

  private onRequestDone(e: { id: string; status: number | null; failed: boolean; redirectRefused?: true }): void {
    for (const s of this.sessions.values()) {
      if (s.recorder.completeRequest(e.id, e.status, e.failed, e.redirectRefused)) return;
    }
    for (const login of this.logins.values()) {
      const line = login.requestIds.get(e.id);
      if (line === undefined) continue;
      login.requestIds.delete(e.id);
      // 登录页放行的严格查询在首跳 3xx 被驱动中止：那条写没有跟过去，算被拦下的。
      if (e.redirectRefused === true) {
        login.blocked++;
        this.logLine(line);
      }
      return;
    }
    for (let i = this.unattributed.length - 1; i >= 0; i--) {
      const w = this.unattributed[i];
      if (w !== undefined && w.id === e.id) {
        w.status = e.status;
        w.failed = e.failed;
        // 驱动在首跳 3xx 时中止了重定向：那条写其实没有跟过去，改记成被拦的 redirected-write（和会话里的记录一致）。
        if (e.redirectRefused === true && w.decision !== 'blocked') {
          w.decision = 'blocked';
          w.reason = 'redirected-write';
        }
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
      this.loginPlace(login, page.id, openerId);
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

  // 写一行内核日志；写日志本身出错也不往外抛。
  private logLine(line: string): void {
    try {
      this.deps.log(line);
    } catch {
      // 日志写不了也不能影响请求判定。
    }
  }

  // 日志里的错误一律脱敏；写日志本身出错也不往外抛。
  private logFailure(sessionId: string | null, what: string, e: unknown): void {
    try {
      this.deps.log(`${sessionId === null ? '实例' : `会话 ${sessionId}`}：${what}失败：${errorText(e)}`);
    } catch {
      // 日志写不了也不能影响收尾。
    }
  }
}
