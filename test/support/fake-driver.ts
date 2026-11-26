import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { DriverError } from '../../src/driver/types.ts';
import type { Capabilities, Check, Decision, Described, Driver, Instance, Page, PageLocation, PasswordProbe, RequestInfo, Stable }
  from '../../src/driver/types.ts';
import { isRef } from '../../src/shared/ops.ts';
import type { AssertKind, Target, Viewport, WaitCond } from '../../src/shared/ops.ts';

// 内存里的假驱动：实现同一份驱动协议（src/driver/types.ts），给内核测试用，不碰浏览器。
// 页面内容来自构造时给的规格（按 URL 查）；openPage 和页面上的方法都记进 calls。

export interface FakeElement { text?: string; visible?: boolean; css?: Record<string, string>; count?: number;
  password?: boolean; kind?: Described['kind']; stable?: Stable | null; failWith?: 'not-found' | 'timeout' | 'other'; describeFails?: number;
  hints?: string[]; waitFails?: boolean }   // hints：失败（动作、describe、等待）时带给 DriverError；waitFails：waitFor 这个目标会超时
export interface FakePageSpec { title?: string; snapshot?: string; elements?: Record<Target, FakeElement>; evalResult?: unknown;
  console?: { level: string; text: string }[]; gotoFailWith?: 'timeout' | 'other';
  passwordField?: boolean; passwordFieldFailWith?: 'timeout' | 'other';
  idleHints?: string[] }   // idleHints 给了：{ idle } 的等待会超时，带这些 hints

const DEFAULT_CAPABILITIES: Capabilities = {
  networkInterception: true,
  crossProcessIframes: 'covered',
  nativeFormSubmit: 'covered',
  sharedWorkers: 'covered',
  sharesUserProfile: false,
  canHeadless: true,
  selectorDialect: 'playwright',
};

type Call = { pageId: string; method: string; args: unknown[] };

// 页面和实例回到驱动的入口：记调用、按 URL 查规格、列出全部页面。
interface Host {
  record(call: Call): void;
  specFor(url: string): FakePageSpec;
  allPages(): readonly FakePage[];
}

class FakePage implements Page {
  readonly id: string;
  readonly openerId: string | null;
  url = 'about:blank';
  closed = false;
  viewport: Viewport | undefined;
  private spec: FakePageSpec = {};
  private elements = new Map<Target, FakeElement>();
  private readonly closedListeners: (() => void)[] = [];
  private readonly host: Host;

  constructor(host: Host, id: string, openerId: string | null, viewport: Viewport | undefined) {
    this.host = host;
    this.id = id;
    this.openerId = openerId;
    this.viewport = viewport;
  }

  // 换到某个 URL 的规格。元素逐个复制一份，fill 和 describeFails 的计数只改这一页自己的副本。
  load(url: string, spec: FakePageSpec): void {
    this.url = url;
    this.spec = spec;
    this.elements = new Map(Object.entries(spec.elements ?? {}).map(([k, v]) => [k, { ...v }]));
  }

  // 监听器的注册不算页面动作：不记 calls，页关了也不抛。
  onClosed(listener: () => void): void {
    this.closedListeners.push(listener);
  }

  fireClosed(): void {
    for (const l of this.closedListeners) l();
  }

  private enter(method: string, args: unknown[]): void {
    this.host.record({ pageId: this.id, method, args });
    if (this.closed) throw new DriverError('other', 'page is closed');
  }

  private element(target: Target): FakeElement {
    const el = this.elements.get(target);
    if (el === undefined) throw new DriverError('not-found', 'element not found');
    return el;
  }

  private act(target: Target): FakeElement {
    const el = this.element(target);
    if (el.failWith !== undefined) throw new DriverError(el.failWith, `element action failed: ${el.failWith}`, [...(el.hints ?? [])]);
    return el;
  }

  async location(): Promise<PageLocation> {
    this.enter('location', []);
    const popups = this.host.allPages().filter((p) => p.openerId === this.id && !p.closed).map((p) => p.url);
    return { url: this.url, title: this.spec.title ?? '', frames: [], popups, webSockets: 0 };
  }

  async snapshot(o: { depth?: number }): Promise<string> {
    this.enter('snapshot', [o]);
    return this.spec.snapshot ?? '';
  }

  async text(o: { target?: Target }): Promise<string> {
    this.enter('text', [o]);
    if (o.target !== undefined) return this.element(o.target).text ?? '';
    return [...this.elements.values()].flatMap((el) => (el.text === undefined ? [] : [el.text])).join('\n');
  }

  async screenshot(o: { path: string; fullPage: boolean; format?: 'jpeg' | 'png'; target?: Target; mask?: Target[]; maskColor?: string }): Promise<void> {
    this.enter('screenshot', [o]);
    if (o.target !== undefined) this.element(o.target);
    for (const [i, t] of (o.mask ?? []).entries()) {
      if (!this.elements.has(t)) throw new DriverError('not-found', `mask[${i}] matched no element`);
    }
    // 按扩展名写最小的文件头：png 的魔数，或 jpeg 的起止标记。
    const png = o.path.endsWith('.png');
    await writeFile(o.path, Buffer.from(png ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff, 0xd9]));
  }

  async console(): Promise<{ level: string; text: string }[]> {
    this.enter('console', []);
    return (this.spec.console ?? []).map((m) => ({ ...m }));
  }

  async click(target: Target): Promise<void> {
    this.enter('click', [target]);
    this.act(target);
  }

  async hover(target: Target): Promise<void> {
    this.enter('hover', [target]);
    this.act(target);
  }

  async fill(target: Target, value: string): Promise<void> {
    this.enter('fill', [target, value]);
    this.act(target).text = value;
  }

  async press(key: string, target?: Target): Promise<void> {
    this.enter('press', target === undefined ? [key] : [key, target]);
    if (target !== undefined) this.act(target);
  }

  async scroll(o: { target?: Target; dx?: number; dy?: number }): Promise<void> {
    this.enter('scroll', [o]);
    if (o.target !== undefined) this.act(o.target);
  }

  async goto(url: string): Promise<void> {
    this.enter('goto', [url]);
    const spec = this.host.specFor(url);
    if (spec.gotoFailWith !== undefined) throw new DriverError(spec.gotoFailWith, `navigation failed: ${spec.gotoFailWith}`);
    this.load(url, spec);
  }

  async setViewport(v: Viewport): Promise<void> {
    this.enter('setViewport', [v]);
    this.viewport = { ...v };
  }

  // { ms } 真的睡这么久（内核测试靠它）；{ idle } 立刻成功，除非页面 spec 给了 idleHints；其他条件一律立刻成功。
  async waitFor(cond: WaitCond, timeoutMs: number): Promise<void> {
    this.enter('waitFor', [cond, timeoutMs]);
    if ('idle' in cond && this.spec.idleHints !== undefined) throw new DriverError('timeout', 'page did not become idle', [...this.spec.idleHints]);
    if ('target' in cond) {
      const el = this.elements.get(cond.target);
      if (el?.waitFails === true) throw new DriverError('timeout', 'wait timed out', [...(el.hints ?? [])]);
    }
    if ('ms' in cond) await sleep(cond.ms);
  }

  // 不等待：text、css 的目标不存在抛 not-found；count 给 0；visible 给 false。
  async read(q: { kind: AssertKind; target?: Target; property?: string }): Promise<string | number | boolean> {
    this.enter('read', [q]);
    if (q.kind === 'url') return this.url;
    const el = q.target === undefined ? undefined : this.elements.get(q.target);
    switch (q.kind) {
      case 'count':
        return el === undefined ? 0 : (el.count ?? 1);
      case 'visible':
        return el === undefined ? false : (el.visible ?? true);
      case 'text':
        if (el === undefined) throw new DriverError('not-found', 'element not found');
        return el.text ?? '';
      case 'css':
        if (el === undefined) throw new DriverError('not-found', 'element not found');
        return el.css?.[q.property ?? ''] ?? '';
    }
  }

  async evaluate(js: string): Promise<unknown> {
    this.enter('evaluate', [js]);
    return this.spec.evalResult;
  }

  // 规格里写了 passwordField 才为 true；写了 passwordFieldFailWith 就抛 DriverError（模拟查不出）。
  async hasVisiblePasswordField(): Promise<boolean> {
    this.enter('hasVisiblePasswordField', []);
    if (this.spec.passwordFieldFailWith !== undefined) throw new DriverError(this.spec.passwordFieldFailWith, 'password field probe failed');
    return this.spec.passwordField === true;
  }

  // 同一份 passwordField 规格；写了 passwordFieldFailWith 就当「探测失败」返回 null。
  async hasPasswordLikeField(): Promise<PasswordProbe> {
    this.enter('hasPasswordLikeField', []);
    if (this.spec.passwordFieldFailWith !== undefined) return { found: null, frames: [this.url] };
    return { found: this.spec.passwordField === true, frames: [this.url] };
  }

  // 规格里写了 stable 就原样返回（含 null）；没写时选择器给 given，引用给 null。kind 规格没写就是 'other'（往保守处判）。
  async describe(target: Target): Promise<Described> {
    this.enter('describe', [target]);
    const el = this.element(target);
    if ((el.describeFails ?? 0) > 0) {
      el.describeFails = (el.describeFails ?? 0) - 1;
      throw new DriverError('other', 'describe failed', [...(el.hints ?? [])]);
    }
    const stable = 'stable' in el ? (el.stable ?? null) : isRef(target) ? null : { selector: target, via: 'given' as const };
    return { stable, isPassword: el.password === true, kind: el.kind ?? 'other' };
  }

  // 调用方主动关的页也触发 onClosed（和真实浏览器一致）；已关的页再 close 会在 enter 里抛错，不会再触发。
  async close(): Promise<void> {
    this.enter('close', []);
    this.closed = true;
    this.fireClosed();
  }
}

class FakeInstance implements Instance {
  closed = false;
  readonly pages: FakePage[] = [];
  readonly initScripts: string[] = [];
  requestHandler: ((r: RequestInfo) => Decision | Promise<Decision>) | undefined;
  readonly closedListeners: (() => void)[] = [];
  readonly requestDoneListeners: ((e: { id: string; status: number | null; failed: boolean; redirectRefused?: true }) => void)[] = [];
  readonly pageOpenedListeners: ((page: Page, openerId: string | null) => void)[] = [];
  private readonly openPageImpl: (o: { viewport?: Viewport }) => Promise<Page>;

  constructor(openPageImpl: (inst: FakeInstance, o: { viewport?: Viewport }) => Promise<Page>) {
    this.openPageImpl = (o) => openPageImpl(this, o);
  }

  async health(): Promise<Check> {
    return { name: 'browser', ok: !this.closed, detail: this.closed ? 'browser is closed' : 'browser is running' };
  }

  // 调用方主动停：和浏览器没了一样触发监听器。
  async stop(): Promise<void> {
    this.shutdown();
  }

  // 先把实例和每一页都置为已关，再依次触发每页的 onClosed、实例的 onClosed：监听器里查状态已经是「已关」。
  shutdown(): void {
    if (this.closed) return;
    const open = this.pages.filter((p) => !p.closed);
    this.closed = true;
    for (const p of open) p.closed = true;
    for (const p of open) p.fireClosed();
    for (const l of this.closedListeners) l();
  }

  onClosed(listener: () => void): void {
    this.closedListeners.push(listener);
  }

  setRequestHandler(h: (r: RequestInfo) => Decision | Promise<Decision>): void {
    this.requestHandler = h;
  }

  onRequestDone(listener: (e: { id: string; status: number | null; failed: boolean; redirectRefused?: true }) => void): void {
    this.requestDoneListeners.push(listener);
  }

  async addInitScript(source: string): Promise<void> {
    if (this.closed) throw new DriverError('other', 'browser is closed');
    this.initScripts.push(source);
  }

  onPageOpened(listener: (page: Page, openerId: string | null) => void): void {
    this.pageOpenedListeners.push(listener);
  }

  openPage(o: { viewport?: Viewport }): Promise<Page> {
    return this.openPageImpl(o);
  }
}

export class FakeDriver implements Driver {
  readonly name = 'fake';
  readonly capabilities: Capabilities;
  readonly calls: Call[] = [];
  readonly noRedirectIds: string[] = [];   // handler 回了 continue 且带 followRedirects: false 的请求 id
  launches = 0;
  lastProfile: { name: string; userDataDir: string } | null = null;

  private readonly pageSpecs: Record<string, FakePageSpec>;
  private readonly checks: Check[];
  private readonly failOpenWith: Error | undefined;
  private readonly launchDelayMs: number;
  // 页面 id 和请求 id 的计数挂在驱动对象上：整个生命期内唯一，不随实例或 launch 重置。
  private pageSeq = 0;
  private requestSeq = 0;
  private readonly pages: FakePage[] = [];
  private current: FakeInstance | undefined;
  private readonly host: Host;

  constructor(o: { capabilities?: Partial<Capabilities>; pages?: Record<string, FakePageSpec>; checks?: Check[];
    failOpenWith?: Error; launchDelayMs?: number } = {}) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...o.capabilities };
    this.pageSpecs = o.pages ?? {};
    this.checks = o.checks ?? [{ name: 'fake', ok: true, detail: 'fake driver is always available' }];
    this.failOpenWith = o.failOpenWith;
    this.launchDelayMs = o.launchDelayMs ?? 0;
    this.host = {
      record: (call) => { this.calls.push(call); },
      specFor: (url) => (Object.hasOwn(this.pageSpecs, url) ? this.pageSpecs[url] as FakePageSpec : {}),
      allPages: () => this.pages,
    };
  }

  async selfCheck(): Promise<Check[]> {
    return this.checks.map((c) => ({ ...c }));
  }

  async launch(profile: { name: string; userDataDir: string }): Promise<Instance> {
    await sleep(this.launchDelayMs);
    this.launches++;
    this.lastProfile = { ...profile };
    this.current = new FakeInstance((inst, o) => this.openPageIn(inst, o));
    return this.current;
  }

  openPages(): string[] {
    return this.pages.filter((p) => !p.closed).map((p) => p.id);
  }

  async emitRequest(r: { pageId: string | null; method: string; url: string } & Partial<RequestInfo>): Promise<Decision> {
    const inst = this.running();
    const page = r.pageId === null ? undefined : this.pages.find((p) => p.id === r.pageId);
    const info: RequestInfo = {
      id: `r${++this.requestSeq}`, openerPageId: page?.openerId ?? null, resourceType: 'fetch', isNavigation: false,
      topFrame: true, topUrl: page?.url ?? null, contentType: null, body: null, fromLoginForm: false, ...r,
    };
    if (inst.requestHandler === undefined) return { action: 'abort' };
    try {
      const decision = await inst.requestHandler(info);
      if (decision.action === 'continue' && decision.followRedirects === false) this.noRedirectIds.push(info.id);
      return decision;
    } catch {
      return { action: 'abort' };
    }
  }

  // 真驱动在重定向首跳被拒时发 { status: 首跳状态, failed: true, redirectRefused: true }。
  emitRequestDone(id: string, status: number | null, opts: { failed?: boolean; redirectRefused?: true } = {}): void {
    const e = { id, status, failed: opts.failed ?? opts.redirectRefused === true, ...(opts.redirectRefused === true ? { redirectRefused: true as const } : {}) };
    for (const l of this.running().requestDoneListeners) l(e);
  }

  emitPopup(openerId: string, url: string): Page {
    const inst = this.running();
    const page = this.newPage(inst, openerId, undefined);
    page.load(url, this.host.specFor(url));
    for (const l of inst.pageOpenedListeners) l(page, openerId);
    return page;
  }

  // 模拟人关掉一个标签页。
  closePage(pageId: string): void {
    const page = this.pages.find((p) => p.id === pageId);
    if (page === undefined || page.closed) return;
    page.closed = true;
    page.fireClosed();
  }

  // 模拟浏览器整个没了。
  closeBrowser(): void {
    this.current?.shutdown();
  }

  private running(): FakeInstance {
    if (this.current === undefined || this.current.closed) throw new Error('fake driver: no running instance');
    return this.current;
  }

  private newPage(inst: FakeInstance, openerId: string | null, viewport: Viewport | undefined): FakePage {
    const page = new FakePage(this.host, `p${++this.pageSeq}`, openerId, viewport);
    this.pages.push(page);
    inst.pages.push(page);
    return page;
  }

  private async openPageIn(inst: FakeInstance, o: { viewport?: Viewport }): Promise<Page> {
    if (inst.closed) throw new DriverError('other', 'browser is closed');
    if (this.failOpenWith !== undefined) throw this.failOpenWith;
    const page = this.newPage(inst, null, o.viewport === undefined ? undefined : { ...o.viewport });
    this.calls.push({ pageId: page.id, method: 'openPage', args: [o] });
    return page;
  }
}
