// M0: a person logs in by hand in a headed, persistent profile under the state directory.
// Usage: node scripts/m0/manual-login.ts [--exit-after <seconds>]
// The address is read from stdin after start. It is never printed or logged by this script.
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { E2kError } from '../../src/shared/errors.ts';
import { ensurePrivateDir, resolveHome, resolveInside } from '../../src/shared/paths.ts';
import { httpUrl, int } from '../../src/shared/validate.ts';

const USAGE = [
  '用法：node scripts/m0/manual-login.ts [--exit-after <秒>]',
  '启动后按提示输入要打开的 http 或 https 地址（不能带用户名或密码）。',
].join('\n');
const MAX_EXIT_AFTER_SECONDS = 24 * 60 * 60;

function usageExit(): never {
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): { exitAfterSeconds: number | null } {
  if (argv.length === 0) return { exitAfterSeconds: null };
  if (argv.length !== 2 || argv[0] !== '--exit-after' || !/^[0-9]{1,6}$/.test(argv[1] ?? '')) usageExit();
  try {
    return { exitAfterSeconds: int(Number(argv[1]), '--exit-after', { min: 1, max: MAX_EXIT_AFTER_SECONDS }) };
  } catch {
    usageExit();
  }
}

async function readAddress(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  try {
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
    const line = await Promise.race([rl.question('要打开的地址：'), closed]);
    if (line === null) usageExit();
    return httpUrl(line.trim(), 'address');
  } catch (e) {
    if (e instanceof E2kError) usageExit();
    throw e;
  } finally {
    rl.close();
  }
}

// Resolves once every page of the context is closed, or the context itself is gone.
function allPagesClosed(context: BrowserContext): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => { if (context.pages().length === 0) resolve(); };
    const watch = (page: Page): void => { page.on('close', check); };
    context.pages().forEach(watch);
    context.on('page', watch);
    context.on('close', () => resolve());
  });
}

const { exitAfterSeconds } = parseArgs(process.argv.slice(2));
const address = await readAddress();

let profileDir: string;
try {
  const home = resolveHome(process.env);
  ensurePrivateDir(home.root);
  profileDir = resolveInside(home.root, 'm0-login-profile');
  ensurePrivateDir(profileDir);
} catch (e) {
  if (e instanceof E2kError) {
    console.error(e.message);
    process.exit(e.code === 'usage' ? 2 : 1);
  }
  throw e;
}

const context = await chromium.launchPersistentContext(profileDir, { headless: false, serviceWorkers: 'block' });
try {
  const deadline = exitAfterSeconds === null
    ? new Promise<void>(() => {})
    : new Promise<void>((resolve) => setTimeout(resolve, exitAfterSeconds * 1000).unref());
  const closed = allPagesClosed(context);
  const page = context.pages()[0] ?? await context.newPage();
  // Playwright's error text contains the address, so it is not shown.
  const opened = page.goto(address, { waitUntil: 'commit' }).then(
    () => console.log('已打开。登录完成后关闭浏览器窗口即可。'),
    () => console.log('页面没能打开（不显示地址和错误原文）。可以在窗口里重试，完成后关闭浏览器窗口即可。'),
  );
  await Promise.race([opened, deadline, closed]);
  await Promise.race([deadline, closed]);
} finally {
  await context.close().catch(() => {});
}
