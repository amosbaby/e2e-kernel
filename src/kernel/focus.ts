import { defaultExec } from './approval.ts';
import type { ExecFn } from './approval.ts';

// 把 macOS 前台焦点还给用户原来的应用（docs/m0-findings.md §7.1）。有头浏览器启动、开新页、弹窗时会抢前台；
// 抢了之后按 bundle id 还回去。用 lsappinfo 读前台、open -b 还，不经 System Events，不需要「自动化」授权。
// 约定：capture / restore 都不抛错（失败吞掉、记一行日志）；还不回去只是用户多点一下，绝不能影响 open / step 的结果。

export interface FocusKeeper {
  // 记下当前前台应用的 bundle id；取不到、不合格、或前台已经是 e2k 的 Chromium 都返回 null。
  capture(): Promise<string | null>;
  // 把前台还给 token：token 为 null 什么也不做；只有「此刻前台是 e2k 的 Chromium」才还，别的情况（用户已经切走了）不动。
  // 返回 true 表示这次真的执行了 `open -b`（不管它成没成：每次调用只还一次；要不要再试由调用方决定，step 之后的后台循环会在截止前每次看到浏览器又在前台时再调）；false 表示没动手
  // （token 为 null 或不合格、前台还不是 e2k 的 Chromium、读不到前台）。调用方靠它决定要不要稍后再试。
  restore(token: string | null): Promise<boolean>;
}

export const noFocus: FocusKeeper = {
  capture: async () => null,
  restore: async () => false,
};

const CALL_TIMEOUT_MS = 2000;
// lsappinfo 的输出是不信任输入：只按这两个形状取值，对不上就当没取到。
const ASN_SHAPE = /^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/;
// 整行都要对上（不只是找到子串）：id 里混了引号之类的怪字符时，不会截出一个看着合格的前缀。
const BUNDLE_ID_IN_INFO = /^[ \t]*bundleID="([A-Za-z0-9.-]{1,255})"[ \t]*$/m;
// token 只会是这个形状；不许以 - 开头，免得被当成 open 的选项。
const TOKEN_SHAPE = /^[A-Za-z0-9.][A-Za-z0-9.-]{0,254}$/;
const MAX_LOG_CHARS = 200;

function isOurChromium(bundleId: string): boolean {
  const id = bundleId.toLowerCase();
  return id.includes('chromium') || id.includes('chrome.for.testing');
}

// isOurBrowser：除了默认的 Chromium，还有哪些 bundle id 算 e2k 的浏览器（换了 provider 时用，比如 ego lite 的 bundle id 不含 chromium）。
export function macFocus(o: { exec?: ExecFn; platform?: NodeJS.Platform; log?: (line: string) => void; isOurBrowser?: (bundleId: string) => boolean } = {}): FocusKeeper {
  if ((o.platform ?? process.platform) !== 'darwin') return noFocus;
  const exec = o.exec ?? defaultExec;
  const ours = (id: string): boolean => isOurChromium(id) || o.isOurBrowser?.(id) === true;

  const note = (what: string, e: unknown): void => {
    try {
      const text = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, MAX_LOG_CHARS);
      o.log?.(`焦点：${what}失败：${text}`);
    } catch {
      // 日志写不了也不能影响调用方
    }
  };

  // 当前前台应用的 bundle id；读不到或对不上形状返回 null。抛错留给调用方吞。
  const frontBundleId = async (): Promise<string | null> => {
    const asn = (await exec('lsappinfo', ['front'], { timeout: CALL_TIMEOUT_MS })).stdout.trim();
    if (!ASN_SHAPE.test(asn)) return null;
    const out = (await exec('lsappinfo', ['info', '-only', 'bundleID', asn], { timeout: CALL_TIMEOUT_MS })).stdout;
    return BUNDLE_ID_IN_INFO.exec(out)?.[1] ?? null;
  };

  return {
    async capture() {
      try {
        const id = await frontBundleId();
        return id === null || ours(id) ? null : id;
      } catch (e) {
        note('读取前台应用', e);
        return null;
      }
    },
    async restore(token) {
      if (token === null) return false;
      let opening = false;
      try {
        if (!TOKEN_SHAPE.test(token)) return false;
        const now = await frontBundleId();
        if (now === null || !ours(now)) return false;   // 前台已经不是 e2k 的浏览器（用户自己切走了）：不抢回来
        opening = true;
        await exec('open', ['-b', token], { timeout: CALL_TIMEOUT_MS });
        return true;
      } catch (e) {
        note('还回前台', e);
        return opening;   // open -b 已经动手（哪怕失败）算还过了，不重试；读前台出错则稍后再试
      }
    },
  };
}
