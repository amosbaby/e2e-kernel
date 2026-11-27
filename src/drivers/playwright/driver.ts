import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import type { APIResponse, Browser, BrowserContext, CDPSession, Frame, Locator, Page as PwPage, Request as PwRequest, Route } from 'playwright';
import { ACTION_TIMEOUT_MS, DriverError, NAVIGATION_TIMEOUT_MS } from '../../driver/types.ts';
import type { Capabilities, Check, Decision, Described, Driver, Instance, Page, PageLocation, PasswordProbe, RequestInfo, Stable }
  from '../../driver/types.ts';
import { isRef } from '../../shared/ops.ts';
import type { AssertKind, Target, Viewport, WaitCond } from '../../shared/ops.ts';
import { createTargetParams, startBrowser } from './browser-process.ts';
import type { BrowserProcess } from './browser-process.ts';
import { parseRoleTarget, stableCandidates } from './stable.ts';
import type { ElementInfo } from './stable.ts';

// Playwright 驱动（设计 5.10）：实例、页面登记、请求拦截、页面和实例的关闭事件。
// 这是唯一 import playwright 的地方（src/drivers/playwright/ 以外不碰浏览器库）。
// 页面上的操作、读数和 describe 也在这里；目标翻译见 locate。
// 报错消息只取 Playwright 消息的第一行，里面可能带 URL 或选择器：内核要在写日志和报告之前脱敏。

// 取值来自 docs/m0-findings.md：§3、§4 的实测里，跨进程 iframe 和原生表单提交的写请求 route() 都看得见也拦得住。
const CAPABILITIES: Capabilities = {
  networkInterception: true,
  crossProcessIframes: 'covered',   // docs/m0-findings.md §4
  nativeFormSubmit: 'covered',      // docs/m0-findings.md §4
  sharedWorkers: 'covered',         // docs/m0-findings.md §9.9：init script 在所有页面删掉 SharedWorker
  sharesUserProfile: false,
  canHeadless: true,
  selectorDialect: 'playwright',
};

const MAX_BODY_BYTES = 64 * 1024;
const LAUNCH_TIMEOUT_MS = 30_000;       // 连上浏览器的上限
const OPEN_PAGE_TIMEOUT_MS = 15_000;    // 等新开的页出现的上限
const PAGE_READY_TIMEOUT_MS = 5000;     // 认领到的页，页内 evaluate 要多久内通
const OPEN_PAGE_POLL_MS = 50;           // 页出现了但地址还没提交时，隔多久再看
const BROWSER_CLOSE_TIMEOUT_MS = 5000;  // 优雅关闭（Browser.close）的上限；超了由 terminate 兜底
// 页面的默认视口：launchPersistentContext 原来默认就是 1280x720；连接已有浏览器的默认 context 不带视口，这里补上，开页时设。
const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 };
// serviceWorkers: 'block' 是 context 的创建选项，连接已有浏览器的默认 context 传不了；这是 Playwright 在 block 时装的那段初始化脚本
// （pw 1.65.1 的 browserContext.ts），在所有页面、所有 frame 里让 register() 什么都不做。
// docs/m0-findings.md §6 实测过效果：register() 本身 resolve，但没有注册生成。
const BLOCK_SERVICE_WORKERS_SCRIPT = `
if (self.ServiceWorkerContainer) ServiceWorkerContainer.prototype.register = async () => { console.warn('Service Worker registration blocked'); };
`;
const TOUCH_POINTS = 5;   // 触屏模拟报给页面的 maxTouchPoints
const MAX_MESSAGE_CHARS = 300;
// 失败诊断（DriverError.hints）：驱动只做保护性的截断，不脱敏也不截短（内核先脱敏、再截到 300），
// 免得一个长条目的截断点正好落在 token 中间。最多 6 条：第一条是总数或遮挡说明，其余是前 5 个候选。
const MAX_HINTS = 6;
const MAX_HINT_CHARS = 4000;
const MAX_CANDIDATES = 5;
const DIAGNOSE_TIMEOUT_MS = 2000;
const IDLE_POLL_MS = 50;
const IDLE_MAX_URLS = 3;
const STRICT_VIOLATION = 'strict mode violation';
const INTERCEPTS = 'intercepts pointer events';

// 页面 id 和请求 id 的计数挂在驱动对象上：整个生命期内唯一，不随实例或 launch 重置。
// id 都由这里生成，从不取自页面内容。
interface Counters { page: number; request: number }

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, MAX_MESSAGE_CHARS);
}

// Playwright 的 TimeoutError → timeout；其余 → other。消息只取第一行。
function mapError(e: unknown): DriverError {
  if (e instanceof DriverError) return e;
  if (!(e instanceof Error)) return new DriverError('other', 'unknown error');
  return new DriverError(e.name === 'TimeoutError' ? 'timeout' : 'other', firstLine(e.message));
}

// 一个候选元素的描述：标签、角色、名字（不截短）、位置和大小。
// 作为函数交给 locator.evaluateAll 序列化，所以必须自成一体：不引用这个文件里的任何东西。不取元素的值。
export function describeCandidates(els: Element[], max: number): { tag: string; role: string; name: string; x: number; y: number; w: number; h: number }[] {
  const norm = (v: string): string => v.replace(/\s+/g, ' ').trim();
  return els.slice(0, max).map((el) => {
    const tag = el.localName;
    const type = el instanceof HTMLInputElement ? el.type : '';
    let role = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0] ?? '';
    if (role === '') {
      if (tag === 'button') role = 'button';
      else if (tag === 'a' && el.hasAttribute('href')) role = 'link';
      else if (tag === 'input') role = type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'textbox';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'select') role = 'combobox';
      else if (/^h[1-6]$/.test(tag)) role = 'heading';
    }
    // 名字在页内先截到 4000：整页的 innerText 不经 CDP 传回来。
    const cap = (v: string): string => norm(v.slice(0, 4000));
    let name = cap(el.getAttribute('aria-label') ?? '');
    if (name === '') {
      const labels = 'labels' in el ? Array.from((el as HTMLInputElement).labels ?? []) : [];
      name = cap(labels.map((l) => l.textContent ?? '').join(' '));
    }
    if (name === '' && (role === 'button' || role === 'link' || role === 'heading')) name = cap((el as HTMLElement).innerText ?? '');
    const r = el.getBoundingClientRect();
    return { tag, role, name, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
}

// Playwright 的元素预览（previewNode）会在两处截断并补一个 `…`：属性文字超过 500 字符（最后一个属性只剩半截）、
// 文字内容超过 50 字符（文字只剩半截）。截断点上的半截 token 脱敏认不出来，而页面还能在值里伪造 `…` 和 `>`，
// 所以不去解析哪里是真的截断点：对行里每一个 `…`，删掉紧挨在它前面、连续的「非空白且不是 " ' = >」的字符。
// 单遍线性扫描，不用正则。文字里本来就有 `…` 时会多删一点，可以接受。
export function dropTruncatedRuns(line: string): string {
  const out: string[] = [];
  for (const ch of line) {
    if (ch === '…') {
      while (out.length > 0) {
        const last = out[out.length - 1]!;
        if (last.trim() === '' || last === '"' || last === "'" || last === '=' || last === '>') break;
        out.pop();
      }
    }
    out.push(ch);
  }
  return out.join('');
}

// Playwright 的调用记录里最后一条「谁挡住了点击」。记录在 error.message 里（第一行之后），行文是 `… intercepts pointer events`。
export function interceptHint(message: string): string | null {
  const lines = message.split('\n').filter((l) => l.includes(INTERCEPTS));
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  return `被遮挡：${dropTruncatedRuns(last.trim().replace(/^-\s*/, ''))}`.slice(0, MAX_HINT_CHARS);
}

// 诊断永远不抛：失败、超时都当没有诊断（原错误照给）。
export async function guardedHints(collect: () => Promise<string[]>, timeoutMs: number): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = collect().catch((): string[] => []);
    return await Promise.race([work, new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), timeoutMs); })]);
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// 请求的目标和发出它的 frame 同源。判断不出（Worker 的请求没有 frame、frame 地址不是 http(s)、解析失败、源是 null）按跨源算。
function isSameOrigin(request: PwRequest): boolean {
  try {
    const from = new URL(request.frame().url());
    const to = new URL(request.url());
    return from.origin !== 'null' && from.origin === to.origin;
  } catch {
    return false;
  }
}

function httpUrlOrNull(url: string): string | null {
  return /^https?:/i.test(url) ? url : null;
}

// 监听器之间互相隔离：一个抛错不会让后面的监听器漏掉，也不会带垮 Playwright 的事件分发。
// 但异常不吞：交给 report（见 DriverOptions.onListenerError）。
function emit<A extends unknown[]>(report: (e: unknown) => void, listeners: readonly ((...args: A) => void)[], ...args: A): void {
  for (const l of [...listeners]) {
    try {
      l(...args);
    } catch (e) {
      try {
        report(e);
      } catch (e2) {
        rethrowAsync(e2);   // 连处理函数也抛错：不能让它打断其余监听器
      }
    }
  }
}

// 监听器抛错时的默认处理：异步重抛，成为进程的 uncaughtException，不会在驱动里无声消失。
function rethrowAsync(e: unknown): void {
  queueMicrotask(() => { throw e; });
}

export interface DriverOptions {
  // 监听器（onClosed、onPageOpened、onRequestDone）抛出的异常交给它；不给就异步重抛（rethrowAsync）。
  // 每个抛错的监听器调用一次，其余监听器照常运行。
  onListenerError?: (e: unknown) => void;
  // 动作等目标出现、以及 Playwright 动作本身的超时（毫秒），默认 ACTION_TIMEOUT_MS。测试用来把「永远不出现」的等待缩短。
  actionTimeoutMs?: number;
  // 浏览器可执行文件的路径；不给就用 Playwright 自带的 Chromium。内核从不传它，测试用来造「启动不了」的情形。
  executablePath?: string;
}

// 密码类输入框的选择器：不要求可见，宁可多判成「有」，少记一条请求体。
// 用 locator 数而不是在页面里 querySelector：locator 跑在 Playwright 自己的隔离环境里，页面改写不了
// document.querySelector，CSS 选择器默认还会穿透 open shadow root（closed shadow root 看不见）。
const PASSWORD_FIELD_SELECTOR =
  'input[type="password" i], [autocomplete*="current-password" i], [autocomplete*="new-password" i], [autocomplete*="one-time-code" i]';

// 登录墙：只认可见的、「当前密码」类的字段（不含 new-password，免得把注册页当登录页）。
const LOGIN_WALL_SELECTOR = 'input[type=password i], input[autocomplete~="current-password" i], input[autocomplete~="one-time-code" i]';

const PROBE_TIMEOUT_MS = 300;
const NAVIGATION_PENDING_MS = 10_000;

// 发出请求的 frame 和它所在页面顶层 frame 当前的地址；探测前后各取一次，变了说明期间页面在换文档。
function frameUrls(frame: Frame): string[] {
  return [frame.url(), frame.page().mainFrame().url()];
}

// 发出请求的 frame，或它所在页面顶层文档里有没有密码类输入框。true / false 都是确切的判断；
// 抛错、被页面卡住（比如同步 XHR 正占着页面线程）、超过 300 ms、探测期间 frame 或顶层的地址变了，一律 null，
// 内核按失败关闭处理。`before` 是请求一到就（同步）取的 frameUrls，没有它探不出「期间换了文档」。
// `navigating` 说这个 frame 或顶层 frame 有一次导航已经发起、还没提交（发请求之后马上 location.href 跳走的页面）：
// 此时 locator 可能已经落在新文档上而 frame.url() 还是旧的，所以开始前、结束后它为真都给 null。
// 这是在路由回调里等的，所以必须有时限：绝不让探测卡住请求。
async function probePasswordField(frame: Frame, before: string[], navigating: () => boolean): Promise<boolean | null> {
  if (navigating()) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS); });
  const main = frame.page().mainFrame();
  const frames = main === frame ? [frame] : [frame, main];
  const probe = Promise.allSettled(frames.map((f) => f.locator(PASSWORD_FIELD_SELECTOR).count())).then((rs): boolean | null => {
    if (rs.some((r) => r.status === 'fulfilled' && r.value > 0)) return true;
    return rs.every((r) => r.status === 'fulfilled') ? false : null;
  });
  try {
    const found = await Promise.race([probe, timeout]);
    const after = frameUrls(frame);
    return navigating() || !before.every((u, i) => u === after[i]) ? null : found;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 整个页面（所有 frame）里有没有密码类输入框，给 eval 的记录用。口径同 probePasswordField（不要求可见、locator 数、300 ms 时限），
// 区别是数全部 frame：eval 能读同源 iframe 的 DOM。所有 frame 都数清楚且都没有才是 false；任何一个数不出、超时、
// 数的期间有 frame 的地址变了（换文档）或 frame 数变了，一律 null，内核按失败关闭处理。
async function probePageForPasswordField(page: PwPage): Promise<PasswordProbe> {
  const urlsOf = (): string[] => page.frames().map((f) => f.url());
  const before = urlsOf();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS); });
  const probe = Promise.allSettled(page.frames().map((f) => f.locator(PASSWORD_FIELD_SELECTOR).count())).then((rs): boolean | null => {
    if (rs.some((r) => r.status === 'fulfilled' && r.value > 0)) return true;
    return rs.every((r) => r.status === 'fulfilled') ? false : null;
  });
  try {
    const found = await Promise.race([probe, timeout]);
    const after = urlsOf();
    return { found: before.length === after.length && before.every((u, i) => u === after[i]) ? found : null, frames: after };
  } catch {
    return { found: null, frames: urlsOf() };
  } finally {
    clearTimeout(timer);
  }
}

// 统一写法 → Playwright 的 Locator：引用 → getByRef；role=…[name="…"] → getByRole（我们自己解析）；其余 → locator。
function locate(page: PwPage, target: Target): Locator {
  if (isRef(target)) return page.getByRef(target);
  const role = parseRoleTarget(target);
  if (role !== null) return page.getByRole(role.role as Parameters<PwPage['getByRole']>[0], { name: role.name, exact: true });
  return page.locator(target);
}

// 在页面里对一个元素取值（作为函数交给 locator.evaluate 序列化，所以必须自成一体：不引用这个文件里的任何东西）。
// 得到的是 stableCandidates 要的 ElementInfo（取自目标本身），外加 fill 实际会填的那个元素是不是密码框、是哪一类。
function collectElementInfo(el: Element): { info: ElementInfo; isPassword: boolean; kind: 'text-input' | 'textarea' | 'other' } {
  const norm = (v: string): string => v.replace(/\s+/g, ' ').trim();
  const tag = el.localName;
  const type = el instanceof HTMLInputElement ? el.type : '';
  const textTypes = ['text', 'search', 'email', 'url', 'tel', 'password'];

  let role: string | null = null;
  const attrRole = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0] ?? '';
  if (attrRole !== '') role = attrRole;
  else if (tag === 'button') role = 'button';
  else if (tag === 'a' && el.hasAttribute('href')) role = 'link';
  else if (tag === 'input') role = type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : textTypes.includes(type) ? 'textbox' : null;
  else if (tag === 'textarea') role = 'textbox';
  else if (tag === 'select') role = 'combobox';
  else if (/^h[1-6]$/.test(tag)) role = 'heading';

  // 名字：aria-label，再是关联 label 的文本，再是（只有按钮、链接、标题）自身文本，要单行且不超过 80 个字符。
  let name: string | null = null;
  const aria = norm(el.getAttribute('aria-label') ?? '');
  if (aria !== '') {
    name = aria;
  } else {
    const labels = 'labels' in el ? Array.from((el as HTMLInputElement).labels ?? []) : [];
    const labelText = norm(labels.map((l) => l.textContent ?? '').join(' '));
    if (labelText !== '') {
      name = labelText;
    } else if (role === 'button' || role === 'link' || role === 'heading') {
      const own = ((el as HTMLElement).innerText ?? '').trim();
      if (own !== '' && own.length <= 80 && !/[\r\n]/.test(own)) name = own;
    }
  }

  // css 路径：从最近的带 id 的祖先（没有就从 body）起，用 标签:nth-of-type(n) 连下来。
  let cssPath: string;
  if (el === document.documentElement) {
    cssPath = 'html';
  } else if (el === document.body) {
    cssPath = 'body';
  } else {
    const parts: string[] = [];
    let anchor = '';
    let cur: Element | null = el;
    while (cur !== null && cur !== document.body) {
      if (cur !== el && cur.id !== '') {
        anchor = '#' + CSS.escape(cur.id);
        break;
      }
      let n = 1;
      for (let sib = cur.previousElementSibling; sib !== null; sib = sib.previousElementSibling) if (sib.localName === cur.localName) n++;
      parts.unshift(`${cur.localName}:nth-of-type(${n})`);
      cur = cur.parentElement;
    }
    if (anchor === '' && cur === document.body) anchor = 'body';
    cssPath = (anchor === '' ? parts : [anchor, ...parts]).join(' > ');
  }

  // fill 实际会填的元素：照 Playwright 的 follow-label 重定向算。目标不是 input、textarea、select 或 contenteditable 时，
  // 先换成最近的按钮类祖先；还不是可交互的控件，就换成所在 <label> 的 control。所以 label、label 里的文字、
  // text=… 选中的文字，实际填的都是那个 label 关联的输入框。isPassword 和 kind 都按这个元素判断。
  let filled: Element = el;
  if (!el.matches('input, textarea, select') && (el as HTMLElement).isContentEditable !== true) {
    filled = el.closest('button, [role=button], [role=checkbox], [role=radio]') ?? el;
  }
  if (!filled.matches('a, input, textarea, button, select, option, optgroup, [role=link], [role=button], [role=checkbox], [role=radio]')
      && (filled as HTMLElement).isContentEditable !== true) {
    const control = filled.closest('label')?.control;
    if (control) filled = control;
  }
  // 往保守处判：type=password，或 autocomplete 里有密码类的词（「显示密码」之后的输入框常是 type=text 加 current-password）。
  const looksPassword = (e: Element | null | undefined): boolean => e !== null && e !== undefined && (
    (e instanceof HTMLInputElement && e.type === 'password')
    || (e.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).some((t) => t === 'current-password' || t === 'new-password' || t === 'one-time-code'));

  return {
    info: { testId: el.getAttribute('data-testid'), id: el.id === '' ? null : el.id, role, name, cssPath },
    // 目标本身、实际会填的元素、目标所在 label 的 control，任何一个像密码框都算密码框。
    isPassword: looksPassword(el) || looksPassword(filled) || looksPassword(el.closest('label')?.control),
    // 只有这两类认得出的输入框是 text-input / textarea；contenteditable、role=textbox 等一律 other。
    kind: filled instanceof HTMLTextAreaElement ? 'textarea'
      : filled instanceof HTMLInputElement && ['text', 'email', 'search', 'tel', 'url', 'number'].includes(filled.type) ? 'text-input'
        : 'other',
  };
}

// 实例对页面开放的那一小块：页面登记、弹窗列表。
// 在页面里观察 quiet 毫秒：这期间有任何 DOM 变动（主文档，含子树、属性、文字）就返回 false，安静到时返回 true。
// 不管哪种结果，observer 都先 disconnect 再返回；到时的定时器也在，页面没有任何东西要回调内核。
// 作为函数交给 page.evaluate 序列化，所以必须自成一体。
export function observeQuietWindow(quiet: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (isQuiet: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      resolve(isQuiet);
    };
    const observer = new MutationObserver(() => finish(false));
    try {
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => finish(true), quiet);
  });
}

// 等 work，最多 ms 毫秒；到点还没完就当「这一轮没成」（false），work 之后的结果或错误都丢掉。
async function raceDeadline(work: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  work.catch(() => {});
  try {
    return await Promise.race([work, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// idle 等待看的一页的请求动态：进行中的个数、一个只增不减的活动序号（每个请求开始或结束加一）、进行中的前几个 URL。
export interface IdleState { count: number; seq: number; urls: string[] }

interface Host {
  popupsOf(pageId: string): string[];
  idleState(page: PwPage): IdleState;
  reportError(e: unknown): void;
  readonly actionTimeoutMs: number;
}

class PlaywrightPage implements Page {
  readonly id: string;
  readonly page: PwPage;
  openerId: string | null = null;
  // 别处开出来的页：开启者查完（并通知了 onPageOpened）之后才 resolve。openPage 开的页一开始就是 resolve 的。
  ready: Promise<void> = Promise.resolve();
  closed = false;
  webSockets = 0;
  private notified = false;
  // 触屏模拟的 CDP 会话：只属于这一页，页关时 detach（会话一 detach，模拟就失效，所以开着直到页关）。
  private touchSession: CDPSession | undefined;
  private readonly closedListeners: (() => void)[] = [];
  private readonly host: Host;
  private readonly onGone: (p: PlaywrightPage) => void;
  private readonly onNotified: (p: PlaywrightPage) => void;

  constructor(host: Host, id: string, page: PwPage, onGone: (p: PlaywrightPage) => void, onNotified: (p: PlaywrightPage) => void) {
    this.host = host;
    this.id = id;
    this.page = page;
    this.onGone = onGone;
    this.onNotified = onNotified;
    page.on('close', () => this.markClosed());
    page.on('websocket', () => { this.webSockets++; });
  }

  onClosed(listener: () => void): void {
    this.closedListeners.push(listener);
  }

  // 任何一种关闭（人关的、页面自己关的、浏览器没了、调用方 close()）都走这里。
  // 状态马上置为已关，但 onClosed 的触发推迟一个宏任务：浏览器没了的时候 Playwright 先发页面的 close、
  // 紧接着（同一个宏任务里）发 context 的 close，推迟之后才分得清「只关了一页」和「浏览器没了」。
  // 后一种情形由实例的 handleClosed 先把实例置为已关，再同步冲刷各页的通知（flushClosed），所以页面监听器里
  // health() 已经是 ok: false，和 fake 驱动一致。每页的通知只触发一次。
  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const touch = this.touchSession;
    this.touchSession = undefined;
    if (touch !== undefined) touch.detach().catch(() => { /* 页关时 Playwright 多半已经断开会话 */ });
    this.onGone(this);
    setImmediate(() => this.flushClosed());
  }

  // 触发这页的 onClosed 监听器（只一次）；之后不再等推迟的那次。
  flushClosed(): void {
    if (this.notified) return;
    this.notified = true;
    this.onNotified(this);
    emit((e) => this.host.reportError(e), this.closedListeners);
  }

  // 打开按页的触屏模拟（Chromium 的 CDP）：`(pointer: coarse)`、`maxTouchPoints`、触摸事件。
  // 失败关闭：发了命令也要实测 `(pointer: coarse)` 真的成立，否则报错，由调用方关掉这一页。
  async enableTouch(context: BrowserContext): Promise<void> {
    this.touchSession = await context.newCDPSession(this.page);
    await this.sendTouch();
    if ((await this.page.evaluate(`matchMedia('(pointer: coarse)').matches`)) !== true) throw new DriverError('other', 'touch emulation is not available');
  }

  private async sendTouch(): Promise<void> {
    await this.touchSession?.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: TOUCH_POINTS });
  }

  // diagnose 给了目标时，动作失败会尽力带上诊断（hints）：选择器匹配了好几个、或点击被别的元素挡住。
  // 诊断本身出任何错（包括卡住）都不能盖掉原来的错误：那时只给原错误。
  private async run<T>(fn: () => Promise<T>, diagnose?: Target): Promise<T> {
    if (this.closed) throw new DriverError('other', 'page is closed');
    try {
      return await fn();
    } catch (e) {
      const err = mapError(e);
      if (diagnose === undefined || e instanceof DriverError || !(e instanceof Error)) throw err;
      throw new DriverError(err.kind, err.message, await this.diagnose(diagnose, e.message));
    }
  }

  private diagnose(target: Target, message: string): Promise<string[]> {
    return guardedHints(() => this.collectHints(target, message), DIAGNOSE_TIMEOUT_MS);
  }

  private async collectHints(target: Target, message: string): Promise<string[]> {
    const hints: string[] = [];
    if ((message.split('\n')[0] ?? '').includes(STRICT_VIOLATION)) {
      const loc = locate(this.page, target);
      hints.push(`共 ${await loc.count()} 个匹配`);
      const found = await loc.evaluateAll(describeCandidates, MAX_CANDIDATES);
      found.forEach((c, i) => {
        const name = c.name === '' ? '' : ` "${c.name}"`;
        // 可写的选择器和位置放在名字前面：名字很长时，内核截断丢掉的是名字的尾巴。
        hints.push(`${i + 1}) 可写 ${target} >> nth=${i} · ${c.role === '' ? c.tag : c.role} @(${c.x},${c.y} ${c.w}x${c.h})${name}`.slice(0, MAX_HINT_CHARS));
      });
    }
    const covered = interceptHint(message);
    if (covered !== null) hints.push(covered);
    return hints.slice(0, MAX_HINTS);
  }

  location(): Promise<PageLocation> {
    return this.run(async () => {
      let title = '';
      try {
        title = await this.page.title();
      } catch { /* 正在导航时取不到标题，当作空 */ }
      const main = this.page.mainFrame();
      const frames = this.page.frames().filter(f => f !== main).map(f => ({ url: f.url(), name: f.name() }));
      return { url: this.page.url(), title, frames, popups: this.host.popupsOf(this.id), webSockets: this.webSockets };
    });
  }

  // 目标翻译之后确认有这个元素，没有就是 not-found。
  // wait 为真（动作：click、hover、fill、press、scroll）时最多等 actionTimeoutMs 让它出现在 DOM 里，等不到才是 not-found；
  // 为假（text、describe）时不等，数一数就定。
  // 匹配多个时交给 Playwright 的严格模式：动作不会悄悄落在第一个上，那样的错归 other。
  private async resolve(target: Target, wait: boolean): Promise<Locator> {
    const loc = locate(this.page, target);
    if (!wait) {
      if ((await loc.count()) === 0) throw new DriverError('not-found', 'element not found');
      return loc;
    }
    try {
      await loc.first().waitFor({ state: 'attached', timeout: this.host.actionTimeoutMs });
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') throw new DriverError('not-found', 'element not found');
      throw e;
    }
    return loc;
  }

  snapshot(o: { depth?: number }): Promise<string> {
    return this.run(() => this.page.ariaSnapshot(o.depth === undefined ? { mode: 'ai' } : { mode: 'ai', depth: o.depth }));
  }

  text(o: { target?: Target }): Promise<string> {
    return this.run(async () => {
      if (o.target === undefined) return await this.page.evaluate(() => document.body?.innerText ?? '');
      return await (await this.resolve(o.target, false)).first().innerText();
    }, o.target);
  }

  async screenshot(o: { path: string; fullPage: boolean; format?: 'jpeg' | 'png'; target?: Target; mask?: Target[]; maskColor?: string }): Promise<void> {
    await this.run(async () => {
      // 失败关闭：每个遮罩目标至少要匹配一个元素，否则不截图（Playwright 对匹配不到的遮罩是悄悄跳过，图上就有没盖住的内容）。
      for (const [i, t] of (o.mask ?? []).entries()) {
        if ((await locate(this.page, t).count()) === 0) throw new DriverError('not-found', `mask[${i}] matched no element`);
      }
      const opts = {
        path: o.path, scale: 'css' as const,
        ...((o.format ?? 'jpeg') === 'png' ? { type: 'png' as const } : { type: 'jpeg' as const, quality: 60 }),
        ...(o.mask === undefined ? {} : { mask: o.mask.map((t) => locate(this.page, t)) }),
        ...(o.maskColor === undefined ? {} : { maskColor: o.maskColor }),
      };
      if (o.target !== undefined) await (await this.resolve(o.target, false)).screenshot(opts);
      else await this.page.screenshot({ ...opts, fullPage: o.fullPage });
    }, o.target);
    // 实测截图不会重置触屏模拟；为防 Playwright 或 Chromium 版本变化（captureBeyondViewport），仍尽力重发一次。
    // 尽力而为：图已经写好，重发失败不能让这次截图的结果变成失败。
    await this.sendTouch().catch(() => {});
  }

  console(): Promise<{ level: string; text: string }[]> {
    return this.run(async () => (await this.page.consoleMessages()).map((m) => ({ level: m.type(), text: m.text() })));
  }

  click(target: Target): Promise<void> {
    return this.run(async () => { await (await this.resolve(target, true)).click(); }, target);
  }

  hover(target: Target): Promise<void> {
    return this.run(async () => { await (await this.resolve(target, true)).hover(); }, target);
  }

  fill(target: Target, value: string): Promise<void> {
    return this.run(async () => { await (await this.resolve(target, true)).fill(value); }, target);
  }

  press(key: string, target?: Target): Promise<void> {
    return this.run(async () => {
      if (target === undefined) await this.page.keyboard.press(key);
      else await (await this.resolve(target, true)).press(key);
    }, target);
  }

  // 有目标就滚到它可见；没有目标就让页面按 dx、dy 滚动。
  // 页面滚动用页内同步的 scrollBy（behavior: 'instant'），返回时 scrollX/scrollY 已经到位；
  // 不用 mouse.wheel：它在滚动落地之前就返回了。
  scroll(o: { target?: Target; dx?: number; dy?: number }): Promise<void> {
    return this.run(async () => {
      if (o.target !== undefined) await (await this.resolve(o.target, true)).scrollIntoViewIfNeeded();
      else await this.page.evaluate(([dx, dy]) => { window.scrollBy({ left: dx, top: dy, behavior: 'instant' }); }, [o.dx ?? 0, o.dy ?? 0]);
    }, o.target);
  }

  goto(url: string): Promise<void> {
    return this.run(async () => { await this.page.goto(url); });
  }

  setViewport(v: Viewport): Promise<void> {
    return this.run(() => this.page.setViewportSize({ width: v.width, height: v.height }));
  }

  waitFor(cond: WaitCond, timeoutMs: number): Promise<void> {
    return this.run(async () => {
      if ('text' in cond) {
        await this.page.waitForFunction((t: string) => (document.body?.innerText ?? '').includes(t), cond.text, { timeout: timeoutMs, polling: 100 });
      } else if ('target' in cond) {
        await locate(this.page, cond.target).first().waitFor({ state: cond.state, timeout: timeoutMs });
      } else if ('urlContains' in cond) {
        // 子串判断，不用通配也不用正则；commit 就够了（单页应用的 pushState 也算）。
        await this.page.waitForURL((u) => u.href.includes(cond.urlContains), { timeout: timeoutMs, waitUntil: 'commit' });
      } else if ('idle' in cond) {
        await this.waitIdle(cond.idle, timeoutMs);
      } else {
        await this.page.waitForTimeout(cond.ms);
      }
    });
  }

  // 「安静」：这一页没有进行中的请求（不算 eventsource），在 quiet 毫秒里没有请求开始或结束，主文档也没有 DOM 变动。
  // 循环：先等进行中的请求归零；再在页面里观察 quiet 毫秒（一有变动就返回，重新来过）；最后核对这期间没有请求活动。
  // 观察只在 quiet 毫秒之内：窗口放得下才开，所以不会跑过截止时间；observer 在变动、到时、出错三种情形下都先 disconnect，
  // 导航把执行环境销毁时 observer 随环境一起没了，这一轮重试。页面里不留任何回调或全局。
  private async waitIdle(quiet: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.closed || this.page.isClosed()) throw new DriverError('other', 'page is closed');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DriverError('timeout', 'page did not become idle', this.host.idleState(this.page).urls);
      const before = this.host.idleState(this.page);
      if (before.count > 0 || remaining < quiet) {
        await sleep(Math.min(IDLE_POLL_MS, remaining));
        continue;
      }
      let quietWindow = false;
      try {
        quietWindow = await raceDeadline(this.page.evaluate(observeQuietWindow, quiet), remaining);
      } catch (e) {
        if (this.closed || this.page.isClosed()) throw mapError(e);
        // 一律当作导航销毁了执行环境（或页面还在加载）：这一轮作废，重试。持久的错误只会表现为超时（失败关闭）。
        await sleep(IDLE_POLL_MS);
        continue;
      }
      const after = this.host.idleState(this.page);
      if (quietWindow && after.count === 0 && after.seq === before.seq) return;
    }
  }

  // read 不等待：text、css 目标不存在立刻 not-found；count 给 0；visible 给 false。
  read(q: { kind: AssertKind; target?: Target; property?: string }): Promise<string | number | boolean> {
    return this.run(async () => {
      if (q.kind === 'url') return this.page.url();
      if (q.target === undefined) throw new DriverError('other', `read ${q.kind} needs a target`);
      const loc = locate(this.page, q.target);
      if (q.kind === 'count') return await loc.count();
      if (q.kind === 'visible') return await loc.first().isVisible();
      if ((await loc.count()) === 0) throw new DriverError('not-found', 'element not found');
      if (q.kind === 'text') return (await loc.first().innerText()).trim();
      if (q.property === undefined) throw new DriverError('other', 'read css needs a property');
      return await loc.first().evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), q.property);
    });
  }

  evaluate(js: string): Promise<unknown> {
    return this.run(() => this.page.evaluate(js));
  }

  // 选择器写法的目标原样返回（via: 'given'）；引用要找出一个稳定的选择器（设计 5.8）：
  // 在 iframe 里的引用（f 开头）先不解析；其余按 testid → id → role → css 逐个验证，
  // 第一个「匹配数正好是 1，且就是这个元素」的就是结果，都不行就是 null。元素找不到抛 not-found。
  describe(target: Target): Promise<Described> {
    return this.run(async () => {
      const loc = (await this.resolve(target, false)).first();
      const { info, isPassword, kind } = await loc.evaluate(collectElementInfo);
      if (!isRef(target)) return { stable: { selector: target, via: 'given' as const }, isPassword, kind };
      if (target.startsWith('f')) return { stable: null, isPassword, kind };
      return { stable: await this.firstStable(loc, info), isPassword, kind };
    });
  }

  // 主 frame（不进 iframe）里有没有可见的登录用密码类字段。用 locator 数：跑在 Playwright 自己的隔离环境里，
  // 页面改写不了 DOM 的方法，CSS 选择器默认穿透 open shadow root。数不出（页面关了、导航中断）抛 DriverError，由内核当「没有」。
  hasVisiblePasswordField(): Promise<boolean> {
    return this.run(async () => (await this.page.locator(LOGIN_WALL_SELECTOR).filter({ visible: true }).count()) > 0);
  }

  hasPasswordLikeField(): Promise<PasswordProbe> {
    return this.run(() => probePageForPasswordField(this.page));
  }

  private async firstStable(loc: Locator, info: ElementInfo): Promise<Stable | null> {
    const handle = await loc.elementHandle();
    try {
      for (const candidate of stableCandidates(info)) {
        try {
          const found = locate(this.page, candidate.selector);
          if ((await found.count()) !== 1) continue;
          if (await found.evaluate((el, same) => el === same, handle)) return candidate;
        } catch { /* 这个候选写不成可用的选择器，试下一个 */ }
      }
      return null;
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.closed) throw new DriverError('other', 'page is already closed');
    try {
      await this.page.close();
    } catch (e) {
      throw mapError(e);
    }
    this.markClosed();
    this.flushClosed();   // 调用方自己关的：在 close() 返回之前通知，和 fake 一致
  }
}

class PlaywrightInstance implements Instance, Host {
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly proc: BrowserProcess;                  // 自己 spawn 的浏览器进程：关闭、意外退出都由它结束，只碰这一个
  private browserSession: CDPSession | undefined;         // browser 级的 CDP 会话：开页（Target.createTarget）和优雅关闭用
  private readonly counters: Counters;
  private readonly anchors: ReadonlySet<PwPage>;        // 启动时自带的空白页：窗口的锚，不算任何会话的页面
  private readonly byPage = new WeakMap<PwPage, PlaywrightPage>();
  private readonly open = new Set<PlaywrightPage>();
  private readonly closing = new Set<PlaywrightPage>();   // 已关、onClosed 还没触发的页
  private readonly requestIds = new WeakMap<PwRequest, string>();
  private readonly requestsDone = new WeakSet<PwRequest>();
  // idle 等待用的「进行中的请求」：单独维护，和 requestsDone（路由里登记过的请求）无关——重定向的后续跳不进路由。
  // request 事件加一，requestfinished / requestfailed 减一；Set 天然去重，settled 挡住先到的完成事件之后才来的 request。
  private readonly inFlight = new WeakMap<PwPage, { active: Set<PwRequest>; seq: number }>();
  private readonly flightPage = new WeakMap<PwRequest, PwPage>();
  private readonly settled = new WeakSet<PwRequest>();
  // 已经发起、还没提交（也没失败或结束）的导航：frame → 发起它的请求和时间。给密码框探测用，见 probePasswordField。
  private readonly navigating = new WeakMap<Frame, { request: PwRequest; at: number }>();
  private readonly reportListenerError: (e: unknown) => void;
  private readonly closedListeners: (() => void)[] = [];
  private readonly requestDoneListeners: ((e: { id: string; status: number | null; failed: boolean; redirectRefused?: true }) => void)[] = [];
  private readonly pageOpenedListeners: ((page: Page, openerId: string | null) => void)[] = [];
  private readonly navigationHopListeners: ((e: { pageId: string; url: string }) => void)[] = [];
  private handler: ((r: RequestInfo) => Decision | Promise<Decision>) | undefined;
  private closed = false;
  private stopping: Promise<void> | undefined;
  // openPage 进行中的个数，和这期间 context 的 page 事件里先到的页：
  // 事件比 createTarget 的返回早，得等认出哪一页（按 targetId）是自己开的才能登记。
  private opening = 0;
  private readonly deferred = new Set<PwPage>();
  private readonly arrivals = new Set<() => void>();   // 在等「有新页出现」的 openPage

  readonly actionTimeoutMs: number;

  constructor(browser: Browser, context: BrowserContext, proc: BrowserProcess, counters: Counters, reportListenerError: (e: unknown) => void, actionTimeoutMs: number) {
    this.actionTimeoutMs = actionTimeoutMs;
    this.browser = browser;
    this.context = context;
    this.proc = proc;
    this.counters = counters;
    this.reportListenerError = reportListenerError;
    this.anchors = new Set(context.pages());
  }

  // 把事件和路由接上。launch 在返回实例之前调用。
  async attach(): Promise<void> {
    this.browserSession = await this.browser.newBrowserCDPSession();
    this.context.on('close', () => this.handleClosed());
    this.browser.on('disconnected', () => this.handleClosed());
    void this.proc.exited.then(() => this.handleClosed());   // 浏览器进程没了（人按了 Cmd-Q、崩了）：管道断开通常先到，这里兜底
    this.context.on('page', (p) => {
      if (this.opening > 0) this.deferred.add(p);
      else this.register(p, false);
      for (const wake of [...this.arrivals]) wake();
    });
    // 响应头一到就算这个请求有了结果：只发出去不读响应体的请求（信标式的 fetch）不会触发 requestfinished，
    // 页面一跳转还会被报成 requestfailed。所以以 response 事件为准，requestfinished 和 requestfailed 只补没有响应的情形。
    this.context.on('response', (r) => { this.requestDone(r.request(), r.status(), false); });
    // idle 的「请求结束」同样以响应头为准（理由同上：不读响应体的 fetch 不会触发 requestfinished），先到的事件为准。
    this.context.on('request', (r) => { this.flightStarted(r); void this.navigationHop(r); });
    this.context.on('response', (r) => { this.flightEnded(r.request()); });
    this.context.on('requestfinished', (r) => { this.flightEnded(r); this.navigationEnded(r); void this.requestFinished(r); });
    this.context.on('requestfailed', (r) => { this.flightEnded(r); this.navigationEnded(r); this.requestDone(r, null, true); });
    // SharedWorker 发出的请求不经 context.route（docs/m0-findings.md §9.9），所以在所有页面、所有 frame 里把构造函数删掉；
    // 要赶在路由之前装好，页面脚本才碰不到它。
    await this.context.addInitScript('try { delete globalThis.SharedWorker; } catch (e) {}');
    // Service Worker 同样绕过路由：把注册禁掉（原来由 launchPersistentContext 的 serviceWorkers: 'block' 做）。
    await this.context.addInitScript(BLOCK_SERVICE_WORKERS_SCRIPT);
    await this.context.route('**/*', (route) => this.handleRoute(route));
  }

  async health(): Promise<Check> {
    return { name: 'browser', ok: !this.closed, detail: this.closed ? 'browser is closed' : 'browser is running' };
  }

  stop(): Promise<void> {
    if (this.stopping === undefined) {
      this.stopping = (async () => {
        try {
          // 先请浏览器自己退（会把 cookie 等落盘），再断管道；超时或失败都不要紧，terminate 会兜底。
          await this.browserSession?.send('Browser.close', undefined, { timeout: BROWSER_CLOSE_TIMEOUT_MS }).catch(() => {});
          await this.browser.close();
        } catch (e) {
          // 已经没了就算停成功；否则把失败交出去，并允许再试。
          if (!this.closed && !this.proc.hasExited()) {
            this.stopping = undefined;
            throw mapError(e);
          }
        }
        await this.proc.terminate();   // 只结束自己 spawn 的那个进程
        this.handleClosed();
      })();
    }
    return this.stopping;
  }

  onClosed(listener: () => void): void {
    this.closedListeners.push(listener);
  }

  setRequestHandler(h: (r: RequestInfo) => Decision | Promise<Decision>): void {
    this.handler = h;
  }

  onRequestDone(listener: (e: { id: string; status: number | null; failed: boolean; redirectRefused?: true }) => void): void {
    this.requestDoneListeners.push(listener);
  }

  onNavigationHop(listener: (e: { pageId: string; url: string }) => void): void {
    this.navigationHopListeners.push(listener);
  }

  // 只清这个主机自己的 cookie：域名恰好是 host 或 .host（带 Domain 属性设下的）。Playwright 的字符串过滤是全等比较，
  // 认不出 .host，所以用正则；上级域的 cookie 是同站点别的主机共用的，不碰。
  async clearCookies(host: string): Promise<void> {
    if (this.closed) throw new DriverError('other', 'browser is closed');
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      await this.context.clearCookies({ domain: new RegExp(`^\\.?${escaped}$`, 'i') });
    } catch (e) {
      throw mapError(e);
    }
  }

  async addInitScript(source: string): Promise<void> {
    if (this.closed) throw new DriverError('other', 'browser is closed');
    try {
      await this.context.addInitScript(source);
    } catch (e) {
      throw mapError(e);
    }
  }

  onPageOpened(listener: (page: Page, openerId: string | null) => void): void {
    this.pageOpenedListeners.push(listener);
  }

  // 开页：browser 级 Target.createTarget（会话页 background: true，登录窗口 foreground: true 即 background: false），不调 context.newPage()（它会让浏览器抢前台，docs/m0-findings.md §7.3）。
  // 新页由 page 事件到达，按创建时的一次性随机标记认领（见 createPage）：同时有弹窗或另一个 openPage 也不会认错。
  async openPage(o: { viewport?: Viewport; touch?: boolean; foreground?: true }): Promise<Page> {
    if (this.closed) throw new DriverError('other', 'browser is closed');
    this.opening++;
    let own: PlaywrightPage;
    try {
      const p = await this.createPage(o.foreground === true);
      this.deferred.delete(p);
      own = this.register(p, true) as PlaywrightPage;
    } catch (e) {
      throw mapError(e);
    } finally {
      this.opening--;
      if (this.opening === 0) {
        for (const p of this.deferred) this.register(p, false);
        this.deferred.clear();
      }
    }
    const viewport = o.viewport ?? DEFAULT_VIEWPORT;
    try {
      await own.page.setViewportSize({ width: viewport.width, height: viewport.height });
    } catch (e) {
      await own.close().catch(() => {});
      throw mapError(e);
    }
    if (o.touch === true) {
      try {
        await own.enableTouch(this.context);
      } catch (e) {
        await own.close().catch(() => {});
        throw mapError(e);
      }
    }
    return own;
  }

  // 认领是确定性的：createTarget 的起始地址带一个这次创建专用的随机一次性标记（128 位，about:blank#e2k-<hex>），
  // 只认 url() 恰好等于它的页。页面脚本不知道这个值，所以别的会话的页开出的窗口（哪怕空白、哪怕开启者已经关了）
  // 怎么出现都不会被认走；随机值不进日志、报告，也不出这个函数。
  // 不对候选页建 CDP 会话去问 targetId（会和触屏用例的会话计数冲突，且要给还在初始化的页附加会话）。
  // 认领之后马上用 history.replaceState 把地址改回干净的 about:blank：带 # 的地址会让第一次导航被 Playwright 当成「换了文档」，
  // 主 frame 的快照引用从此带 f 前缀（被当成 iframe 引用）；replaceState 是同文档导航，不动帧序号。
  private async createPage(foreground: boolean): Promise<PwPage> {
    const session = this.browserSession;
    if (session === undefined) throw new DriverError('other', 'browser is not attached');
    const marker = `about:blank#e2k-${randomBytes(16).toString('hex')}`;
    const { targetId } = await session.send('Target.createTarget', createTargetParams(marker, foreground));
    const deadline = Date.now() + OPEN_PAGE_TIMEOUT_MS;
    try {
      for (;;) {
        if (this.closed) throw new DriverError('other', 'browser is closed');
        const found = this.context.pages().find((cand) => !this.byPage.has(cand) && !this.anchors.has(cand) && cand.url() === marker);
        if (found !== undefined) {
          const cleaned = found.evaluate(`history.replaceState(null, '', 'about:blank')`).then(() => true, () => false);
          if (!(await raceDeadline(cleaned, PAGE_READY_TIMEOUT_MS))) throw new DriverError('timeout', 'the new page did not become ready');
          return found;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new DriverError('timeout', 'the new page did not appear');
        await new Promise<void>((resolve) => {
          const wake = (): void => { clearTimeout(timer); this.arrivals.delete(wake); resolve(); };
          const timer = setTimeout(wake, Math.min(left, OPEN_PAGE_POLL_MS));
          this.arrivals.add(wake);
        });
      }
    } catch (e) {
      await session.send('Target.closeTarget', { targetId }).catch(() => {});   // 开出来了但没认到：别留一个没人管的页
      throw e;
    }
  }

  reportError(e: unknown): void {
    this.reportListenerError(e);
  }

  idleState(page: PwPage): IdleState {
    const flight = this.inFlight.get(page);
    if (flight === undefined) return { count: 0, seq: 0, urls: [] };
    return { count: flight.active.size, seq: flight.seq, urls: [...flight.active].slice(0, IDLE_MAX_URLS).map((r) => r.url().slice(0, MAX_HINT_CHARS)) };
  }

  // 一个请求开始：记在发它的那一页名下（request.frame() 抛错，比如 service worker 的请求，就不算）。
  // eventsource 是长连接，不算；页面已经关了的也不算。
  private flightStarted(request: PwRequest): void {
    if (this.settled.has(request) || this.flightPage.has(request)) return;
    try {
      if (request.resourceType() === 'eventsource') return;
      const page = request.frame().page();
      if (page.isClosed()) return;
      let flight = this.inFlight.get(page);
      if (flight === undefined) {
        flight = { active: new Set(), seq: 0 };
        this.inFlight.set(page, flight);
      }
      flight.active.add(request);
      flight.seq++;
      this.flightPage.set(request, page);
    } catch { /* 归属不明：不计入 */ }
  }

  private flightEnded(request: PwRequest): void {
    if (this.settled.has(request)) return;
    this.settled.add(request);
    const page = this.flightPage.get(request);
    if (page === undefined) return;
    const flight = this.inFlight.get(page);
    if (flight !== undefined && flight.active.delete(request)) flight.seq++;
  }

  popupsOf(pageId: string): string[] {
    return [...this.open].filter(w => w.openerId === pageId).map(w => w.page.url());
  }

  // 浏览器没了（被关、崩了、自己 stop）：先把实例置为已关，再让每个页触发 onClosed（包括 Playwright 已经先关掉、
  // 通知还在等的页），最后触发实例的，各一次。页面监听器里 health() 已经是 ok: false。
  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    void this.proc.terminate();   // 管道断了但进程还在的情形：不留带登录态的浏览器
    this.browserSession?.detach().catch(() => {});
    for (const w of [...this.open]) w.markClosed();
    for (const w of [...this.closing]) w.flushClosed();
    emit(this.reportListenerError, this.closedListeners);
  }

  // 页面第一次出现时登记：同步分配 id 和登记，开启者随后异步查。返回 null 表示是启动时的锚页，不登记。
  private register(p: PwPage, own: boolean): PlaywrightPage | null {
    if (this.anchors.has(p)) return null;
    const existing = this.byPage.get(p);
    if (existing !== undefined) return existing;
    const w = new PlaywrightPage(this, `p${++this.counters.page}`, p, (gone) => { this.open.delete(gone); this.closing.add(gone); }, (done) => { this.closing.delete(done); });
    this.byPage.set(p, w);
    this.open.add(w);
    p.on('framenavigated', (f) => { this.navigating.delete(f); });
    p.on('close', () => { this.inFlight.delete(p); });
    if (p.isClosed()) {
      w.markClosed();
    } else if (!own) {
      w.ready = this.announce(w);
    }
    return w;
  }

  // 主 frame 导航被重定向之后的每一跳（redirectedFrom 不为空的导航请求；首跳走路由）：通知 onNavigationHop。
  // 认不出是哪一页（拿不到 frame：弹窗的第一个导航，Playwright 说「frame 还没创建」；是启动时的锚页）、不是主 frame 的，不通知；
  // 弹窗里的重定向落到别的组，靠弹窗之后的请求带着的顶层地址兜底（decideForSession）。先等页面登记完（别处开出来的页要查开启者），
  // 这样内核收到时已经认得这一页。
  private async navigationHop(request: PwRequest): Promise<void> {
    try {
      if (request.redirectedFrom() === null || !request.isNavigationRequest()) return;
      const frame = request.frame();
      if (frame.parentFrame() !== null) return;
      const w = this.register(frame.page(), false);
      if (w === null) return;
      await w.ready;
      if (this.closed) return;
      emit(this.reportListenerError, this.navigationHopListeners, { pageId: w.id, url: request.url() });
    } catch { /* 拿不到 frame（弹窗的第一个导航还没有 frame）或页面已经没了：认不出归属，不通知 */ }
  }

  // 查开启者，再通知 onPageOpened。开启者自己也是没见过的页时，先把它也登记上。
  private async announce(w: PlaywrightPage): Promise<void> {
    try {
      const opener = await w.page.opener();
      w.openerId = opener === null ? null : (this.register(opener, false)?.id ?? null);
    } catch {
      w.openerId = null;   // 页已经没了或查不到，当作没有开启者
    }
    if (w.closed || this.closed) return;
    emit(this.reportListenerError, this.pageOpenedListeners, w, w.openerId);
  }

  // 导航请求一到就登记，frame 提交了新文档（framenavigated）、这个请求失败或结束就撤掉；超过 10 秒的登记当作过期
  // （下载、204 之类不提交文档的导航），免得一直把这个 frame 当成在导航。
  private isNavigating(frame: Frame): boolean {
    const now = Date.now();
    return [frame, frame.page().mainFrame()].some((f) => {
      const n = this.navigating.get(f);
      return n !== undefined && now - n.at < NAVIGATION_PENDING_MS;
    });
  }

  private navigationEnded(request: PwRequest): void {
    try {
      const f = request.frame();
      if (this.navigating.get(f)?.request === request) this.navigating.delete(f);
    } catch { /* 拿不到 frame：没有登记可撤 */ }
  }

  // 请求 → RequestInfo。归属判断不出来（request.frame() 抛错）时 pageId、openerPageId、topUrl 都是 null。
  // topUrl（内核拿它的主机去定模式，空就退回请求自己的地址）：
  // - 顶层框架的导航请求：就是请求自己的地址，即正要打开的那份文档；
  // - 其他请求：请求发出时那一页顶层文档的地址，但只认 http: 和 https:，
  //   about:blank、data:、chrome-error: 之类一律 null，让内核退回请求的地址；
  // - request.frame() 抛错：null。
  // initiatorUrl：请求发出时主框架已提交的地址（只认 http(s)，否则 null），顶层导航里它是「将被替换的那份文档」；其他请求和 topUrl 一样。
  private async describeRequest(request: PwRequest): Promise<RequestInfo> {
    const isNavigation = request.isNavigationRequest();
    let pageId: string | null = null;
    let openerPageId: string | null = null;
    let topUrl: string | null = null;
    let initiatorUrl: string | null = null;
    let topFrame = isNavigation;
    let fromLoginForm: boolean | null = null;
    let urlsAtStart: string[] = [];
    const post = request.postDataBuffer();
    try {
      const frame: Frame = request.frame();
      const pwPage = frame.page();
      urlsAtStart = frameUrls(frame);
      if (isNavigation) this.navigating.set(frame, { request, at: Date.now() });
      topFrame = frame.parentFrame() === null;
      initiatorUrl = httpUrlOrNull(pwPage.mainFrame().url());   // 路由回调里、导航提交之前：还是发起页自己的地址
      topUrl = isNavigation && topFrame ? request.url() : initiatorUrl;
      const w = this.register(pwPage, false);
      if (w !== null) {
        await w.ready;   // 请求到来时就查得到开启者：别处开出来的页，先等它登记完
        pageId = w.id;
        openerPageId = w.openerId;
      }
      // 导航请求（原生表单提交）不探测：实测顶层 frame 的导航请求在路由回调里对该 frame 做 evaluate 或 locator.count
      // 都会一直挂着（Playwright 要等导航结束，导航又在等这个回调），白白拖满 300 ms 还是 null，所以直接 null，请求体不记。
      if (post !== null && !isNavigation) fromLoginForm = await probePasswordField(frame, urlsAtStart, () => this.isNavigating(frame));
    } catch {
      pageId = null; openerPageId = null; topUrl = null; initiatorUrl = null; topFrame = isNavigation; fromLoginForm = null;
    }
    return {
      id: `r${++this.counters.request}`,
      pageId, openerPageId,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      isNavigation, topFrame, topUrl, initiatorUrl,
      contentType: request.headers()['content-type'] ?? null,
      body: post === null ? null : post.subarray(0, MAX_BODY_BYTES).toString('utf8'),
      fromLoginForm,
    };
  }

  // 回调抛错、描述请求失败、给出不认识的决定、handler 还没装上，一律中止：失败时偏向拦住。
  private async handleRoute(route: Route): Promise<void> {
    const request = route.request();
    let decision: Decision = { action: 'abort' };
    try {
      const info = await this.describeRequest(request);
      if (this.handler !== undefined) this.requestIds.set(request, info.id);
      decision = this.handler === undefined ? { action: 'abort' } : await this.handler(info);
    } catch {
      decision = { action: 'abort' };
    }
    try {
      switch (decision.action) {
        case 'continue':
          // 只有同源的请求走 route.fetch：跨源的请求经它发会绕过浏览器的 CORS 和 SameSite（route.fetch 不看 SameSite 一律附上
          // cookie，fulfill 还会替没有 ACAO 的响应补上 CORS 头），所以跨源的照常 continue，由浏览器自己发；
          // 代价是它的 307 / 308 后续跳路由看不到（README Known gaps）。
          if (decision.followRedirects === false && isSameOrigin(request)) await this.sendWithoutRedirects(route);
          else await route.continue();
          break;
        case 'fulfill':
          await route.fulfill({ status: decision.status, contentType: decision.contentType, body: decision.body });
          break;
        default:
          await route.abort();
      }
    } catch { /* 页面或浏览器在回答之前就没了，没有什么可答的了 */ }
  }

  // 放行但不跟随重定向：由 Node 代发首跳（Playwright 的路由 handler 只见重定向链的第一个 URL，后续跳绕过内核的判断）。
  // 首跳是 3xx：先通知 redirectRefused（去重以先到为准，abort 之后的 requestfailed 会被忽略），再中止。
  // fetch 抛错一律中止（失败关闭），不当成重定向：1.65.1 下 maxRedirects: 0 不抛错而是返回 3xx 响应，
  // 错误消息里又带着完整 URL，按字样判断会把 redirect_uri= 之类误报。不是 3xx：原样交给页面。
  private async sendWithoutRedirects(route: Route): Promise<void> {
    const request = route.request();
    let response: APIResponse;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: NAVIGATION_TIMEOUT_MS });
    } catch {
      await route.abort();
      return;
    }
    try {
      const status = response.status();
      if (status >= 300 && status < 400) {
        this.requestDone(request, status, true, true);
        await route.abort();
      } else {
        await route.fulfill({ response });
      }
    } finally {
      await response.dispose().catch(() => {});   // 不然响应体留在 context 里直到关闭
    }
  }

  // 每个请求只通知一次：先到的事件为准，之后的 requestfinished / requestfailed 一律忽略。
  private requestDone(request: PwRequest, status: number | null, failed: boolean, redirectRefused = false): void {
    const id = this.requestIds.get(request);
    if (id === undefined || this.requestsDone.has(request)) return;
    this.requestsDone.add(request);
    emit(this.reportListenerError, this.requestDoneListeners, redirectRefused ? { id, status, failed, redirectRefused: true } : { id, status, failed });
  }

  // 正常情况下 response 事件已经通知过了；没收到响应事件就读响应，读不到（页面没了）状态为 null。
  private async requestFinished(request: PwRequest): Promise<void> {
    if (this.requestsDone.has(request)) return;
    let status: number | null = null;
    try {
      status = (await request.response())?.status() ?? null;
    } catch { /* 页面没了，拿不到响应 */ }
    this.requestDone(request, status, false);
  }
}

class PlaywrightDriver implements Driver {
  readonly name = 'playwright';
  readonly capabilities: Capabilities = { ...CAPABILITIES };
  private readonly counters: Counters = { page: 0, request: 0 };
  private readonly reportListenerError: (e: unknown) => void;
  private readonly actionTimeoutMs: number;
  private readonly executablePath: string | undefined;

  constructor(opts: DriverOptions) {
    this.executablePath = opts.executablePath;
    this.reportListenerError = opts.onListenerError ?? rethrowAsync;
    this.actionTimeoutMs = opts.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
  }

  async selfCheck(): Promise<Check[]> {
    let path = '';
    try {
      path = chromium.executablePath();
    } catch { /* 取不到路径就当没装 */ }
    const ok = path !== '' && existsSync(path);
    return [ok
      ? { name: 'chromium-installed', ok: true, detail: 'Playwright chromium is installed' }
      : { name: 'chromium-installed', ok: false, detail: 'Playwright chromium is not installed', fix: 'npx playwright install chromium' }];
  }

  async launch(profile: { name: string; userDataDir: string }): Promise<Instance> {
    // 空串会被 Playwright 当成「用临时目录」，相对路径看当前目录：都不是调用方想要的。
    if (profile.userDataDir === '' || !isAbsolute(profile.userDataDir)) throw new DriverError('other', 'userDataDir must be an absolute path');
    // 浏览器由我们自己 spawn，管道通信（browser-process.ts）；信号归内核自己：关停时由内核停实例，不让 Playwright 或终端的信号直接打到浏览器。
    let proc: BrowserProcess;
    try {
      proc = startBrowser(this.executablePath ?? chromium.executablePath(), profile.userDataDir);
    } catch (e) {
      throw mapError(e);
    }
    let browser: Browser;
    try {
      const connecting = chromium.connectOverCDP(proc.transport, { timeout: LAUNCH_TIMEOUT_MS });
      connecting.catch(() => {});   // 先输了竞赛的那一边不报未处理的拒绝
      const early = proc.exited.then((code): never => {
        const spawnError = proc.spawnErrorCode();
        throw new DriverError('other', spawnError !== null
          ? `browser failed to start (${spawnError})`
          : `browser exited during launch (exit code ${code === null ? 'none' : code}); is another browser already using this profile?`);
      });
      early.catch(() => {});
      browser = await Promise.race([connecting, early]);
    } catch (e) {
      await proc.terminate();
      throw mapError(e);
    }
    const context = browser.contexts()[0];
    if (browser.contexts().length !== 1 || context === undefined) {
      await proc.terminate();
      throw new DriverError('other', 'unexpected browser contexts');
    }
    context.setDefaultTimeout(this.actionTimeoutMs);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const instance = new PlaywrightInstance(browser, context, proc, this.counters, this.reportListenerError, this.actionTimeoutMs);
    try {
      await instance.attach();
    } catch (e) {
      await proc.terminate();
      throw mapError(e);
    }
    return instance;
  }
}

export function createPlaywrightDriver(opts: DriverOptions = {}): Driver {
  return new PlaywrightDriver(opts);
}
