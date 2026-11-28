import { existsSync, lstatSync, realpathSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { chromium } from 'playwright';
import { E2kError } from '../../shared/errors.ts';
import { macBundleId } from './browser-process.ts';
import type { BrowserSelector } from '../../driver/types.ts';

// 浏览器 provider：内核用哪个可执行文件、按什么规矩启动。只是一张很小的表，不是插件系统。
// 选择只能由人在 `e2k start` / `e2k doctor` 时给（命令行选项或环境变量），协议和 MCP 里没有，agent 不能在会话里换浏览器。
// 启动方式不因 provider 而变：仍是自己 spawn、管道通信、专用 user-data-dir，不开调试端口（见 browser-process.ts）。

export type ProviderId = 'playwright-chromium' | 'ego-lite' | 'custom';
export const DEFAULT_PROVIDER: ProviderId = 'playwright-chromium';

export interface Provider {
  id: ProviderId;
  label: string;                       // 报告和 doctor 里显示
  executable: string;                  // 可执行文件的绝对路径；缺省 provider 没装时可能是空串（selfCheck 报告）
  closeOnboarding: boolean;            // 启动后关掉浏览器自己的首次引导页（chrome://onboarding/）
  honorsNoStartupWindow: boolean;      // 是否遵守 --no-startup-window；不遵守的启动时会多出一个窗口
  flushOnPageClose: boolean;           // 停止之前要先关掉还开着的页，cookie 才会落盘（不理 Browser.close 的浏览器）
  bundleId?: string;                   // macOS 应用的 bundle id（焦点管家认「前台是不是 e2k 的浏览器」用）
}

const EGO_LITE_RELATIVE = 'ego lite.app/Contents/MacOS/ego lite';
const PRESETS: readonly string[] = ['ego-lite', 'playwright-chromium'];

export interface ProviderEnv {
  home?: string;                                        // 用户主目录，测试注入
  appDirs?: string[];                                   // 找预置应用的目录，缺省 /Applications 和 ~/Applications，测试注入
  platform?: NodeJS.Platform;
  bundleIdOf?: (executable: string) => string | undefined;
  uid?: number;
}

function bad(why: string): E2kError {
  return new E2kError('usage', `浏览器路径不合格：${why}`, '指定一个你自己安装的浏览器的绝对路径；不要用别人可写的位置');
}

// 路径检查：绝对路径；真实路径是可执行的普通文件；属主是当前用户或 root；文件和它所在的目录都不是任何人可写（world-writable）。
// 报错不回显路径（路径是调用方给的值）。返回真实路径。
export function checkExecutable(path: string, env: ProviderEnv = {}): string {
  if (typeof path !== 'string' || path === '' || path.length > 1024 || path.includes('\0') || !isAbsolute(path)) throw bad('要是绝对路径');
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw bad('找不到这个文件');
  }
  const uid = env.uid ?? process.getuid?.() ?? -1;
  for (const p of [real, dirname(real)]) {
    const st = lstatSync(p);
    if (p === real && !st.isFile()) throw bad('不是普通文件');
    if (st.uid !== uid && st.uid !== 0) throw bad('属主不是当前用户也不是 root');
    if ((st.mode & 0o002) !== 0) throw bad('其他人可写');   // 组可写放行：macOS 上用户自己装的应用常带 g+w，同一用户的进程本来就能改它
  }
  try {
    accessSync(real, constants.X_OK);
  } catch {
    throw bad('不可执行');
  }
  return real;
}

function defaultProvider(): Provider {
  let executable = '';
  try {
    executable = chromium.executablePath();
  } catch { /* 没装：selfCheck 报告 */ }
  return { id: 'playwright-chromium', label: 'Playwright Chromium', executable, closeOnboarding: false, honorsNoStartupWindow: true, flushOnPageClose: false };
}

function withBundleId(p: Provider, env: ProviderEnv): Provider {
  if ((env.platform ?? process.platform) !== 'darwin') return p;
  const id = (env.bundleIdOf ?? macBundleId)(p.executable);
  return id === undefined ? p : { ...p, bundleId: id };
}

export function resolveProvider(sel: BrowserSelector = {}, env: ProviderEnv = {}): Provider {
  if (sel.path !== undefined && sel.preset !== undefined) throw new E2kError('usage', '--browser 和 --browser-path 只能给一个');
  if (sel.path !== undefined) {
    const executable = checkExecutable(sel.path, env);
    return withBundleId({ id: 'custom', label: '自定义浏览器', executable, closeOnboarding: false, honorsNoStartupWindow: true, flushOnPageClose: false }, env);
  }
  const preset = sel.preset ?? DEFAULT_PROVIDER;
  if (!PRESETS.includes(preset)) throw new E2kError('usage', `没有这个浏览器预置：可选 ${PRESETS.join('、')}`);
  if (preset === 'playwright-chromium') return defaultProvider();
  const home = env.home ?? homedir();
  const found = (env.appDirs ?? ['/Applications', join(home, 'Applications')]).map((d) => join(d, EGO_LITE_RELATIVE)).find((p) => existsSync(p));
  if (found === undefined) throw new E2kError('usage', '没找到 ego lite：它应该装在 /Applications 或 ~/Applications 里', '用 --browser-path 指定它的可执行文件');
  const executable = checkExecutable(found, env);
  return withBundleId({ id: 'ego-lite', label: 'ego lite', executable, closeOnboarding: true, honorsNoStartupWindow: false, flushOnPageClose: true }, env);
}
