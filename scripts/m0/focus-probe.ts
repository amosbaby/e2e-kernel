// M0: does launching a headed Chromium take the foreground (and so keyboard focus) away from the user?
// Run with `node scripts/m0/focus-probe.ts`. A headed Chromium window opens for about 2 seconds.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const WAIT_MS = 2000;
const OSASCRIPT_TIMEOUT_MS = 10_000;

function frontApp(): string | null {
  try {
    const out = execFileSync('osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], {
      encoding: 'utf8',
      timeout: OSASCRIPT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

const before = frontApp();
if (before === null) {
  console.log('front-app: unavailable');
} else {
  const userDataDir = mkdtempSync(join(tmpdir(), 'e2k-focus-'));
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false, serviceWorkers: 'block' });
  try {
    if (context.pages().length === 0) await context.newPage();
    await sleep(WAIT_MS);
    const after = frontApp();
    if (after === null) {
      console.log(`front-app-before: ${before}`);
      console.log('front-app: unavailable');
    } else {
      console.log(`front-app-before: ${before}`);
      console.log(`front-app-after: ${after}`);
      console.log(`changed: ${before !== after}`);
    }
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
