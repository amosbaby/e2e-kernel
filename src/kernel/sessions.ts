import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DriverError } from '../driver/types.ts';
import type { Decision, Driver, Instance, Page, RequestInfo } from '../driver/types.ts';
import { buildResult, resolveSuperseded } from '../report/result.ts';
import type { ClosedBy, DeclarationRecord, RunResult } from '../report/result.ts';
import { pruneRuns, runDirName, writeRun } from '../report/store.ts';
import { E2kError } from '../shared/errors.ts';
import type { Viewport } from '../shared/ops.ts';
import { ensurePrivateDir, resolveInside } from '../shared/paths.ts';
import type { Home } from '../shared/paths.ts';
import { tally } from '../shared/protocol.ts';
import type { CloseParams, CloseResult, LoginBeginParams, Mode, OpenParams, OpenResult, SessionInfo, StepParams, StepResult }
  from '../shared/protocol.ts';
import { redactText, redactUrl, safely } from '../shared/redact.ts';
import { MAX_SNAPSHOT, exitFor, redactCap, runOps } from './executor.ts';
import { pendingError } from './approval.ts';
import type { Approvals, DialogRequest } from './approval.ts';
import type { ApprovalStore, Declaration } from './approval-store.ts';
import { declarationKey, normalizeDeclarations, sameDeclaration } from './declarations.ts';
import type { ModeResolver } from './mode.ts';
import { checkProfileKey, parseProfileArg, prepareProfileDir, profileKey, recordLogin } from './profiles.ts';
import type { ProfileRef } from './profiles.ts';
import { Recorder, isWrite, toWriteRecord } from './recorder.ts';
import type { WriteRecord } from './recorder.ts';
import { DEFAULT_GROUP_NAME, normalizeHost } from './rules.ts';
import { blockFrozen, blockOtherGroup, otherGroupMessage } from './write-policy.ts';
import type { PolicyCtx, PolicyVerdict, WritePolicy } from './write-policy.ts';

// 会话管理（设计 5.2、5.5、5.6）：实例的懒启动和复用、会话的开、执行、收尾、闲置超时、关停。
// 「主机」一律指 URL.hostname（不带端口）。

export interface SessionDeps {
  driver: Driver; home: Home; modes: ModeResolver; policy: WritePolicy;
  store: ApprovalStore;   // 批准记录：放行声明、主机模式的批准存在这里（调用方在后面的任务里接上）
  idleMs: number; keepRuns: number; now(): Date; kernelVersion: string; log(line: string): void;
  approvals: Approvals;   // 待批表：弹框和结果都在这里（调用方在后面的任务里接上）
  identityProbeMs?: number;   // 身份探针整体的时限（毫秒），缺省 IDENTITY_PROBE_MS；超时按不符处理。测试用来把「永远不落定」缩短
}

const DEFAULT_NAME = 'session';
const APPROVAL_TIMEOUT_SEC = 120;
const MAX_UNATTRIBUTED = 200;
// 身份探针（location、密码框检查、count、text 四次页面读取）整体的时限：驱动的 read / text 没有不等待的开关，页面卡住时不能让 step 一直占着会话。
const IDENTITY_PROBE_MS = 5000;
// 同时在跑（含正在启动）的浏览器实例上限：每个 profile 一个实例，每个实例是一整个有头浏览器。
const MAX_INSTANCES = 4;

// 冻结（设计 5.2）：会话（或登录页）经重定向进了别的组的域名之后，它所有页的所有请求（含 GET）一律 403，step 不再执行。
// group 是第一次跨进去的那个组，判断不出归属时是 null（失败关闭：判断出错也冻结）；hosts 是跨进去的各跳主机（收尾时再清一次 cookie）；
// clearing 是还没完成的 clearCookies，step 抛错和收尾前等它们落定。
interface Freeze { readonly group: string | null; readonly hosts: Set<string>; readonly clearing: Set<Promise<void>> }

// 被拦下的跨组导航的地址（去掉 #）：这些页面停在内核自己回的 403 页上，页面地址在别的组的域名上，但不是重定向带进去的，
// 不能因为它冻结会话。只留最近 MAX_REFUSED 个。
const MAX_REFUSED = 100;

function withoutHash(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

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
  readonly start: { url: string; viewport: Viewport | null; touch: boolean; profile: string; borrowed: boolean };   // profile 存 key（`组` 或 `组@槽`）
  // profile 的组名（只存名字，不存 modes.group() 返回的缓存对象：规则刷新、被批准的改动都不会改写它）。
  readonly group: string;
  // 跨组导航被拦的次数，和还没在 step 的 notices 里提示过的提示句（去重）。
  crossCount: number;
  readonly crossNotices: Set<string>;
  readonly refused: Set<string>;             // 被拦下的跨组导航的地址（去掉 #），见 MAX_REFUSED
  frozen: Freeze | null;                     // 经重定向进了别的组的域名：整个会话冻结
  readonly page: Page;                       // 会话的主页面，操作只作用在它上面
  readonly pages: Map<string, Page | null>;  // 本会话的所有页（含弹窗）；只知道 id、还没拿到对象的记 null
  readonly recorder: Recorder;
  readonly forced: boolean;                  // open --readonly：不管规则，整场会话只读
  topHost: string;                           // 主页面已确认的顶层主机（URL.hostname）：模式跟着页面走，只在有「已提交」的证据时更新
  // 已放行、但还没有证据说明提交了的顶层导航目标（下载、204、没人看见的重定向都可能让导航根本没提交）：
  // 和 topHost 一起参与有效模式的计算，直到页面自己的请求或页面地址证明落在哪里。
  readonly pendingHosts: Set<string>;
  // 本会话提过且已批准的放行声明（只增不减）。判定时才和批准记录里当前的内容、会话当前的组和页面主机核对（declaredFor）。
  readonly declared: DeclaredEntry[];
  lastWall: 'login' | null;                  // 最近一次读到的登录墙状态（open 和每次 step 之后更新）
  // 身份探针（设计 5.2）：只探主页面。configured：探的时候组配了身份（报告里 identity 是不是 null 看它）；
  // checks / skipped：做了比较的次数 / 前提不满足跳过的次数；mismatch：一旦记下永久生效，直到 close（记的是当时的组和期望文字，不含页面文字）。
  identityConfigured: boolean;
  identityChecks: number;
  identitySkipped: number;
  identityMismatch: { readonly group: string; readonly expect: string } | null;
  url: string;                               // 首屏读数里的地址（已脱敏），给 list()
  state: State;
  gone: boolean;                             // 主页面已关或会话已在收尾：同步置位，step 的后续操作据此不再执行
  lastActive: number;
  timer: NodeJS.Timeout | undefined;
  finished: Promise<CloseResult> | undefined;
}

// scope：批准是在哪个组、哪个页面主机上给的（`组/主机`；主机名里不会有 `/`，也不会撞上 `constructor` 一类原型上的名字）。
interface DeclaredEntry { readonly scope: string; readonly decl: Declaration; readonly approved: DeclarationRecord['approved'] }

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// 登录页（设计 5.5）：内核开的那一页，加上它弹出的窗口。这些页的请求不进任何会话记录；
// loginHosts 之外的写照只读规则拦（目标主机或请求所在页的顶层主机在 loginHosts 里的免拦）。
interface Login {
  readonly id: string;
  readonly instance: Instance;
  readonly profile: string;                  // 登录用的 profile（key）：人按回车结束时，登录记录记到它名下
  readonly group: string;                    // profile 的组名（只存名字）：loginHosts 按它查，跨组导航拦的也是它
  readonly host: string;                     // 起始地址的主机（URL.hostname），人按回车结束时记进登录记录
  readonly mode: Mode;                       // resolve(起始主机)：起点只读，登录里的写就都按只读
  readonly pages: Map<string, Page | null>;  // 只知道 id、还没拿到对象的记 null
  readonly places: Map<string, LoginPlace>;  // 每个登录页现在在哪个主机上（照会话的 topHost / pendingHosts 那套）
  blocked: number;                           // 登录期间被拦下的写（含放行后发现重定向被拒的），其中含跨组导航
  crossBlocked: number;                      // 其中跨组导航被拦的次数（不是只读规则拦的）；冻结之后拦下的请求也计在这里
  frozen: Freeze | null;                     // 经重定向进了别的组的域名：此后登录页的所有请求都拦
  readonly refused: Set<string>;             // 被拦下的跨组导航的地址（去掉 #），同会话的 refused
  // 放行时带 followRedirects: false 的请求 id → 日志行，onRequestDone 发现重定向被拒时用它补记一条拦截。
  readonly requestIds: Map<string, string>;
}

// 登录页所在的主机：committed 是已提交的证据，pending 是放行了、但还不确定会不会提交的顶层导航目标。
interface LoginPlace { committed: string; readonly pending: Set<string> }

// 一个 profile 的实例槽：已在跑的实例，和正在启动（或正在检查健康）的那一次。两者都没有的槽要摘掉。
// pins：正在开会话、开登录页的调用（从抢实例到登记完或失败），期间这个实例不算空闲；lastUsed：最近一次有人用完它的序号（单调增）。
// reclaiming：空闲实例正在被停掉（还占着名额，直到停完）；after：这个槽要等它落定才能启动（新 key 等被回收的实例停完）。
interface InstanceSlot {
  instance?: Instance; acquiring?: Promise<Instance>; reclaiming?: Promise<void>; after?: Promise<void>;
  pins: number; lastUsed: number;
}

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function busy(): E2kError {
  return new E2kError('busy', '会话正忙', '稍后重试');
}

// 消息里只有组名和规则里写的期望文字，不含页面上读到的任何内容。
const IDENTITY_NEXT = '账号或租户可能被别的会话切走了；请人确认后关掉这个会话重开';
function identityMismatchError(m: { group: string; expect: string }): E2kError {
  return new E2kError('needs-human', `身份探针不符：组 ${m.group} 期望「${m.expect}」，页面上不是`, IDENTITY_NEXT);
}

// 冻结的会话 step 不执行：要人关掉它，用目标组的 profile 另开。group 为 null 是判断不出归属（失败关闭）。
function frozenError(f: Freeze): E2kError {
  return f.group === null
    ? new E2kError('needs-human', '页面经重定向去了判断不出归属的域名，会话已冻结', '关掉这个会话，重新开')
    : new E2kError('needs-human', `页面经重定向进了组 ${f.group} 的域名，会话已冻结`, `关掉这个会话，用 --profile ${f.group} 另开`);
}

function frozenNow(s: Session): Freeze | null {
  return s.frozen;
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
  // 被人拒绝过的放行声明集合（不含会话名，所以换个会话也不重新弹框）；键 = sha256(组、页面主机、声明集合)，内核重启前一直有效。
  // askedWrites：这个集合问过的待批表键（带会话名）。拒绝是人在框里点的，不等原会话重试：每次问之前先看问过的框有没有被拒，被拒了就记进 deniedWrites。
  private readonly deniedWrites = new Set<string>();
  private readonly askedWrites = new Map<string, Set<string>>();
  private hopSeq = 0;   // 冻结时造的导航记录的编号
  private useClock = 0;   // 给 lastUsed 用的单调序号：比时间戳稳，同一毫秒里的先后也分得清
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
    // profile 参数的写法先查（不对就 usage）：要在 gateRules 之前，不能为一个写错的参数弹规则批准框。
    const arg = p.profile === undefined ? null : parseProfileArg(p.profile);
    const host = new URL(p.url).hostname;
    // 规则先刷新一遍：文件有错就不开新会话（已开的会话按旧规则继续）。
    this.deps.modes.refresh();
    if (this.deps.modes.state().error !== null) throw new E2kError('usage', '规则文件有错，修好之前不能 open', 'e2k rule list 看错误');
    this.gateRules();
    const { ref, borrowed } = this.pickProfile(host, arg);
    const profile = profileKey(ref);
    const forced = p.readonly === true;
    const mode: Mode = forced ? 'readonly' : this.deps.modes.resolve(host);
    // 「denied」是 M3 的事，规则文件现在不收；到了这里也宁可拒绝，不开任何页面。
    if (mode === 'denied') throw new E2kError('internal', '这个版本还不支持「denied」模式');
    // 只读靠拦网络请求落实：驱动拦不了就不能开，不开页（失败关闭）。
    if (mode === 'readonly' && !this.deps.driver.capabilities.networkInterception) {
      throw new E2kError('internal', '这个驱动不能拦网络请求，不能以只读方式打开');
    }
    const slot = this.pin(profile);
    try {
      return await this.openOn(await this.acquireInstance(profile, slot), p, { host, mode, forced, profile, group: ref.group, borrowed });
    } finally {
      this.unpin(slot);
    }
  }

  private async openOn(instance: Instance, p: OpenParams, o: { host: string; mode: Mode; forced: boolean; profile: string; group: string; borrowed: boolean }): Promise<OpenResult> {
    const { host, mode, forced, profile, group, borrowed } = o;
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
      return await this.openPage(instance, p, { id, name, nameDir, dirName, runDir, startedAt, host, mode, forced, profile, group, borrowed });
    } finally {
      this.reserved.delete(id);
    }
  }

  async step(p: StepParams): Promise<StepResult> {
    if (this.stopping) throw stopping();
    // 检查和置位之间没有 await：同一会话的两次 step 不会交错。
    const s = this.live(p.session);
    if (s.state !== 'idle') throw busy();
    if (s.frozen !== null) {   // 冻结的会话不执行任何操作；清 cookie 还没完成的先等它落定，和执行中途冻结的路径一致
      await Promise.all([...s.frozen.clearing]);
      throw frozenError(s.frozen);
    }
    // 身份早就不符的会话：不探、不执行，直接 22。没有 await，和上面的状态检查之间不会交错。
    if (s.identityMismatch !== null) throw identityMismatchError(s.identityMismatch);
    // 先置 stepping 再探：探针要 await 页面读取，期间别的 step、close 都是 busy；下面任何一处抛错，finally 都把状态放回 idle。
    s.state = 'stepping';
    this.pauseIdle(s);
    try {
      // 次序：冻结 → 身份探针 → 放行声明的批准 → 执行。账号不对时不该先弹「放行写请求」的框让人批。
      await this.probeIdentity(s);
      if (s.identityMismatch !== null) throw identityMismatchError(s.identityMismatch);
      const frozenNowOnProbe = frozenNow(s);   // 探针的 await 期间被重定向冻结了：和上面同一个错
      if (frozenNowOnProbe !== null) {
        await Promise.all([...frozenNowOnProbe.clearing]);
        throw frozenError(frozenNowOnProbe);
      }
      // 放行声明先过批准：没批准就在这里抛（21、拒绝、22），这一批的操作一个都不执行；探针之后到这里、再到开始执行之间没有 await。
      if (p.allow !== undefined && p.allow.length > 0) this.gateDeclarations(s, p.allow);
      const blockedBefore = s.recorder.blockedEvents();
      const crossBefore = s.crossCount;
      const results = await runOps(s.page, p.ops, { recorder: s.recorder, runDir: s.runDir, now: () => this.deps.now() },
        { keepGoing: p.keepGoing === true, aborted: () => s.gone || s.frozen !== null });
      // 口径：本批执行期间被拦下的本会话请求。执行结束之后才到的「重定向被拒」算进下一批；未归属的请求不算（它们不属于任何会话的记录）。
      const writesBlocked = s.recorder.blockedEvents() - blockedBefore;
      const crossBlocked = s.crossCount - crossBefore;   // 其中跨组导航被拦的：不是只读模式拦的，提示另说
      const tallies = tally(results);
      await this.syncTopHost(s);
      // 本批执行期间冻结了（点链接被重定向到别的组）：后面的操作已记未执行，这一批的结果在报告里，这里报错让人处理。
      const frozen = frozenNow(s);   // 不直接读 s.frozen：上面的检查让 TS 认定它是 null，而它在执行期间被回调改过
      if (frozen !== null) {
        await Promise.all([...frozen.clearing]);
        throw frozenError(frozen);
      }
      const wall = await loginWall(s.page, s.start.url);
      s.lastWall = wall.blocked;
      const notices: string[] = [];
      if (writesBlocked - crossBlocked > 0) notices.push(`本批被拦 ${writesBlocked - crossBlocked} 条写（只读模式），详见报告`);
      notices.push(...s.crossNotices);   // 还没提示过的跨组导航（含两次 step 之间发生的），提示一次就清掉
      s.crossNotices.clear();
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

  // 身份探针（设计 5.2）。身份每次从批准快照里会话所在组现取，不缓存；组没配身份返回 null、什么都不记。
  // 前提：主页面的主机属于会话的组（借用、停在身份提供方 / loginHosts 上都不满足），否则 skipped。
  // 比较：`css=选择器` 恰好匹配 1 个、文字 trim 后等于期望才是 ok；其余是 mismatch；匹配 0 个且页面上有可见的密码框（疑似登录页）时是 skipped。驱动抛 DriverError、整体超时都按 mismatch（失败关闭）；
  // 别的异常照常往上抛。页面已关（会话在收尾）时读不到不算不符。读到的文字只在这里比较，不进任何消息、记录、日志。
  private async probeIdentity(s: Session): Promise<'ok' | 'mismatch' | 'skipped' | null> {
    const identity = this.deps.modes.group(s.group)?.identity ?? null;
    if (identity === null) return null;
    s.identityConfigured = true;
    let outcome: 'ok' | 'mismatch' | 'skipped';
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = this.readIdentity(s, identity.selector, identity.expect);
      work.catch(() => {});   // 超时后才落定的失败没人等，别变成未处理的拒绝
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new DriverError('timeout', 'identity probe timed out')); }, this.deps.identityProbeMs ?? IDENTITY_PROBE_MS);
      });
      outcome = await Promise.race([work, limit]);
    } catch (e) {
      if (!(e instanceof DriverError)) throw e;
      outcome = s.gone ? 'skipped' : 'mismatch';
    } finally {
      clearTimeout(timer);
    }
    if (outcome === 'skipped') {
      s.identitySkipped++;
    } else {
      s.identityChecks++;
      if (outcome === 'mismatch' && s.identityMismatch === null) {
        s.identityMismatch = { group: s.group, expect: identity.expect };
        this.logLine(`会话 ${s.id}：身份探针不符（组 ${s.group}）`);
      }
    }
    return outcome;
  }

  private async readIdentity(s: Session, selector: string, expect: string): Promise<'ok' | 'mismatch' | 'skipped'> {
    const loc = await s.page.location();
    let host: string;
    try {
      host = hostOf(loc.url);
    } catch {
      return 'skipped';
    }
    if (this.deps.modes.groupOf(host).name !== s.group) return 'skipped';
    const target = `css=${selector}`;   // parseIdentity 已拒掉引用、引擎前缀、>>、role、XPath：驱动的 locate 里只会走 css 引擎
    const n = await s.page.read({ kind: 'count', target });
    // 先数再看密码框：登录墙检查只是给人的提示，不是安全判断（后台设置页常有掩码显示密钥的密码框），不能拿它关掉探针。
    // 页面上有密码框时：恰好 1 个照常比较，≥2 个不符，0 个才跳过（可能真的是登录页，身份元素不在）。
    if (n === 0) return (await loginWall(s.page, s.start.url)).blocked !== null ? 'skipped' : 'mismatch';
    if (n !== 1) return 'mismatch';
    return (await s.page.text({ target })).trim() === expect ? 'ok' : 'mismatch';
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

  // 放行声明的批准（设计 5.4）。不管目标主机是什么模式都弹框，只有批准记录里已有的（规范化后全等）不再问。
  // 批准的是「这个组、这个页面主机上放行这些写」：记录按 `组/主机` 存，答复（待批表的键）绑定框里显示的全部内容：会话名、组、页面主机、
  // 待批的声明集合，框弹出后任何一样变了（页面搬了主机、声明多了或少了、换了个会话）旧答复都对不上，重新弹框。
  // 被拒的集合不带会话名记（deniedWrites）：换个会话也不重新弹框。批准用掉之后，别的没用掉的 writes 答复一并作废（基线变了）。
  // 全过了才记进会话：没批准的这一批什么都不生效。
  private gateDeclarations(s: Session, raw: readonly unknown[]): void {
    const { store, approvals } = this.deps;
    const decls = normalizeDeclarations(raw);
    if (decls.length === 0) return;
    this.pruneAskedWrites();
    const host = s.topHost;
    const scope = `${s.group}/${host}`;
    const have = store.writesFor(scope);
    const remembered = decls.filter((d) => have.some((h) => sameDeclaration(h, d)));
    const pending = decls.filter((d) => !remembered.includes(d));
    if (pending.length > 0) {
      const denyKey = sha256(JSON.stringify([s.group, host, pending.map(declarationKey)]));
      const refused = new E2kError('usage', '人拒绝了这些放行声明', '内核重启前同一组声明不会再问；要放行请换成别的声明');
      const key = `writes:${sha256(JSON.stringify([s.name, s.group, host, pending.map(declarationKey)]))}`;
      const earlier = this.askedWrites.get(denyKey);
      if (earlier !== undefined && [...earlier].some((k) => approvals.stateOf(k) === 'denied')) { this.deniedWrites.add(denyKey); this.askedWrites.delete(denyKey); }
      if (this.deniedWrites.has(denyKey)) throw refused;
      const request: DialogRequest = {
        title: 'e2k：放行写请求',
        lines: [`会话：${s.name}（组 ${s.group}）`, `页面所在主机：${host}`, '要放行这些写请求（批准后，只读主机上也能发出）：',
          ...pending.map((d) => `${d.method} ${d.url}${d.operation === null ? '（这个地址上的所有写；GraphQL mutation 不在内，要放行 mutation 得写 operation）' : `（只放行 operation ${d.operation}）`}`),
          '', '拒绝：不放行（默认）'],
        buttons: ['拒绝', '放行'], defaultButton: '拒绝', timeoutSec: APPROVAL_TIMEOUT_SEC,
      };
      const asked = approvals.ask(key, 'writes', request, ['放行']);
      switch (asked.status) {
        case 'pending':
          // 真有框在等人才登记（弹不出、冷却里拒绝的，待批表里没有这个键）。
          this.askedWrites.set(denyKey, (this.askedWrites.get(denyKey) ?? new Set<string>()).add(key));
          throw pendingError(asked.id, '放行写请求的声明');
        case 'denied':
          if (asked.cooling) throw new E2kError('usage', '刚被人拒过，过一会儿再试', '换成别的声明，或等一分钟再试；内核重启前被拒的同一组声明不会再问');
          this.deniedWrites.add(denyKey);
          throw refused;
        case 'unavailable':
          throw new E2kError('needs-human', `要放行写请求但弹不出批准框：${asked.why}`, '在有桌面的终端里起内核');
        case 'approved':
          // 写盘失败时 update 抛 needs-human，原样往上走；答复还留着，重试会再写一次。
          store.update((r) => {
            const cur = Object.hasOwn(r.writes, scope) ? r.writes[scope]! : [];
            r.writes[scope] = [...cur, ...pending.filter((d) => !cur.some((c) => sameDeclaration(c, d)))];
            return r;
          });
          approvals.forget(key);
          approvals.forgetApproved((k) => k.startsWith('writes:'));
          this.askedWrites.delete(denyKey);
          break;
      }
    }
    for (const d of decls) {
      if (s.declared.some((e) => e.scope === scope && sameDeclaration(e.decl, d))) continue;
      s.declared.push({ scope, decl: d, approved: remembered.includes(d) ? 'remembered' : 'dialog' });
    }
  }

  // 待批表里已经没有的键（超时、被丢弃、弹不出框）是死项，剪掉；集合空了就删这个集合。被拒的键在待批表里一直是 denied，不会被剪。
  private pruneAskedWrites(): void {
    for (const [denyKey, keys] of this.askedWrites) {
      for (const k of keys) if (this.deps.approvals.stateOf(k) === undefined) keys.delete(k);
      if (keys.size === 0) this.askedWrites.delete(denyKey);
    }
  }

  // 判定用的放行声明 = 会话提过的 ∩ 批准记录里当前的，而且要是在会话现在的组和页面主机上批准的（判定时再核对：记录里没了、页面搬了主机都失效）。
  private declaredFor(s: Session): Declaration[] {
    if (s.declared.length === 0) return [];
    const scope = `${s.group}/${s.topHost}`;
    const stored = this.deps.store.writesFor(scope);
    return s.declared.filter((e) => e.scope === scope && stored.some((d) => sameDeclaration(d, e.decl))).map((e) => e.decl);
  }

  // 报告里的放行声明：同一条（方法、地址、operation）只列一次，先提的在前。
  private declarationRecords(s: Session): DeclarationRecord[] {
    const seen = new Set<string>();
    const out: DeclarationRecord[] = [];
    for (const e of s.declared) {
      const k = declarationKey(e.decl);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ method: e.decl.method, url: e.decl.url, operation: e.decl.operation, approved: e.approved });
    }
    return out;
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

  // 按域名所在的组选 profile（设计 5.2）。组信息只认已批准的快照（modes.groupOf / modes.group），待批的组不算数。
  // 没给 arg：用域名所在的组。给了：组要存在；和域名所在的组一致就用它；域名没编组（default 组）就借用那个组的登录（不能带槽）；
  // 域名属于别的组则拒绝。借用不弹框、也不核对账号：发往被借组的写按那边的模式判（decideForSession）。
  private pickProfile(host: string, arg: ProfileRef | null): { ref: ProfileRef; borrowed: boolean } {
    const { modes } = this.deps;
    const hg = modes.groupOf(host).name;
    if (arg === null) return { ref: { group: hg, slot: null }, borrowed: false };
    if (modes.group(arg.group) === null) throw new E2kError('usage', '没有这个组', 'e2k rule list 看有哪些组');
    if (arg.group === hg) return { ref: arg, borrowed: false };
    if (hg === DEFAULT_GROUP_NAME) {
      if (arg.slot !== null) throw new E2kError('usage', '槽只能用在本组的域名上', '去掉 profile 里的槽，或换成这个组自己的域名');
      return { ref: arg, borrowed: true };
    }
    throw new E2kError('usage', `这个域名属于组 ${hg}，不能用组 ${arg.group} 的 profile`, `用 --profile ${hg}，或不指定`);
  }

  // 在选定的 profile 里开一个不属于任何会话的页让人登录（设计 5.5）。登录窗口里 loginHosts 之外的写照只读规则拦。
  loginBegin(p: LoginBeginParams): Promise<{ loginId: string }> {
    return this.track(() => this.beginLogin(p));
  }

  // 登录前的弹框确认（设计 5.2「第一次登录问模式」）：主机没列明（已批准的规则、登录时选过、组、任何 loginHosts 都没有）就先问人：
  // 取消 / 默认 / 只读，选择记进批准记录的 hostModes（不改 rules.json）。要在规则闸门之后、算 login.mode 之前，窗口也还没开。
  // 答复（待批表的键 `login:` + 规范化主机）绑定框里显示的全部内容：框里只有这个主机和三个选项，所以键已经绑定了。
  // 各主机的键彼此独立，没有「基线」会变，所以用掉之后只 forget 自己，不作废别的 login: 答复。被拒的保留到内核重启，同类 60 秒冷却。
  // 规范化不了的主机（含取不到主机）不弹框，直接 usage：失败关闭。写盘失败时 needs-human 原样往上走，答复还留着，重试会再写一次。
  private gateLoginHost(rawHost: string): void {
    const { modes, approvals, store } = this.deps;
    if (modes.isListed(rawHost)) {
      // 已列明（比如规则后来批准了）：之前没用掉的答复不能留着，免得以后又没列明时直接生效。
      try {
        const stale = `login:${normalizeHost(rawHost)}`;
        if (approvals.stateOf(stale) === 'approved') approvals.forget(stale);
      } catch {
        // 规范化不了的主机谈不上有旧答复
      }
      return;
    }
    let host: string;
    try {
      host = normalizeHost(rawHost);
    } catch {
      throw new E2kError('usage', '登录地址里取不到可用的主机名，不能问模式', '换成完整的 http(s) 地址');
    }
    // `__proto__` 作键写不进批准记录（读回来会被当成坏文件）。
    if (host === '__proto__') throw new E2kError('usage', '这个主机名不能用', '换成别的地址');
    const key = `login:${host}`;
    const request: DialogRequest = {
      title: 'e2k：在新域名上登录',
      lines: [`要在 ${host} 上打开登录窗口。`, '这个域名还没配模式，请选：', '默认：写请求照常放行（仍记录）', '只读：写请求会被拦下', '取消：不打开'],
      buttons: ['取消', '默认', '只读'], defaultButton: '取消', timeoutSec: APPROVAL_TIMEOUT_SEC,
    };
    const asked = approvals.ask(key, 'login', request, ['默认', '只读']);
    switch (asked.status) {
      case 'pending':
        throw pendingError(asked.id, '在新域名上登录，选模式');
      case 'denied':
        if (asked.cooling) throw new E2kError('usage', '刚被人拒过，过一会儿再试', '等一分钟再试，或换一个已列进规则的域名');
        throw new E2kError('usage', '人取消了这次登录', '内核重启前同一个域名不会再问；要登录请重启内核再试，或把它列进 rules.json');
      case 'unavailable':
        throw new E2kError('needs-human', `要在新域名上登录但弹不出确认框：${asked.why}`, '在有桌面的终端里起内核');
      case 'approved': {
        const mode = asked.button === '只读' ? 'readonly' : asked.button === '默认' ? 'default' : null;
        if (mode === null) throw new E2kError('internal', '登录的答复对不上');   // 不放行
        // 写盘失败时 update 抛 needs-human，原样往上走；答复还留着，重试会再写一次。
        store.update((r) => { r.hostModes[host] = mode; return r; });
        approvals.forget(key);
        break;
      }
    }
  }

  private async beginLogin(p: LoginBeginParams): Promise<{ loginId: string }> {
    // profile 参数的写法先查：要在 gateRules 之前。
    const arg = p.profile === undefined ? null : parseProfileArg(p.profile);
    // 规则先刷新一遍：文件有错就不开登录页（和 open 一致）。
    this.deps.modes.refresh();
    if (this.deps.modes.state().error !== null) throw new E2kError('usage', '规则文件有错，修好之前不能 open', 'e2k rule list 看错误');
    this.gateRules();
    // 取不到主机不挡登录（后面也一样）：按没编组的 default 组算。
    let host = '';
    try {
      host = hostOf(p.url);
    } catch {
      // 取不到主机：host 留空
    }
    const { ref } = this.pickProfile(host, arg);
    this.gateLoginHost(host);
    const profile = profileKey(ref);
    const slot = this.pin(profile);
    try {
      return await this.loginOn(await this.acquireInstance(profile, slot), p, { profile, group: ref.group });
    } finally {
      this.unpin(slot);
    }
  }

  private async loginOn(instance: Instance, p: LoginBeginParams, o: { profile: string; group: string }): Promise<{ loginId: string }> {
    const { profile, group } = o;
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
      login = { id, instance, profile, group, host, mode, pages: new Map([[page.id, page]]), places: new Map([[page.id, { committed: host, pending: new Set() }]]), blocked: 0, crossBlocked: 0, frozen: null, refused: new Set(), requestIds: new Map() };
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
  // writesBlocked 含跨组导航；crossGroupBlocked（只在有跨组拦截时才有）是其中跨组的次数。
  async loginEnd(p: { loginId: string }): Promise<{ writesBlocked: number; crossGroupBlocked?: number }> {
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
    return { writesBlocked: login.blocked, ...(login.crossBlocked > 0 ? { crossGroupBlocked: login.crossBlocked } : {}) };
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
    // 正在被回收的实例也等它停完。
    await Promise.all([...this.slots.values()].flatMap((x) => (x.reclaiming === undefined ? [] : [x.reclaiming])));
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

  // 每个 profile 一个实例，按 key 懒启动。同时在跑（含正在启动、正在被回收）的实例最多 MAX_INSTANCES 个。
  // pin 在 open、login 的入口同步做：先校验 key（非法 key 不占槽、不影响别的 key），再判断上限，最后把槽钉住。
  // 要启动的 key 已满员时先回收空闲实例：没有会话、没有登录页、没有正在开会话的调用、也不在启动中；有空闲的就停最久没用的那个
  // （登录态在 profile 目录里，不会丢），一个空闲的都没有才 busy。回收和占位在同一个同步段里完成，所以第三个请求越不过上限；
  // 被回收的实例停完之前新 key 不启动（slot.after），它占着的名额也要到停完才放。回收期间又来了这个实例自己的 key：等它停完再重启。
  private pin(key: string): InstanceSlot {
    checkProfileKey(key);
    const slot = this.slots.get(key) ?? { pins: 0, lastUsed: ++this.useClock };
    if (slot.instance === undefined && slot.acquiring === undefined) {
      // 要等的：这个 key 自己正在被回收的旧实例，和为它腾名额而被回收的空闲实例。名额都要等它们停完才放。
      const waits: Promise<void>[] = slot.reclaiming === undefined ? [] : [slot.reclaiming];
      if (this.runningOthers(key) >= MAX_INSTANCES) {
        const victim = this.idleVictim(key);
        if (victim === undefined) {
          throw new E2kError('busy', '同时开着的 profile 太多，先关掉一些会话', '关掉一些会话；没有会话的 profile 浏览器到上限时会被自动停掉，登录态不会丢');
        }
        waits.push(this.reclaim(victim[0], victim[1]));
      }
      if (waits.length > 0) slot.after = Promise.all(waits).then(() => undefined);
    }
    this.slots.set(key, slot);
    slot.pins++;
    return slot;
  }

  private unpin(slot: InstanceSlot): void {
    slot.pins--;
    slot.lastUsed = ++this.useClock;
  }

  private isRunning(x: InstanceSlot): boolean {
    return x.instance !== undefined || x.acquiring !== undefined || x.reclaiming !== undefined;
  }

  private runningOthers(key: string): number {
    let n = 0;
    for (const [k, x] of this.slots) if (k !== key && this.isRunning(x)) n++;
    return n;
  }

  // 空闲的实例里最久没用的（不含 exceptKey）：已经启动完、没有钉住它的调用、上面没有会话（含正在开的、正在收尾的）也没有登录页。
  private idleVictim(exceptKey: string): [string, InstanceSlot] | undefined {
    let best: [string, InstanceSlot] | undefined;
    for (const [k, x] of this.slots) {
      const inst = x.instance;
      if (k === exceptKey || inst === undefined || x.acquiring !== undefined || x.reclaiming !== undefined || x.pins > 0) continue;
      if ([...this.sessions.values()].some((s) => s.instance === inst) || [...this.logins.values()].some((l) => l.instance === inst)) continue;
      if (best === undefined || x.lastUsed < best[1].lastUsed) best = [k, x];
    }
    return best;
  }

  // 同步摘掉实例（之后没人能拿到它），再异步停；槽留着、算在名额里，直到停完。
  private reclaim(key: string, slot: InstanceSlot): Promise<void> {
    const inst = slot.instance as Instance;
    slot.instance = undefined;
    this.logLine(`profile ${key}：空闲，浏览器已回收（腾出名额）`);
    const done = this.stopQuietly(inst).finally(() => {
      slot.reclaiming = undefined;
      this.dropIfEmpty(key, slot);
    });
    slot.reclaiming = done;
    return done;
  }

  // 有人用完这个实例（会话收尾、登录页关掉）：记下序号，回收时最久没用的先停。
  private touch(inst: Instance): void {
    for (const x of this.slots.values()) if (x.instance === inst) x.lastUsed = ++this.useClock;
  }

  // 冷启动串行化：同一个 key 正在启动（或正在检查健康）时再来的调用等同一个结果，不 launch 第二次。
  private acquireInstance(key: string, slot: InstanceSlot): Promise<Instance> {
    if (slot.acquiring !== undefined) return slot.acquiring;
    const after = slot.after;
    slot.after = undefined;
    slot.acquiring = this.ensureInstance(key, slot, after).finally(() => {
      slot.acquiring = undefined;
      this.dropIfEmpty(key, slot);
    });
    return slot.acquiring;
  }

  // 槽里没有实例、没有正在启动的、也没有正在回收的：摘掉，不让空槽占着表。
  private dropIfEmpty(key: string, slot: InstanceSlot): void {
    if (!this.isRunning(slot) && this.slots.get(key) === slot) this.slots.delete(key);
  }

  private async ensureInstance(key: string, slot: InstanceSlot, after: Promise<void> | undefined): Promise<Instance> {
    if (after !== undefined) await after;   // 被回收的实例（可能就是这个 key 自己的）停完才启动
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
    inst.setRequestHandler((r) => this.onRequest(r, inst));
    inst.onRequestDone((e) => { this.onRequestDone(e); });
    inst.onPageOpened((page, openerId) => { this.onPageOpened(page, openerId); });
    inst.onNavigationHop((e) => { this.onNavigationHop(e); });
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
    runDir: string; startedAt: Date; host: string; mode: Mode; forced: boolean; profile: string; group: string; borrowed: boolean }): Promise<OpenResult> {
    let page: Page | undefined;
    let registered = false;
    let session: Session | undefined;
    try {
      page = await instance.openPage({ ...(p.viewport === undefined ? {} : { viewport: p.viewport }), ...(p.touch === true ? { touch: true } : {}) });
      if (this.stopping) throw stopping();
      const s: Session = {
        id: o.id, name: o.name, nameDir: o.nameDir, dirName: o.dirName, runDir: o.runDir, startedAt: o.startedAt, instance,
        start: { url: p.url, viewport: p.viewport ?? null, touch: p.touch === true, profile: o.profile, borrowed: o.borrowed },
        group: o.group, crossCount: 0, crossNotices: new Set(), refused: new Set(), frozen: null, declared: [],
        page, pages: new Map([[page.id, page]]), recorder: new Recorder(), forced: o.forced, topHost: o.host, pendingHosts: new Set(), lastWall: null,
        identityConfigured: false, identityChecks: 0, identitySkipped: 0, identityMismatch: null,
        url: '', state: 'opening', gone: false, lastActive: 0, timer: undefined, finished: undefined,
      };
      session = s;
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
      // 首屏经重定向进了别的组的域名（跳事件或页面地址发现）：不交出快照，由下面的 catch 关页、撤销会话，要人处理（和 step 同一个错）。
      const frozen = frozenNow(s);
      if (frozen !== null) throw frozenError(frozen);
      const wall = await loginWall(page, p.url);
      if (this.stopping) throw stopping();
      s.lastWall = wall.blocked;
      // 首屏之后探一次：不符照样把会话交出去（人要看到提示），记在会话上，下一次 step 起就是 22。状态还是 opening，没有别的调用能碰到它。
      const identity = await this.probeIdentity(s);
      if (this.stopping) throw stopping();
      s.url = safely(() => redactUrl(loc.url));
      s.state = 'idle';
      this.restartIdle(s);
      // 首屏不符：next 放 step 的错误里那句下一步（--json 里也看得到）；同时在登录墙上时仍以登录提示为准（blocked 是 login，next 要对得上它）。
      const next = identity === 'mismatch' && wall.blocked === null ? IDENTITY_NEXT : wall.next;
      return {
        session: s.id, name: s.name, url: s.url, title: safely(() => redactText(loc.title)), mode: this.sessionMode(s, []), runDir: s.runDir,
        snapshot: cappedSnapshot(snapshot), ...wall, next, profile: o.profile, borrowed: o.borrowed, identity,
      };
    } catch (e) {
      // 先清理（关页、删空的报告目录、撤销登记），会话不建立；再把驱动的错误换成 action-failed，别的原样抛。
      if (page !== undefined) await this.closePageQuietly(o.id, page);
      if (session !== undefined) await this.clearFrozenCookies(session);   // 页关了再清一遍（冻结了才有事做）
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
    await this.clearFrozenCookies(s);   // 页都关了，这时再清一遍：跳转那一刻的清理可能赶在那一跳的 Set-Cookie 之前
    const endedAt = this.deps.now();
    this.sessions.delete(s.id);
    this.touch(s.instance);

    let result: RunResult | undefined;
    let paths: { reportPath: string; resultPath: string } | undefined;
    try {
      result = buildResult({
        kernelVersion: this.deps.kernelVersion, session: s.id, name: s.name, startedAt: s.startedAt, endedAt, closedBy,
        start: s.start, driver: { name: this.deps.driver.name, capabilities: this.deps.driver.capabilities },
        actions: s.recorder.actions, writes: s.recorder.writes, unattributedWrites: this.unattributedDuring(s.startedAt, endedAt), hosts: s.recorder.hosts, webSockets,
        verdict: p?.verdict ?? null, findings: p?.findings ?? [], notDone: p?.notDone ?? [], superseded: p?.superseded ?? [], declarations: this.declarationRecords(s),
        modes: s.recorder.modes, rules: this.rulesInForce(), blocked: s.lastWall, forced: s.forced,
        identity: s.identityConfigured ? { group: s.group, checks: s.identityChecks, skipped: s.identitySkipped, mismatch: s.identityMismatch !== null } : null,
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
    this.touch(login.instance);
    for (const page of login.pages.values()) {
      if (page === null) continue;
      try {
        await page.close();
      } catch (e) {
        // 已经被人关掉的页再关会抛 DriverError，不算错。
        if (!(e instanceof DriverError)) this.logFailure(null, `登录 ${login.id} 关页面`, e);
      }
    }
    await this.clearFrozenCookies(login);
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
  private onRequest(req: RequestInfo, inst: Instance): Decision {
    try {
      return this.decideRequest(req, inst);
    } catch (e) {
      this.logFailure(null, '处理请求', e);
      return { action: 'abort' };
    }
  }

  private decideRequest(req: RequestInfo, inst: Instance): Decision {
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
    // 归不到任何会话或登录页（pageId 为 null、弹窗的第一个导航、人手开的标签页之类）：发出它的这个浏览器实例上有会话或登录页冻结了，
    // 就一律 403（冻结的会话开出来的、认不出归属的弹窗也在内）；别的实例不受影响。
    const frozen = this.frozenOn(inst);
    if (frozen !== null) {
      const verdict = blockFrozen(req, frozen.group);
      this.unattributed.push(toWriteRecord(req, verdict, { mode: 'default', targetMode: this.deps.modes.resolve(hostOf(req.url)) }, this.deps.now()));
      if (this.unattributed.length > MAX_UNATTRIBUTED) this.unattributed.shift();
      return verdict.decision;
    }
    // 归不到任何会话或登录页（pageId 为 null，或是人手开的标签页之类）：有任一只读会话活着就按「只读」拦写。
    // 请求所在页自己的顶层主机只读也算（模式跟着页面走），不用等有只读会话。
    const anyReadonly = [...this.sessions.values()].some((x) => this.sessionMode(x, []) === 'readonly')
      || this.deps.modes.resolve(hostOf(req.topUrl ?? req.url)) === 'readonly';
    // 未归属的请求不属于任何组：带所有已批准组的登出接口的并集（只读时命中就拦；groupOf 看不到写在 loginHosts 上的登出，也不知道它该算哪个组）；
    // 白名单里的写一概不放行。
    const verdict = this.deps.policy.decideUnattributed(req, { anyReadonly, logout: this.deps.modes.allLogout() });
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
    // 已冻结（登录页经重定向进了别的组的域名）：所有请求，含 GET，一律拦，计入 writesBlocked 和 crossGroupBlocked。
    if (login.frozen !== null) return this.blockFrozenLogin(login, login.frozen, req);
    const place = this.loginPlace(login, req.pageId, req.openerPageId);
    const isNav = req.isNavigation && req.topFrame;
    // 跨组导航先于 loginHosts 的豁免和写策略：去别的组的域名，登录窗口里也不放行（含弹窗）。
    if (isNav) {
      const cross = this.crossGroup(req, login.group);
      if (cross !== null) {
        login.blocked++;
        login.crossBlocked++;
        this.logLine(`登录 ${login.id}：拦下跨组导航 ${safely(() => redactText(hostOf(req.url)))}`);
        login.refused.add(withoutHash(req.url));   // 页面会停在这张 403 页上：之后看到页面在这个地址，不算被重定向带进去的
        if (login.refused.size > MAX_REFUSED) login.refused.delete(login.refused.values().next().value as string);
        return cross.verdict.decision;
      }
    }
    // 兜底（跳事件漏掉时，比如弹窗的第一个导航认不出归属）：登录页已提交的地址（顶层导航：发起页的地址；其他请求：请求所在的顶层地址）
    // 在别的组的域名上，就冻结，这个请求也拦；判断出错也冻结。要在 place.committed 记下它之前判断。
    const evidence = isNav ? req.initiatorUrl : req.topUrl;
    if (evidence !== null) this.freezeLoginIfOtherGroup(login, evidence);
    if (login.frozen !== null) return this.blockFrozenLogin(login, login.frozen, req);
    // 顶层导航带着发起页已提交的地址（initiatorUrl）：这是页面在哪的直接证据（经重定向进入、又没发过子资源的页面也靠它），
    // 先据此定下发起页的主机，再判断；没有就用跟踪到的 committed/pending。
    if (isNav && req.initiatorUrl !== null) {
      place.committed = hostOf(req.initiatorUrl);
      place.pending.clear();
    }
    const exempt = modes.isLoginHost(hostOf(req.url), login.group)
      || (isNav && [place.committed, ...place.pending].some((h) => modes.isLoginHost(h, login.group)));
    let decision: Decision;
    if (exempt) decision = { action: 'continue' };
    else {
      const all = [login.mode, ...[place.committed, ...place.pending, topHost, ...this.groupTargets(login.group, hostOf(req.url), topHost)].map((h) => modes.resolve(h))];
      const mode: Mode = all.includes('readonly') ? 'readonly' : all.includes('denied') ? 'denied' : 'default';
      // 登录窗口里允许登出（好换账号），也没有放行声明（声明属于会话）：logout、declared 传空；读型 POST、持久化查询照目标主机所在组。
      const verdict = this.deps.policy.decide(req, this.policyCtx(mode, null, hostOf(req.url), false));
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

  // 顶层导航的目标主机属于别的组（不是 default 组、也不是 ownGroup）：给出 403 的判定；否则 null。组只认已批准的快照。
  // 「事实上的借用」：用的是某个组（不是 default）的登录态，请求发往这个组的主机，而发出请求的页面当前的顶层主机不在这个组里
  // （含没编组的主机）。这时要把目标主机自己的模式也算进有效模式（那边只读就按只读判），所以返回 [目标主机]；否则 []。
  // 按事实判，不按 open 时有没有借用：先开本组、再跳到没编组主机的会话也一样受约束。
  private groupTargets(group: string, targetHost: string, topHost: string): string[] {
    if (group === DEFAULT_GROUP_NAME) return [];
    const { modes } = this.deps;
    return modes.groupOf(targetHost).name === group && modes.groupOf(topHost).name !== group ? [targetHost] : [];
  }

  // 一次写策略判定的上下文：登出 = 会话组的 ∪ 目标主机组的（withLogout 为 false 时是空，登录窗口用）；读型 POST、持久化查询只取目标主机所在组的
  // （组只认已批准的快照；接口的主机在组内由规则解析保证）。放行声明只有会话页和会话弹窗传（declaredFor），登录页、未归属请求不传。
  private policyCtx(mode: Mode, ownGroup: string | null, targetHost: string, withLogout: boolean, declared: readonly Declaration[] = []): PolicyCtx {
    const { modes } = this.deps;
    const target = modes.groupOf(targetHost);
    const own = ownGroup === null ? null : modes.group(ownGroup);
    return { mode, logout: withLogout ? [...(own?.logout ?? []), ...target.logout] : [], readPosts: target.readPosts, persisted: target.persistedQueries, declared };
  }

  // message 是给 step 的提示句（和 403 页面上的是同一句）。
  private crossGroup(req: RequestInfo, ownGroup: string): { verdict: PolicyVerdict; message: string } | null {
    const target = this.deps.modes.groupOf(hostOf(req.url)).name;
    if (target === DEFAULT_GROUP_NAME || target === ownGroup) return null;
    return { verdict: blockOtherGroup(safely(() => redactText(hostOf(req.url))), target, ownGroup), message: otherGroupMessage(target, ownGroup) };
  }

  // ---- 冻结（重定向进了别的组的域名） ----

  // 驱动报来的重定向的跳（主 frame 导航被重定向之后的每一跳，首跳不在这里，走 decideRequest）：每一跳都查。
  // 跳到的域名属于别的组（规则同首跳：不是 default 组、不是自己的组）就冻结；认不出是会话或登录页的页不管。
  // 跳已经发出，拦不住，所以只能事后冻结，让这个会话此后的请求都 403。判断出错也冻结（失败关闭）。
  private onNavigationHop(e: { pageId: string; url: string }): void {
    const s = this.sessionOfPage(e.pageId);
    const login = s === undefined ? this.loginOfPage(e.pageId) : undefined;
    const owner = s ?? login;
    if (owner === undefined) return;
    let group: string | null = null;
    let host: string | null = null;
    try {
      const u = new URL(e.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;   // 重定向到别的协议进不了任何组的域名
      host = u.hostname;
      const target = this.deps.modes.groupOf(host).name;
      if (target === DEFAULT_GROUP_NAME || target === owner.group) return;
      group = target;
    } catch (err) {
      this.logFailure(null, '判断重定向的跳', err);
    }
    if (s !== undefined) this.freezeSession(s, e.url, group, host);
    else if (login !== undefined) this.freezeLogin(login, group, host);
  }

  // 页面已提交的地址在别的组的域名上吗？是（或判断出错）就给出 { group, host }（出错时都是 null，失败关闭），否则 null。
  // 被内核自己拦下的跨组导航停下的 403 页（refused）不算：那不是被重定向带进去的。
  private otherGroupEvidence(owner: Session | Login, url: string): { group: string | null; host: string | null } | null {
    let group: string;
    let host: string;
    try {
      host = hostOf(url);
      group = this.deps.modes.groupOf(host).name;
    } catch (err) {
      const { sessionId, prefix } = this.who(owner);
      this.logFailure(sessionId, `${prefix}判断页面地址`, err);
      return { group: null, host: null };
    }
    if (group === DEFAULT_GROUP_NAME || group === owner.group || owner.refused.has(withoutHash(url))) return null;
    return { group, host };
  }

  // 兜底：已提交的页面地址在别的组的域名上，说明重定向的跳事件漏掉了，同样冻结（已冻结的不再重复）。
  private freezeIfOtherGroup(s: Session, url: string): void {
    if (s.frozen !== null) return;
    const hit = this.otherGroupEvidence(s, url);
    if (hit !== null) this.freezeSession(s, url, hit.group, hit.host);
  }

  private freezeLoginIfOtherGroup(login: Login, url: string): void {
    if (login.frozen !== null) return;
    const hit = this.otherGroupEvidence(login, url);
    if (hit !== null) this.freezeLogin(login, hit.group, hit.host);
  }

  // 这个实例上有没有冻结的会话或登录页：有就给出第一个的冻结（组名用来写 403 页）。
  private frozenOn(inst: Instance): Freeze | null {
    for (const s of this.sessions.values()) if (s.instance === inst && s.frozen !== null) return s.frozen;
    for (const l of this.logins.values()) if (l.instance === inst && l.frozen !== null) return l.frozen;
    return null;
  }

  // 登录页冻结之后的请求：一律拦，计入 writesBlocked 和 crossGroupBlocked。
  private blockFrozenLogin(login: Login, frozen: Freeze, req: RequestInfo): Decision {
    login.blocked++;
    login.crossBlocked++;
    return blockFrozen(req, frozen.group).decision;
  }

  // 冻结的共同部分：记下第一次跨进去的组，对这一跳的主机清 cookie（只在这个会话所在的实例上）。
  private markFrozen(owner: Session | Login, group: string | null, host: string | null): Freeze {
    const frozen: Freeze = owner.frozen ?? { group, hosts: new Set(), clearing: new Set() };
    owner.frozen = frozen;
    if (host !== null && host !== '') {
      frozen.hosts.add(host);
      this.clearCookies(owner, frozen, host);
    }
    return frozen;
  }

  // 日志里谁在清 cookie：会话记在会话名下，登录页写进文字里。
  private who(owner: Session | Login): { sessionId: string | null; prefix: string } {
    return 'page' in owner ? { sessionId: owner.id, prefix: '' } : { sessionId: null, prefix: `登录 ${owner.id} ` };
  }

  // 清这个主机的 cookie 不等结果（跳转回调是同步的）：失败只记日志。
  private clearCookies(owner: Session | Login, frozen: Freeze, host: string): void {
    const { sessionId, prefix } = this.who(owner);
    const p = owner.instance.clearCookies(host).catch((e: unknown) => { this.logFailure(sessionId, `${prefix}清 ${safely(() => redactText(host))} 的 cookie`, e); });
    frozen.clearing.add(p);
    void p.finally(() => { frozen.clearing.delete(p); });
  }

  // 收尾时（页都关了）再清一遍：跳转那一刻清掉的 cookie，可能赶在那一跳的响应带来的 Set-Cookie 之前。实例已经没了就不清。
  private async clearFrozenCookies(owner: Session | Login): Promise<void> {
    const f = owner.frozen;
    if (f === null) return;
    await Promise.all([...f.clearing]);
    if (!(await this.healthy(owner.instance))) return;
    const { sessionId, prefix } = this.who(owner);
    for (const host of f.hosts) {
      try {
        await owner.instance.clearCookies(host);
      } catch (e) {
        this.logFailure(sessionId, `${prefix}收尾清 ${safely(() => redactText(host))} 的 cookie`, e);
      }
    }
  }

  // 会话冻结：记一条被拦的 other-group（没有真请求，造一条导航的记录），日志一行。组、主机判断不出时 group、host 为 null。
  private freezeSession(s: Session, url: string, group: string | null, host: string | null): void {
    this.markFrozen(s, group, host);
    const req: RequestInfo = {
      id: `hop${++this.hopSeq}`, pageId: null, openerPageId: null, method: 'GET', url, resourceType: 'document',
      isNavigation: true, topFrame: true, topUrl: url, initiatorUrl: null, contentType: null, body: null, fromLoginForm: null,
    };
    const verdict: PolicyVerdict = { decision: { action: 'abort' }, reason: 'other-group', allowedBy: null };
    s.recorder.addRequest(req, verdict, { mode: this.sessionMode(s, []), targetMode: this.deps.modes.resolve(host ?? '') }, this.deps.now());
    this.logLine(`会话 ${s.id}：页面经重定向进了${group === null ? '判断不出归属的' : `组 ${group} 的`}域名 ${safely(() => redactText(host ?? ''))}，已冻结`);
  }

  // 登录页冻结：这一跳按一次被拦的跨组导航算（writesBlocked、crossGroupBlocked 各加一），日志一行。
  private freezeLogin(login: Login, group: string | null, host: string | null): void {
    this.markFrozen(login, group, host);
    login.blocked++;
    login.crossBlocked++;
    this.logLine(`登录 ${login.id}：页面经重定向进了${group === null ? '判断不出归属的' : `组 ${group} 的`}域名 ${safely(() => redactText(host ?? ''))}，已冻结`);
  }

  // 冻结之后的请求：一律 403，记进会话的记录（每个请求都进 requests，被拦的进 writes）。
  private blockFrozenRequest(s: Session, frozen: Freeze, req: RequestInfo): Decision {
    const verdict = blockFrozen(req, frozen.group);
    s.recorder.addRequest(req, verdict, { mode: this.sessionMode(s, []), targetMode: this.deps.modes.resolve(hostOf(req.url)) }, this.deps.now());
    return verdict.decision;
  }

  // 会话页（主页面、弹窗）的请求。模式跟着页面走（设计 5.2）：有效模式 = 会话主页面的顶层主机和请求所在页的顶层主机取并，
  // 任何一边只读就按只读；默认模式的页面发往只读主机的写照旧放行，只记录（targetMode）。
  private decideForSession(s: Session, req: RequestInfo): Decision {
    // 已冻结：这个会话所有页的所有请求，含 GET，一律 403（记 other-group）。
    if (s.frozen !== null) return this.blockFrozenRequest(s, s.frozen, req);
    // topUrl 可能是 null（判断不出顶层页面），这时退回请求自己的地址。
    const topHost = hostOf(req.topUrl ?? req.url);
    const isMain = req.pageId === s.page.id;
    const mainNav = isMain && req.isNavigation && req.topFrame;
    // 主页面的顶层导航：规则可能刚被人改过，先刷新。导航前的主机（s.topHost）和目标一起算，所以只读页跨主机的表单 POST 也拦得住。
    if (mainNav) this.deps.modes.refresh();
    const host = hostOf(req.url);
    const targetMode = this.deps.modes.resolve(host);
    // 跨组导航（主页面和弹窗的顶层导航）先于写策略：目标域名属于别的组就不放行，进记录（other-group），并给下一次 step 一条提示。
    // 被拦的导航不改主机、待定主机，也不算「到过」的域名。iframe 和子资源不管。
    if (req.isNavigation && req.topFrame) {
      const cross = this.crossGroup(req, s.group);
      if (cross !== null) {
        s.recorder.addRequest(req, cross.verdict, { mode: this.sessionMode(s, []), targetMode }, this.deps.now());
        s.crossCount++;
        s.crossNotices.add(cross.message);
        s.refused.add(withoutHash(req.url));   // 页面会停在这张 403 页上：之后看到页面在这个地址，不算被重定向带进去的
        if (s.refused.size > MAX_REFUSED) s.refused.delete(s.refused.values().next().value as string);
        return cross.verdict.decision;
      }
    }
    // 兜底（重定向的跳事件漏掉时，比如弹窗的第一个导航认不出归属）：会话的页已提交的地址（顶层导航：发起页的地址；其他请求：请求所在的
    // 顶层地址）在别的组的域名上，就冻结，这个请求也不放行。
    const evidence = req.isNavigation && req.topFrame ? req.initiatorUrl : req.topUrl;
    if (evidence !== null) this.freezeIfOtherGroup(s, evidence);
    if (s.frozen !== null) return this.blockFrozenRequest(s, s.frozen, req);
    // 发起页已提交的地址是主页面在哪的直接证据：先据此定下 topHost（待定的丢掉），再算模式。
    if (mainNav && req.initiatorUrl !== null) this.converge(s, hostOf(req.initiatorUrl));
    // 本组登录态下、顶层不在本组的页面（借用的本地页面，或先开本组、再跳到没编组的主机）发往本组的请求：有效模式再并上目标主机自己的模式。
    const mode = this.sessionMode(s, [topHost, ...this.groupTargets(s.group, host, topHost)]);
    const verdict: PolicyVerdict = this.deps.policy.decide(req, this.policyCtx(mode, s.group, host, true, this.declaredFor(s)));
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

  // 记一条模式变更（和上一条同模式的由 Recorder 去重）：reason 看这个主机有没有命中规则、或只是登录时选过模式。
  private recordMode(s: Session): void {
    const { modes } = this.deps;
    const { hash, pendingHash } = modes.state();
    s.recorder.noteMode({
      at: this.deps.now().toISOString(), host: s.topHost, mode: this.sessionMode(s, []),
      reason: s.forced ? 'forced' : modes.hostChoice(s.topHost) !== null ? 'host-choice' : modes.ruleFor(s.topHost) === null ? 'no-rule' : 'rule', rulesHash: hash, pendingRulesHash: pendingHash,
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
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        this.freezeIfOtherGroup(s, url);
        this.converge(s, u.hostname);
      }
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
