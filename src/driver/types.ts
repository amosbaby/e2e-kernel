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
// - read 不等待：text、css 的目标不存在立刻抛 DriverError('not-found')；count 返回 0；visible 返回 false。
// - describe 对选择器写法的目标返回 { selector: 原样, via: 'given' }；对引用返回解析出的稳定选择器，
//   解析不出返回 null。元素找不到时抛 DriverError。
// - 驱动不得往页面里暴露任何能调回驱动或内核的函数。

export const ACTION_TIMEOUT_MS = 10_000;
export const NAVIGATION_TIMEOUT_MS = 30_000;

export type Coverage = 'covered' | 'not-covered' | 'unknown';

export interface Capabilities {
  networkInterception: boolean;        // 能否网络层拦截
  crossProcessIframes: Coverage;       // 能否覆盖跨进程 iframe
  nativeFormSubmit: Coverage;          // 能否拦住原生表单提交
  sharesUserProfile: boolean;          // 是否共用用户日常的 profile
  canHeadless: boolean;                // 能否无头
  selectorDialect: string;             // 选择器方言
}

export interface Check { name: string; ok: boolean; detail: string; fix?: string }

export class DriverError extends Error {
  kind: 'not-found' | 'timeout' | 'other';

  constructor(kind: DriverError['kind'], message: string) {
    super(message);
    this.name = 'DriverError';
    this.kind = kind;
  }
}

// id 和页面 id 在驱动对象的整个生命期内唯一（见上面的约定）。
// pageId：发出请求的页面，判断不出来时是 null；openerPageId：那一页的开启者，没有或不知道时是 null。
export interface RequestInfo {
  id: string; pageId: string | null; openerPageId: string | null; method: string; url: string; resourceType: string;
  isNavigation: boolean; topFrame: boolean; topUrl: string | null; contentType: string | null; body: string | null;
}

export type Decision =
  | { action: 'continue' }
  | { action: 'fulfill'; status: number; contentType: string; body: string }
  | { action: 'abort' };

export interface Stable { selector: string; via: 'given' | 'testid' | 'id' | 'role' | 'css' }

// describe 对目标的判断，判断的是 fill 实际会填的元素（目标是 label 或 label 里的文字时，是这个 label 关联的输入框）。
// isPassword：type=password，或 autocomplete 含 current-password / new-password / one-time-code。
// kind：text-input = type 为 text、email、search、tel、url、number 的 <input>；textarea = <textarea>；其余（contenteditable、
// role=textbox、别的标签和 type）都是 other。内核只在 isPassword 为 false 且 kind 不是 other 时才把 fill 的值留进记录。
export type ElementKind = 'text-input' | 'textarea' | 'other';
export interface Described { stable: Stable | null; isPassword: boolean; kind: ElementKind }

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
  onRequestDone(listener: (e: { id: string; status: number | null; failed: boolean }) => void): void;
  addInitScript(source: string): Promise<void>;                                      // 拦截：页面脚本之前的注入脚本
  onPageOpened(listener: (page: Page, openerId: string | null) => void): void;       // 弹窗和新标签页
  openPage(o: { viewport?: Viewport }): Promise<Page>;                               // 页面：打开一个空白页，由内核再 goto
}

export interface Page {
  readonly id: string;                                                               // 在驱动对象的整个生命期内唯一
  // 这一页没了：人关了标签页、页面自己关了、浏览器没了，也包括调用方自己 close()。任何一种关闭都触发；
  // 自己发起关闭的调用方要自己忽略这次事件。
  onClosed(listener: () => void): void;
  location(): Promise<PageLocation>;                                                 // 读数：当前位置、拦截覆盖情况
  snapshot(o: { depth?: number }): Promise<string>;
  text(o: { target?: Target }): Promise<string>;
  screenshot(o: { path: string; fullPage: boolean }): Promise<void>;
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
  close(): Promise<void>;                                                            // 收尾
}
