// M0: does context.route() see (and stop) every kind of write a page can make?
// Run with `npm run m0`. A headed Chromium window opens for a few seconds.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import type { BrowserContext, Frame, Page } from 'playwright';
import { startFixtureServer } from '../../test/support/fixture-server.ts';
import type { FixtureServer } from '../../test/support/fixture-server.ts';

export interface M0Row { case: string; seenByRoute: boolean; reachedServer: boolean; isNavigation: boolean | null; frameAvailable: boolean | null }
export interface M0Result { playwright: string; chromium: string; crossProcessConfirmed: boolean; rows: M0Row[];
  control: M0Row; // positive control, not one of the 13 scenarios
  serviceWorker: { register: 'resolved' | 'rejected' | 'unsupported'; registration: 'none' | 'present' } }

const LABELS = ['top', 'same', 'cross'] as const;
const KINDS = ['fetch', 'xhr', 'beacon', 'form'] as const;
const BLANK_FORM = 'blank-form';
// Positive control: a write the route handler lets through, so the server must see it.
const CONTROL = 'control-continued-fetch';
const SETTLE_MS = 1000;

interface Seen { isNavigation: boolean; frameAvailable: boolean }

function pinnedPlaywrightVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  return pkg.dependencies?.playwright ?? 'unknown';
}

// Which case a write request belongs to, or null for everything else.
function caseOf(rawUrl: string): string | null {
  const url = new URL(rawUrl);
  if (url.pathname.startsWith('/api/sink')) return url.searchParams.get('case') ?? 'unlabelled';
  if (url.pathname.startsWith('/api/form-blank')) return BLANK_FORM;
  return null;
}

function reached(server: FixtureServer, name: string): boolean {
  if (name === BLANK_FORM) return server.hits.some((h) => h.path === '/api/form-blank');
  return server.hits.some((h) => h.path === '/api/sink' && h.query.case === name);
}

function frameFor(page: Page, label: string): Frame {
  if (label === 'top') return page.mainFrame();
  const frame = page.frames().find((f) => {
    try {
      return new URL(f.url()).searchParams.get('label') === label;
    } catch {
      return false;
    }
  });
  if (frame === undefined) throw new Error(`frame with label=${label} not found`);
  return frame;
}

// Closes every page except `keep` (popups from the previous case included).
async function closeOtherPages(context: BrowserContext, keep: Page | null): Promise<void> {
  for (const p of context.pages()) if (p !== keep) await p.close();
}

async function hasCrossProcessFrame(context: BrowserContext, page: Page, altOrigin: string): Promise<boolean> {
  const cdp = await context.newCDPSession(page);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.some((t) => t.type === 'iframe' && t.url.startsWith(altOrigin));
  } finally {
    await cdp.detach();
  }
}

export async function measure(): Promise<M0Result> {
  const server = await startFixtureServer();
  const userDataDir = mkdtempSync(join(tmpdir(), 'e2k-m0-'));
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false, serviceWorkers: 'block' });
  try {
    const seen = new Map<string, Seen>();
    await context.route('**/*', async (route) => {
      const request = route.request();
      const name = caseOf(request.url());
      if (name === null) return route.continue();
      if (name === CONTROL) {
        seen.set(name, { isNavigation: request.isNavigationRequest(), frameAvailable: true });
        return route.continue();
      }
      let frameAvailable = true;
      try {
        request.frame();
      } catch {
        frameAvailable = false;
      }
      if (!seen.has(name)) seen.set(name, { isNavigation: request.isNavigationRequest(), frameAvailable });
      return route.fulfill({ status: 403, body: 'blocked' });
    });

    const names: string[] = [];

    // Is the cross-origin iframe really in another process?
    const probe = await context.newPage();
    await closeOtherPages(context, probe);
    await probe.goto(`${server.origin}/frames.html`, { waitUntil: 'load' });
    const crossProcessConfirmed = await hasCrossProcessFrame(context, probe, server.altOrigin);
    const userAgent = await probe.evaluate(() => navigator.userAgent);
    const chromiumVersion = /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? 'unknown';

    for (const label of LABELS) {
      for (const kind of KINDS) {
        const name = `${label}-${kind}`;
        names.push(name);
        const page = await context.newPage();
        await closeOtherPages(context, page);
        await page.goto(`${server.origin}/frames.html`, { waitUntil: 'load' });
        await frameFor(page, label).click(`#do-${kind}`);
        await sleep(SETTLE_MS);
      }
    }

    names.push(BLANK_FORM);
    const formPage = await context.newPage();
    await closeOtherPages(context, formPage);
    await formPage.goto(`${server.origin}/form.html`, { waitUntil: 'load' });
    await formPage.click('#submit-blank');
    await sleep(SETTLE_MS);

    const rows: M0Row[] = names.map((name) => {
      const s = seen.get(name);
      return {
        case: name,
        seenByRoute: s !== undefined,
        reachedServer: reached(server, name),
        isNavigation: s?.isNavigation ?? null,
        frameAvailable: s?.frameAvailable ?? null,
      };
    });

    const controlPage = await context.newPage();
    await closeOtherPages(context, controlPage);
    await controlPage.goto(`${server.origin}/frames.html`, { waitUntil: 'load' });
    await controlPage.evaluate((c) => fetch(`/api/sink?case=${c}`, { method: 'POST', body: 'control' }).then((r) => r.status), CONTROL);
    await sleep(SETTLE_MS);
    const controlSeen = seen.get(CONTROL);
    const control: M0Row = {
      case: CONTROL,
      seenByRoute: controlSeen !== undefined,
      reachedServer: reached(server, CONTROL),
      isNavigation: controlSeen?.isNavigation ?? null,
      frameAvailable: controlSeen?.frameAvailable ?? null,
    };

    const swPage = await context.newPage();
    await closeOtherPages(context, swPage);
    await swPage.goto(`${server.origin}/sw.html`, { waitUntil: 'load' });
    await swPage.waitForFunction(() => document.getElementById('sw-state')?.textContent !== '');
    const register = (await swPage.textContent('#sw-register')) ?? '';
    const registration = (await swPage.textContent('#sw-state')) ?? '';
    if (register !== 'resolved' && register !== 'rejected' && register !== 'unsupported') throw new Error('unexpected #sw-register value');
    if (registration !== 'none' && registration !== 'present') throw new Error('unexpected #sw-state value');

    return {
      playwright: pinnedPlaywrightVersion(),
      chromium: chromiumVersion,
      crossProcessConfirmed,
      rows,
      control,
      serviceWorker: { register, registration },
    };
  } finally {
    await context.close();
    await server.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

function cell(v: boolean | null): string {
  return v === null ? 'null' : String(v);
}

function printResult(r: M0Result): void {
  console.log(`playwright ${r.playwright}, chromium ${r.chromium}`);
  console.log('');
  console.log('| case | seenByRoute | reachedServer | isNavigation | frameAvailable |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const row of r.rows) {
    console.log(`| ${row.case} | ${cell(row.seenByRoute)} | ${cell(row.reachedServer)} | ${cell(row.isNavigation)} | ${cell(row.frameAvailable)} |`);
  }
  console.log('');
  console.log('positive control (not a scenario: the route handler continues this request, so it must reach the server)');
  console.log('| case | seenByRoute | reachedServer | isNavigation | frameAvailable |');
  console.log('| --- | --- | --- | --- | --- |');
  console.log(`| ${r.control.case} | ${cell(r.control.seenByRoute)} | ${cell(r.control.reachedServer)} | ${cell(r.control.isNavigation)} | ${cell(r.control.frameAvailable)} |`);
  console.log('');
  console.log(`crossProcessConfirmed: ${r.crossProcessConfirmed}`);
  console.log(`serviceWorker: register=${r.serviceWorker.register} registration=${r.serviceWorker.registration}`);
}

if (import.meta.main) {
  printResult(await measure());
}
