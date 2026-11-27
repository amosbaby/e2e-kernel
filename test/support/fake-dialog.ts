import type { Dialog, DialogRequest, DialogResult } from '../../src/kernel/approval.ts';

// 可编排的假对话框：记录收到的每个请求，回什么由 script 定（缺省回 unavailable，等于没人能批准）。
// 只在测试里用：内核本身没有任何「自动批准」的实现。
export interface FakeDialog extends Dialog { requests: DialogRequest[] }

export function fakeDialog(script?: (r: DialogRequest) => DialogResult | Promise<DialogResult>): FakeDialog {
  const requests: DialogRequest[] = [];
  return {
    requests,
    show: async (r) => {
      requests.push(r);
      return script === undefined ? { kind: 'unavailable', why: '测试里没有编排这个对话框' } : script(r);
    },
  };
}

// 常用的编排：见到「批准」键就按它，没有（只有「拒绝」的框）就按「拒绝」；或一律按「拒绝」。
export const approving = (r: DialogRequest): DialogResult => ({ kind: 'button', button: r.buttons.includes('批准') ? '批准' : '拒绝' });
export const denying = (): DialogResult => ({ kind: 'button', button: '拒绝' });

// 人还没点：框一直开着，release() 之后按「批准」答。
export function holdingDialog(): { dialog: FakeDialog; release: () => void } {
  let release = (): void => {};
  const dialog = fakeDialog((r) => new Promise((resolve) => { release = () => { resolve(approving(r)); }; }));
  return { dialog, release: () => { release(); } };
}

// 框按标题认（内核弹框时标题后面会加「（请求 id）」，所以只比开头）：按钮名会重复（deny 框也有「只读」），不能靠按钮认。
const titled = (r: DialogRequest, ...titles: string[]): boolean => titles.some((t) => r.title.startsWith(t));
const LOGIN_MODE_TITLE = 'e2k：在新域名上登录';
const DENY_TITLES = ['e2k：打开不允许的域名', 'e2k：借用登录', 'e2k：在不允许的域名上登录'];

// 登录前「问模式」的三键框（不登录 / 默认 / 只读）：见到就按 button；别的框照 approving。只在测试里用。
export const choosingMode = (button: '不登录' | '默认' | '只读') => (r: DialogRequest): DialogResult =>
  titled(r, LOGIN_MODE_TITLE) ? { kind: 'button', button } : approving(r);

// 只答登录前「问模式」的框，别的框照 fakeDialog() 缺省回 unavailable：给共用内核的老测试用（不改变它们对别的框的行为）。
export const choosingModeOnly = (button: '不登录' | '默认' | '只读') => (r: DialogRequest): DialogResult =>
  titled(r, LOGIN_MODE_TITLE) ? { kind: 'button', button } : { kind: 'unavailable', why: '测试里没有编排这个对话框' };

// deny 类的三种框（打开不允许的域名、借用登录、在不允许的域名上登录）：按 button，框里没有这个按钮就按「拒绝」；别的框照 approving。只在测试里用。
export const answeringDeny = (button: '拒绝' | '只读' | '可写' | '允许' | '登录') => (r: DialogRequest): DialogResult =>
  titled(r, ...DENY_TITLES) ? { kind: 'button', button: r.buttons.includes(button) ? button : '拒绝' } : approving(r);
