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

// 登录前「问模式」是两步框：第一步 不登录 / 默认 / 更严…，第二步（标题带「（更严的模式）」）不登录 / 只读 / 不允许。
// 按标题认：第一步的标题后面直接是「（请求 id）」，第二步的是「（更严的模式）」开头。
const LOGIN_STRICT_TITLE = 'e2k：在新域名上登录（更严的模式）';
type LoginChoice = '不登录' | '默认' | '只读' | '不允许';
function loginAnswer(r: DialogRequest, choice: LoginChoice): DialogResult | null {
  if (!titled(r, LOGIN_MODE_TITLE)) return null;
  if (titled(r, LOGIN_STRICT_TITLE)) return { kind: 'button', button: choice === '只读' || choice === '不允许' ? choice : '不登录' };
  return { kind: 'button', button: choice === '只读' || choice === '不允许' ? '更严…' : choice };
}

// 登录前「问模式」的两步框：'默认' / '不登录' 一步答完，'只读' / '不允许' 先点第一步的「更严…」再点第二步；别的框照 approving。只在测试里用。
export const choosingMode = (choice: LoginChoice) => (r: DialogRequest): DialogResult => loginAnswer(r, choice) ?? approving(r);

// 只答登录前「问模式」的框，别的框照 fakeDialog() 缺省回 unavailable：给共用内核的老测试用（不改变它们对别的框的行为）。
export const choosingModeOnly = (choice: LoginChoice) => (r: DialogRequest): DialogResult =>
  loginAnswer(r, choice) ?? { kind: 'unavailable', why: '测试里没有编排这个对话框' };

// deny 类的三种框（打开不允许的域名、借用登录、在不允许的域名上登录）：按 button，框里没有这个按钮就按「拒绝」；别的框照 approving。只在测试里用。
export const answeringDeny = (button: '拒绝' | '只读' | '可写' | '允许' | '登录') => (r: DialogRequest): DialogResult =>
  titled(r, ...DENY_TITLES) ? { kind: 'button', button: r.buttons.includes(button) ? button : '拒绝' } : approving(r);
