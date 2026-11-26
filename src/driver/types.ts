import type { AssertKind, Target, Viewport, WaitCond } from '../shared/ops.ts';

// 驱动协议（设计 5.10）。内核只通过这里的接口碰浏览器；驱动目录以外不出现任何具体浏览器库的类型。
//
// 两个驱动都要守的约定：
// - openPage 只开空白页、不导航：内核先把页面 id 记到会话名下再 goto，首屏请求才归得到会话。
// - 不是驱动自己 openPage 开出来的页（弹窗、页面开的新标签页、人手开的标签页）：驱动第一次见到它时
//   （请求回调里或新页面事件里，以先到者为准）就登记 id，并触发一次 onPageOpened，能查到开启者就带上。
// - 页面 id 和 RequestInfo.id 在驱动对象的整个生命期内唯一：不按实例、不按每次 launch 重置。
// - 动作失败抛 DriverError；其余异常内核一律当内部错误。
// - setRequestHandler 的回调抛错时，驱动中止这个请求（失败时偏向拦住），不放行。
// - Decision.continue 带 followRedirects: false 时，驱动只发首跳、不跟随重定向（Playwright 的路由 handler 只见重定向链的
//   第一个 URL，后续跳绕过内核的判断）：首跳是 3xx 就先通知 onRequestDone { status: 首跳状态, failed: true, redirectRefused: true }
//   （去重以先到为准，所以通知在前），再中止请求；不是 3xx 就把响应原样交给页面；发送出错一律中止，不算重定向。
//   只有同源的请求这样发；跨源的（含判断不出同源的）照常放行，由浏览器自己发，浏览器才继续执行 CORS 和 SameSite。
// - setRequestHandler 之前到来的请求，驱动一律中止（失败关闭），不放行也不记录。
// - read 不等待：text、css 的目标不存在立刻抛 DriverError('not-found')；count 返回 0；visible 返回 false。
// - describe 对选择器写法的目标返回 { selector: 原样, via: 'given' }；对引用返回解析出的稳定选择器，
//   解析不出返回 null。元素找不到时抛 DriverError。
// - RequestInfo.initiatorUrl：顶层框架的导航请求（表单提交、整页跳转）是请求发出时主框架已提交的地址（路由回调运行时、
//   导航提交之前读到的 mainFrame().url()，只认 http: 和 https:，其他是 null），也就是「即将被这次导航替换掉的那份文档」；
//   这和 topUrl（导航目标）不同。它通常就是发起导航的页，但不总是：iframe 的 target=_top、别的窗口的 target=<窗口名>
//   发起的导航，报的是被替换的那一页，不是真正的发送者。其他请求和 topUrl 取同一个值。内核用它判断导航前页面在哪个主机上。
// - 驱动不得往页面里暴露任何能调回驱动或内核的函数。

export const ACTION_TIMEOUT_MS = 10_000;
export const NAVIGATION_TIMEOUT_MS = 30_000;

export type Coverage = 'covered' | 'not-covered' | 'unknown';

export interface Capabilities {
  networkInterception: boolean;        // 能否网络层拦截
  crossProcessIframes: Coverage;       // 能否覆盖跨进程 iframe
  nativeFormSubmit: Coverage;          // 能否拦住原生表单提交
  sharedWorkers: Coverage;             // SharedWorker 发出的请求是否都经过路由（不经路由就得在页面里删掉它）
  sharesUserProfile: boolean;          // 是否共用用户日常的 profile
  canHeadless: boolean;                // 能否无头
  selectorDialect: string;             // 选择器方言
}

export interface Check { name: string; ok: boolean; detail: string; fix?: string }

// hints：失败时的诊断（选择器匹配了哪几个、谁挡住了点击），最多 6 条，默认没有。
// 驱动只做保护性的截断（每条 4000 字符），不脱敏也不截短：条目里可能带页面文字（元素名、遮挡元素的属性），
// 由内核先脱敏、再截断；message 仍是一行。
export class DriverError extends Error {
  kind: 'not-found' | 'timeout' | 'other';
  hints: string[];

  constructor(kind: DriverError['kind'], message: string, hints: string[] = []) {
    super(message);
    this.name = 'DriverError';
    this.kind = kind;
    this.hints = hints;
  }
}

// id 和页面 id 在驱动对象的整个生命期内唯一（见上面的约定）。
// pageId：发出请求的页面，判断不出来时是 null；openerPageId：那一页的开启者，没有或不知道时是 null。
export interface RequestInfo {
  id: string; pageId: string | null; openerPageId: string | null; method: string; url: string; resourceType: string;
  isNavigation: boolean; topFrame: boolean; topUrl: string | null; initiatorUrl: string | null; contentType: string | null; body: string | null;
  // 有请求体时：发出请求的 frame，或它所在页面的顶层文档里，有没有密码类输入框（type=password，或 autocomplete 含
  // current-password / new-password / one-time-code；不要求可见）。没有请求体、导航请求（原生表单提交，路由回调里探测不了）、
  // 探测失败或超时都是 null。
  // 内核只在它严格等于 false 时才记请求体（失败关闭）。
  fromLoginForm: boolean | null;
}

export type Decision =
  | { action: 'continue'; followRedirects?: false }
  | { action: 'fulfill'; status: number; contentType: string; body: string }
  | { action: 'abort' };

export interface Stable { selector: string; via: 'given' | 'testid' | 'id' | 'role' | 'css' }

// describe 对目标的判断，判断的是 fill 实际会填的元素（目标是 label 或 label 里的文字时，是这个 label 关联的输入框）。
// isPassword：type=password，或 autocomplete 含 current-password / new-password / one-time-code。
// kind：text-input = type 为 text、email、search、tel、url、number 的 <input>；textarea = <textarea>；其余（contenteditable、
// role=textbox、别的标签和 type）都是 other。内核只在 isPassword 为 false 且 kind 不是 other 时才把 fill 的值留进记录。
export type ElementKind = 'text-input' | 'textarea' | 'other';
export interface Described { stable: Stable | null; isPassword: boolean; kind: ElementKind }

export interface PasswordProbe { found: boolean | null; frames: string[] }

export interface PageLocation { url: string; title: string; frames: { url: string; name: string }[]; popups: string[]; webSockets: number }

export interface Driver {
  readonly name: string;
  readonly capabilities: Capabilities;
  selfCheck(): Promise<Check[]>;
  launch(profile: { name: string; userDataDir: string }): Promise<Instance>;        // 实例：启动
}

export interface Instance {
  health(): Promise<Check>;                                                          // 实例：健康检查
  stop(): Promise<void>;                                                             // 实例：停止
  // 浏览器没了：被关、崩了，也包括调用方自己 stop()。任何一种关闭都触发；自己发起关闭的调用方要自己忽略这次事件。
  onClosed(listener: () => void): void;
  setRequestHandler(h: (r: RequestInfo) => Decision | Promise<Decision>): void;      // 拦截：请求回调，导航请求也走这里
  onRequestDone(listener: (e: { id: string; status: number | null; failed: boolean; redirectRefused?: true }) => void): void;
  addInitScript(source: string): Promise<void>;                                      // 拦截：页面脚本之前的注入脚本
  onPageOpened(listener: (page: Page, openerId: string | null) => void): void;       // 弹窗和新标签页
  openPage(o: { viewport?: Viewport; touch?: boolean }): Promise<Page>;              // 页面：打开一个空白页，由内核再 goto；touch 只对这一页模拟触屏（不能模拟就抛错，不留页）
}

export interface Page {
  readonly id: string;                                                               // 在驱动对象的整个生命期内唯一
  // 这一页没了：人关了标签页、页面自己关了、浏览器没了，也包括调用方自己 close()。任何一种关闭都触发；
  // 自己发起关闭的调用方要自己忽略这次事件。
  onClosed(listener: () => void): void;
  location(): Promise<PageLocation>;                                                 // 读数：当前位置、拦截覆盖情况
  snapshot(o: { depth?: number }): Promise<string>;
  text(o: { target?: Target }): Promise<string>;
  // format 缺省是 jpeg；target 给了就只截这个元素（严格模式，匹配多个算错）；mask 里的元素盖上 maskColor（缺省是驱动自己的遮罩色）。
  screenshot(o: { path: string; fullPage: boolean; format?: 'jpeg' | 'png'; target?: Target; mask?: Target[]; maskColor?: string }): Promise<void>;
  console(): Promise<{ level: string; text: string }[]>;
  click(target: Target): Promise<void>;
  hover(target: Target): Promise<void>;
  fill(target: Target, value: string): Promise<void>;
  press(key: string, target?: Target): Promise<void>;
  scroll(o: { target?: Target; dx?: number; dy?: number }): Promise<void>;
  goto(url: string): Promise<void>;
  setViewport(v: Viewport): Promise<void>;
  waitFor(cond: WaitCond, timeoutMs: number): Promise<void>;
  read(q: { kind: AssertKind; target?: Target; property?: string }): Promise<string | number | boolean>;
  evaluate(js: string): Promise<unknown>;                                            // 页面内执行脚本
  describe(target: Target): Promise<Described>;
  hasVisiblePasswordField(): Promise<boolean>;                                       // 主 frame（含 open shadow DOM、不含 iframe）里有没有可见的密码类字段
  // 这一页（任何 frame，含 open shadow DOM）里有没有密码类输入框（不要求可见，同 RequestInfo.fromLoginForm 的口径）。
  // found 只有数清楚了才给 true / false；数不出、超过 300 ms、数的时候地址变了，一律 null，内核按失败关闭处理。
  // frames：探测结束时各 frame 的地址（对内核不透明，只用来比较两次探测之间页面有没有换文档）。
  // 不抛 DriverError 以外的错；页面已关则抛 DriverError。
  hasPasswordLikeField(): Promise<PasswordProbe>;
  close(): Promise<void>;                                                            // 收尾
}
