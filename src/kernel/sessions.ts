import { randomBytes } from 'node:crypto';
import { lstatSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DriverError } from '../driver/types.ts';
import type { Decision, Driver, Instance, Page } from '../driver/types.ts';
import { buildResult } from '../report/result.ts';
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
import { Recorder, safely } from './recorder.ts';
import type { WritePolicy } from './write-policy.ts';

// 会话管理（设计 5.2、5.5、5.6）：实例的懒启动和复用、会话的开、执行、收尾、闲置超时、关停。
// 「主机」一律指 URL.hostname（不带端口）。

export interface SessionDeps {
  driver: Driver; home: Home; modes: ModeResolver; policy: WritePolicy;
  idleMs: number; keepRuns: number; now(): Date; kernelVersion: string; log(line: string): void;
}

const DEFAULT_NAME = 'session';
const PROFILE = 'default';
const MAX_SNAPSHOT = 20_000;

// opening：页面已登记、首屏还没读完，对外当作不存在；closing：收尾中，再来的 step、close 都是 busy。
type State = 'opening' | 'idle' | 'stepping' | 'closing';

interface Session {
  readonly id: string;
  readonly name: string;
  readonly nameDir: string;
  readonly dirName: string;
  readonly runDir: string;
  readonly startedAt: Date;
  readonly start: { url: string; viewport: Viewport | null; profile: string };
  readonly page: Page;                       // 会话的主页面，操作只作用在它上面
  readonly pages: Map<string, Page | null>;  // 本会话的所有页（含弹窗）；只知道 id、还没拿到对象的记 null
  readonly recorder: Recorder;
  url: string;                               // 首屏读数里的地址（已脱敏），给 list()
  state: State;
  lastActive: number;
  timer: NodeJS.Timeout | undefined;
  finished: Promise<CloseResult> | undefined;
}

function busy(): E2kError {
  return new E2kError('busy', '会话正忙', '稍后重试');
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
  private instance: Instance | undefined;
  private acquiring: Promise<Instance> | undefined;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  async open(p: OpenParams): Promise<OpenResult> {
    const host = new URL(p.url).hostname;
    const mode = this.deps.modes.resolve(host);
    // M1 没有域名规则，到不了这里；到了就宁可拒绝，不开任何页面。
    if (mode !== 'default') throw new E2kError('internal', '这个版本只支持「默认」模式');
    const instance = await this.acquireInstance();

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
    // 检查和置位之间没有 await：同一会话的两次 step 不会交错。
    const s = this.live(p.session);
    if (s.state !== 'idle') throw busy();
    s.state = 'stepping';
    this.pauseIdle(s);
    try {
      const results = await runOps(s.page, p.ops, { recorder: s.recorder, runDir: s.runDir, now: () => this.deps.now() });
      const tallies = tally(results);
      return { session: s.id, results, tallies, exit: exitFor(tallies) };
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
    const s = this.live(p.session);
    if (s.state !== 'idle') throw busy();
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

  instanceState(): 'stopped' | 'running' {
    return this.instance === undefined ? 'stopped' : 'running';
  }

  // 所有会话出报告（kernel-shutdown），再停实例。正在执行 step 的会话也收尾：内核要退出了。
  async shutdown(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.state === 'opening') continue;           // 实例停掉后它的首屏会失败，由 open 自己清理
      if (s.state === 'closing') {
        if (s.finished !== undefined) pending.push(s.finished.catch(() => undefined));
        continue;
      }
      pending.push(this.finish(s, 'kernel-shutdown').catch((e: unknown) => { this.logFailure(s.id, '关停收尾', e); }));
    }
    await Promise.all(pending);
    if (this.acquiring !== undefined) await this.acquiring.catch(() => undefined);
    const inst = this.instance;
    // 先摘掉再停：stop() 触发的 onClosed 是自己引起的，不算浏览器没了。
    this.instance = undefined;
    if (inst !== undefined) await this.stopQuietly(inst);
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
    const profileDir = resolveInside(this.deps.home.profilesDir, PROFILE);
    ensurePrivateDir(this.deps.home.profilesDir);
    ensurePrivateDir(profileDir);
    const inst = await this.deps.driver.launch({ name: PROFILE, userDataDir: profileDir });
    // 15a 的占位：请求一律放行，和 M1 的 allowAllPolicy 结果相同。请求归属、写策略和记录在 15b 接上。
    inst.setRequestHandler((): Decision => ({ action: 'continue' }));
    // 自己摘掉或停掉的实例（this.instance 已经不是它）触发的 onClosed 不算数。
    inst.onClosed(() => {
      if (this.instance === inst) this.instance = undefined;
    });
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
      page = await instance.openPage(p.viewport === undefined ? {} : { viewport: p.viewport });
      const s: Session = {
        id: o.id, name: o.name, nameDir: o.nameDir, dirName: o.dirName, runDir: o.runDir, startedAt: o.startedAt,
        start: { url: p.url, viewport: p.viewport ?? null, profile: PROFILE },
        page, pages: new Map([[page.id, page]]), recorder: new Recorder(),
        url: '', state: 'opening', lastActive: 0, timer: undefined, finished: undefined,
      };
      // 先登记再导航：首屏的请求才归得到这个会话。
      this.sessions.set(s.id, s);
      registered = true;
      s.recorder.addHost(o.host, o.mode);
      await page.goto(p.url);
      const snapshot = await page.snapshot({});
      const loc = await page.location();
      s.url = safely(() => redactUrl(loc.url));
      s.state = 'idle';
      this.restartIdle(s);
      return {
        session: s.id, name: s.name, url: s.url, title: safely(() => redactText(loc.title)), mode: o.mode, runDir: s.runDir,
        snapshot: cappedSnapshot(snapshot),
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
        actions: s.recorder.actions, writes: s.recorder.writes, unattributedWrites: [], hosts: s.recorder.hosts, webSockets,
        verdict: p?.verdict ?? null, findings: p?.findings ?? [], notDone: p?.notDone ?? [],
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
      session: s.id, runDir: s.runDir, ...paths, tallies: result.tallies, consistency: result.consistency,
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
