import type { FocusKeeper } from '../../src/kernel/focus.ts';

// 假的焦点管家：只记调用，不碰任何真应用。calls 里是 'capture'、'restore:<token>' 或 'restore:null'。
// 测试里凡是构造 SessionManager、调 startKernel 的，要么传 noFocus，要么传这个——绝不能走到真的 macFocus。
// chromiumFront 模拟「此刻前台是不是 e2k 的 Chromium」：restore 在它为 true 时算还成了（记进 handedBack 并返回 true），
// 为 false 时什么也不做（返回 false，和真管家一样）。token 可以在测试里改（取不到前台应用时是 null）。
export interface FakeFocus extends FocusKeeper {
  calls: string[]; restores: (string | null)[]; handedBack: (string | null)[];
  chromiumFront: boolean; token: string | null;
  reset(): void;   // 清掉 calls / restores / handedBack（开会话那一步也会调 capture / restore）
}

export function fakeFocus(token: string | null = 'com.example.app'): FakeFocus {
  const calls: string[] = [];
  const restores: (string | null)[] = [];
  const handedBack: (string | null)[] = [];
  const f: FakeFocus = {
    calls, restores, handedBack, chromiumFront: true, token,
    reset: () => { calls.length = 0; restores.length = 0; handedBack.length = 0; },
    capture: async () => { calls.push('capture'); return f.token; },
    restore: async (t) => {
      calls.push(`restore:${t ?? 'null'}`); restores.push(t);
      if (t === null || !f.chromiumFront) return false;
      handedBack.push(t);
      return true;
    },
  };
  return f;
}

// 手动拨的时钟：注入给 SessionManager 的 focusTiming。sleep 一直挂着，直到测试 advance；时间只在 advance 时前进。
export interface ManualClock {
  timing: { pollMs: number; graceMs: number; deadlineMs: number; sleep(ms: number): Promise<void>; nowMs(): number };
  advance(ms: number): Promise<void>;
  pending(): number;
}

export function manualClock(pollMs = 100): ManualClock {
  let t = 0;
  let waiters: { at: number; wake: () => void }[] = [];
  const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise<void>((r) => { setImmediate(r); }); };
  return {
    timing: {
      pollMs, graceMs: 1500, deadlineMs: 2000,
      sleep: (ms) => new Promise<void>((wake) => { waiters.push({ at: t + ms, wake }); }),
      nowMs: () => t,
    },
    async advance(ms) {
      await flush();
      for (let left = ms; left > 0; left -= pollMs) {
        t += Math.min(pollMs, left);
        const due = waiters.filter((w) => w.at <= t);
        waiters = waiters.filter((w) => w.at > t);
        for (const w of due) w.wake();
        await flush();
      }
    },
    pending: () => waiters.length,
  };
}
