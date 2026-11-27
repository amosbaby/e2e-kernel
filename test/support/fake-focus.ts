import type { FocusKeeper } from '../../src/kernel/focus.ts';

// 假的焦点管家：只记调用，不碰任何真应用。calls 里是 'capture'、'restore:<token>' 或 'restore:null'。
// 测试里凡是构造 SessionManager、调 startKernel 的，要么传 noFocus，要么传这个——绝不能走到真的 macFocus。
export interface FakeFocus extends FocusKeeper { calls: string[]; restores: (string | null)[] }

export function fakeFocus(token: string | null = 'com.example.app'): FakeFocus {
  const calls: string[] = [];
  const restores: (string | null)[] = [];
  return {
    calls, restores,
    capture: async () => { calls.push('capture'); return token; },
    restore: async (t) => { calls.push(`restore:${t ?? 'null'}`); restores.push(t); },
  };
}
