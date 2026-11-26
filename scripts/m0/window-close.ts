// M0 (manual): which events fire when a person closes the browser window by hand?
// Run with `node scripts/m0/window-close.ts`, close the window it opens within 20 seconds, and paste the output back.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const WAIT_MS = 20_000;

const userDataDir = mkdtempSync(join(tmpdir(), 'e2k-close-'));
const context = await chromium.launchPersistentContext(userDataDir, { headless: false, serviceWorkers: 'block' });
let pageClosed = false;
let contextClosed = false;
context.on('close', () => { contextClosed = true; });
try {
  const page = context.pages()[0] ?? await context.newPage();
  page.on('close', () => { pageClosed = true; });
  console.log('请在 20 秒内手动关闭这个浏览器窗口');
  await sleep(WAIT_MS);
  console.log(`page-close: ${pageClosed ? 'fired' : 'not-fired'}`);
  console.log(`context-close: ${contextClosed ? 'fired' : 'not-fired'}`);
} finally {
  await context.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
