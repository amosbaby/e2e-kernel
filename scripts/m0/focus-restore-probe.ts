// M2: after a headed launch takes the foreground, can we hand it back, and does opening another page in the
// running instance take it again? Run by hand with `node scripts/m0/focus-restore-probe.ts` and do not touch
// the keyboard or mouse for about 10 seconds. A headed Chromium window opens and closes by itself.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const WAIT_MS = 2000;
const OSASCRIPT_TIMEOUT_MS = 10_000;

function osa(lines: string[], args: string[] = []): string | null {
  try {
    const argv = lines.flatMap((line) => ['-e', line]);
    return execFileSync('osascript', [...argv, ...args], {
      encoding: 'utf8',
      timeout: OSASCRIPT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const frontApp = (): string | null =>
  osa(['tell application "System Events" to get name of first process whose frontmost is true']);
const frontBundleId = (): string | null =>
  osa(['tell application "System Events" to get bundle identifier of first process whose frontmost is true']);
// The bundle id travels as an argv item, never inside the script text.
const activate = (bundleId: string): boolean =>
  osa(['on run argv', 'tell application id (item 1 of argv) to activate', 'end run'], [bundleId]) !== null;

const before = frontApp();
const beforeId = frontBundleId();
if (before === null || beforeId === null) {
  console.log('front-app: unavailable');
} else {
  console.log(`front-app-before: ${before}`);
  const userDataDir = mkdtempSync(join(tmpdir(), 'e2k-focus2-'));
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false, serviceWorkers: 'block' });
  try {
    if (context.pages().length === 0) await context.newPage();
    await sleep(WAIT_MS);
    console.log(`after-launch: ${frontApp()}`);

    console.log(`restore-1-ok: ${activate(beforeId)}`);
    await sleep(WAIT_MS);
    console.log(`after-restore-1: ${frontApp()}`);

    const page = await context.newPage();
    await page.goto('about:blank');
    await sleep(WAIT_MS);
    console.log(`after-new-page: ${frontApp()}`);

    console.log(`restore-2-ok: ${activate(beforeId)}`);
    await sleep(WAIT_MS);
    console.log(`after-restore-2: ${frontApp()}`);
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
