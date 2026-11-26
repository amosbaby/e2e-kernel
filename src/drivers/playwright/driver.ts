import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext, Frame, Locator, Page as PwPage, Request as PwRequest, Route } from 'playwright';
import { ACTION_TIMEOUT_MS, DriverError, NAVIGATION_TIMEOUT_MS } from '../../driver/types.ts';
import type { Capabilities, Check, Decision, Described, Driver, Instance, Page, PageLocation, RequestInfo, Stable }
  from '../../driver/types.ts';
import { isRef } from '../../shared/ops.ts';
import type { AssertKind, Target, Viewport, WaitCond } from '../../shared/ops.ts';
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
  sharesUserProfile: false,
  canHeadless: true,
  selectorDialect: 'playwright',
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 300;

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
interface Host {
  popupsOf(pageId: string): string[];
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

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new DriverError('other', 'page is closed');
    try {
      return await fn();
    } catch (e) {
      throw mapError(e);
    }
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
    });
  }

  screenshot(o: { path: string; fullPage: boolean }): Promise<void> {
    return this.run(async () => {
      await this.page.screenshot({ path: o.path, fullPage: o.fullPage, scale: 'css', type: 'jpeg', quality: 60 });
    });
  }

  console(): Promise<{ level: string; text: string }[]> {
    return this.run(async () => (await this.page.consoleMessages()).map((m) => ({ level: m.type(), text: m.text() })));
  }

  click(target: Target): Promise<void> {
    return this.run(async () => { await (await this.resolve(target, true)).click(); });
  }

  hover(target: Target): Promise<void> {
    return this.run(async () => { await (await this.resolve(target, true)).hover(); });
  }

  fill(target: Target, value: string): Promise<void> {
    return this.run(async () => { await (await this.resolve(target, true)).fill(value); });
  }

  press(key: string, target?: Target): Promise<void> {
    return this.run(async () => {
      if (target === undefined) await this.page.keyboard.press(key);
      else await (await this.resolve(target, true)).press(key);
    });
  }

  // 有目标就滚到它可见；没有目标就让页面按 dx、dy 滚动。
  // 页面滚动用页内同步的 scrollBy（behavior: 'instant'），返回时 scrollX/scrollY 已经到位；
  // 不用 mouse.wheel：它在滚动落地之前就返回了。
  scroll(o: { target?: Target; dx?: number; dy?: number }): Promise<void> {
    return this.run(async () => {
      if (o.target !== undefined) await (await this.resolve(o.target, true)).scrollIntoViewIfNeeded();
      else await this.page.evaluate(([dx, dy]) => { window.scrollBy({ left: dx, top: dy, behavior: 'instant' }); }, [o.dx ?? 0, o.dy ?? 0]);
    });
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
      } else {
        await this.page.waitForTimeout(cond.ms);
      }
    });
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
  private readonly context: BrowserContext;
  private readonly counters: Counters;
  private readonly anchors: ReadonlySet<PwPage>;        // 启动时自带的空白页：窗口的锚，不算任何会话的页面
  private readonly byPage = new WeakMap<PwPage, PlaywrightPage>();
  private readonly open = new Set<PlaywrightPage>();
  private readonly closing = new Set<PlaywrightPage>();   // 已关、onClosed 还没触发的页
  private readonly requestIds = new WeakMap<PwRequest, string>();
  private readonly requestsDone = new WeakSet<PwRequest>();
  private readonly reportListenerError: (e: unknown) => void;
  private readonly closedListeners: (() => void)[] = [];
  private readonly requestDoneListeners: ((e: { id: string; status: number | null; failed: boolean }) => void)[] = [];
  private readonly pageOpenedListeners: ((page: Page, openerId: string | null) => void)[] = [];
  private handler: ((r: RequestInfo) => Decision | Promise<Decision>) | undefined;
  private closed = false;
  private stopping: Promise<void> | undefined;
  // openPage 进行中的个数，和这期间 context 的 page 事件里先到的页：
  // 事件比 newPage 的返回早，得等 newPage 返回才分得清哪一页是自己开的。
  private opening = 0;
  private readonly deferred = new Set<PwPage>();

  readonly actionTimeoutMs: number;

  constructor(context: BrowserContext, counters: Counters, reportListenerError: (e: unknown) => void, actionTimeoutMs: number) {
    this.actionTimeoutMs = actionTimeoutMs;
    this.context = context;
    this.counters = counters;
    this.reportListenerError = reportListenerError;
    this.anchors = new Set(context.pages());
  }

  // 把事件和路由接上。launch 在返回实例之前调用。
  async attach(): Promise<void> {
    this.context.on('close', () => this.handleClosed());
    this.context.on('page', (p) => {
      if (this.opening > 0) this.deferred.add(p);
      else this.register(p, false);
    });
    // 响应头一到就算这个请求有了结果：只发出去不读响应体的请求（信标式的 fetch）不会触发 requestfinished，
    // 页面一跳转还会被报成 requestfailed。所以以 response 事件为准，requestfinished 和 requestfailed 只补没有响应的情形。
    this.context.on('response', (r) => { this.requestDone(r.request(), r.status(), false); });
    this.context.on('requestfinished', (r) => { void this.requestFinished(r); });
    this.context.on('requestfailed', (r) => { this.requestDone(r, null, true); });
    await this.context.route('**/*', (route) => this.handleRoute(route));
  }

  async health(): Promise<Check> {
    return { name: 'browser', ok: !this.closed, detail: this.closed ? 'browser is closed' : 'browser is running' };
  }

  stop(): Promise<void> {
    if (this.stopping === undefined) {
      this.stopping = (async () => {
        try {
          await this.context.close();
        } catch (e) {
          // 已经没了就算停成功；否则把失败交出去，并允许再试。
          if (!this.closed) {
            this.stopping = undefined;
            throw mapError(e);
          }
        }
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

  onRequestDone(listener: (e: { id: string; status: number | null; failed: boolean }) => void): void {
    this.requestDoneListeners.push(listener);
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

  async openPage(o: { viewport?: Viewport }): Promise<Page> {
    if (this.closed) throw new DriverError('other', 'browser is closed');
    this.opening++;
    let own: PlaywrightPage;
    try {
      const p = await this.context.newPage();
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
    if (o.viewport !== undefined) {
      try {
        await own.page.setViewportSize({ width: o.viewport.width, height: o.viewport.height });
      } catch (e) {
        await own.close().catch(() => {});
        throw mapError(e);
      }
    }
    return own;
  }

  reportError(e: unknown): void {
    this.reportListenerError(e);
  }

  popupsOf(pageId: string): string[] {
    return [...this.open].filter(w => w.openerId === pageId).map(w => w.page.url());
  }

  // 浏览器没了（被关、崩了、自己 stop）：先把实例置为已关，再让每个页触发 onClosed（包括 Playwright 已经先关掉、
  // 通知还在等的页），最后触发实例的，各一次。页面监听器里 health() 已经是 ok: false。
  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
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
    if (p.isClosed()) {
      w.markClosed();
    } else if (!own) {
      w.ready = this.announce(w);
    }
    return w;
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

  // 请求 → RequestInfo。归属判断不出来（request.frame() 抛错）时 pageId、openerPageId、topUrl 都是 null。
  // topUrl（内核拿它的主机去定模式，空就退回请求自己的地址）：
  // - 顶层框架的导航请求：就是请求自己的地址，即正要打开的那份文档；
  // - 其他请求：请求发出时那一页顶层文档的地址，但只认 http: 和 https:，
  //   about:blank、data:、chrome-error: 之类一律 null，让内核退回请求的地址；
  // - request.frame() 抛错：null。
  private async describeRequest(request: PwRequest): Promise<RequestInfo> {
    const isNavigation = request.isNavigationRequest();
    let pageId: string | null = null;
    let openerPageId: string | null = null;
    let topUrl: string | null = null;
    let topFrame = isNavigation;
    try {
      const frame: Frame = request.frame();
      const pwPage = frame.page();
      topFrame = frame.parentFrame() === null;
      topUrl = isNavigation && topFrame ? request.url() : httpUrlOrNull(pwPage.mainFrame().url());
      const w = this.register(pwPage, false);
      if (w !== null) {
        await w.ready;   // 请求到来时就查得到开启者：别处开出来的页，先等它登记完
        pageId = w.id;
        openerPageId = w.openerId;
      }
    } catch {
      pageId = null; openerPageId = null; topUrl = null; topFrame = isNavigation;
    }
    const post = request.postDataBuffer();
    return {
      id: `r${++this.counters.request}`,
      pageId, openerPageId,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      isNavigation, topFrame, topUrl,
      contentType: request.headers()['content-type'] ?? null,
      body: post === null ? null : post.subarray(0, MAX_BODY_BYTES).toString('utf8'),
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
          await route.continue();
          break;
        case 'fulfill':
          await route.fulfill({ status: decision.status, contentType: decision.contentType, body: decision.body });
          break;
        default:
          await route.abort();
      }
    } catch { /* 页面或浏览器在回答之前就没了，没有什么可答的了 */ }
  }

  // 每个请求只通知一次：先到的事件为准，之后的 requestfinished / requestfailed 一律忽略。
  private requestDone(request: PwRequest, status: number | null, failed: boolean): void {
    const id = this.requestIds.get(request);
    if (id === undefined || this.requestsDone.has(request)) return;
    this.requestsDone.add(request);
    emit(this.reportListenerError, this.requestDoneListeners, { id, status, failed });
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

  constructor(opts: DriverOptions) {
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
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profile.userDataDir, { headless: false, serviceWorkers: 'block' });
    } catch (e) {
      throw mapError(e);
    }
    context.setDefaultTimeout(this.actionTimeoutMs);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const instance = new PlaywrightInstance(context, this.counters, this.reportListenerError, this.actionTimeoutMs);
    try {
      await instance.attach();
    } catch (e) {
      await context.close().catch(() => {});
      throw mapError(e);
    }
    return instance;
  }
}

export function createPlaywrightDriver(opts: DriverOptions = {}): Driver {
  return new PlaywrightDriver(opts);
}
