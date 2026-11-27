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
