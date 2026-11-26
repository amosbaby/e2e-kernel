// M0: does context.route() see (and stop) writes made by a Dedicated Worker and a SharedWorker?
// Run with `node scripts/m0/worker-probe.ts` (or `npm run m0`). A headed Chromium window opens for a few seconds.
// Exit code 0 when the result matches docs/m0-findings.md section 9.9, 1 otherwise.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const SETTLE_MS = 2500;
const CASES = ['control-page', 'dedicated-worker', 'shared-worker'] as const;
type CaseName = (typeof CASES)[number];

interface Row { case: CaseName; seenByRoute: boolean; frameAvailable: boolean | null; resourceType: string | null; reachedServer: boolean }
interface RunResult { rows: Row[]; sharedWorkerScript: { seenByRoute: boolean; resourceType: string | null }; sharedWorkerType: string; sharedConstructor: string }

// Both workers POST to /api/sink?case=<name>; the SharedWorker only does so once a page connects to it.
function workerSource(name: CaseName, onStart: string): string {
  return `const go = () => fetch('/api/sink?case=${name}', { method: 'POST', body: 'x' }).catch(() => {});\n${onStart}`;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>worker probe</title><script>
  new Worker('/dw.js');
  try { const s = new SharedWorker('/sw.js'); s.port.start(); document.documentElement.dataset.shared = 'constructed'; }
  catch (e) { document.documentElement.dataset.shared = 'threw'; }
  fetch('/api/sink?case=control-page', { method: 'POST', body: 'x' }).catch(() => {});
</script>`;

// One run: a fresh server and a fresh context. `deleteSharedWorker` adds the init script that removes the constructor.
async function run(deleteSharedWorker: boolean): Promise<RunResult> {
  const reached = new Set<string>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/sink') {
      reached.add(url.searchParams.get('case') ?? 'unlabelled');
      res.end('ok');
    } else if (url.pathname === '/dw.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(workerSource('dedicated-worker', 'go();'));
    } else if (url.pathname === '/sw.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(workerSource('shared-worker', 'onconnect = () => go();'));
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const userDataDir = mkdtempSync(join(tmpdir(), 'e2k-worker-probe-'));
  const context = await chromium.launchPersistentContext(userDataDir, { headless: false, serviceWorkers: 'block' });
  try {
    if (deleteSharedWorker) {
      await context.addInitScript(() => {
        try { delete (globalThis as { SharedWorker?: unknown }).SharedWorker; } catch { /* 删不掉就让探针发现 */ }
      });
    }
    const seen = new Map<string, { frameAvailable: boolean; resourceType: string }>();
    let sharedScript: { resourceType: string } | null = null;
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/sw.js') sharedScript = { resourceType: request.resourceType() };
      if (url.pathname !== '/api/sink') return route.continue();
      let frameAvailable = true;
      try {
        request.frame();
      } catch {
        frameAvailable = false;
      }
      seen.set(url.searchParams.get('case') ?? 'unlabelled', { frameAvailable, resourceType: request.resourceType() });
      return route.abort();
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    await sleep(SETTLE_MS);
    const sharedWorkerType = await page.evaluate(() => typeof (globalThis as { SharedWorker?: unknown }).SharedWorker);
    const sharedConstructor = (await page.evaluate(() => document.documentElement.dataset.shared)) ?? 'unknown';
    const rows = CASES.map((name): Row => {
      const s = seen.get(name);
      return { case: name, seenByRoute: s !== undefined, frameAvailable: s?.frameAvailable ?? null, resourceType: s?.resourceType ?? null, reachedServer: reached.has(name) };
    });
    const script = sharedScript as { resourceType: string } | null;
    return { rows, sharedWorkerScript: { seenByRoute: script !== null, resourceType: script?.resourceType ?? null }, sharedWorkerType, sharedConstructor };
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

function cell(v: boolean | string | null): string {
  return v === null ? 'null' : String(v);
}

function printRun(title: string, r: RunResult): void {
  console.log(title);
  console.log('| case | seenByRoute | frameAvailable | resourceType | reachedServer |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const row of r.rows) {
    console.log(`| ${row.case} | ${cell(row.seenByRoute)} | ${cell(row.frameAvailable)} | ${cell(row.resourceType)} | ${cell(row.reachedServer)} |`);
  }
  console.log(`shared worker script /sw.js: seenByRoute=${r.sharedWorkerScript.seenByRoute} resourceType=${cell(r.sharedWorkerScript.resourceType)}`);
  console.log(`typeof SharedWorker: ${r.sharedWorkerType}, new SharedWorker(): ${r.sharedConstructor}`);
  console.log('');
}

function row(r: RunResult, name: CaseName): Row {
  const found = r.rows.find((x) => x.case === name);
  if (found === undefined) throw new Error(`missing row ${name}`);
  return found;
}

// What the findings document claims. Any difference means Playwright or Chromium changed and the document must be redone.
function problems(normal: RunResult, init: RunResult): string[] {
  const out: string[] = [];
  for (const name of ['control-page', 'dedicated-worker'] as const) {
    const x = row(normal, name);
    if (!x.seenByRoute || x.reachedServer) out.push(`${name}: expected seenByRoute=true reachedServer=false, got ${x.seenByRoute} ${x.reachedServer}`);
    if (x.frameAvailable !== true) out.push(`${name}: expected frameAvailable=true`);
  }
  const shared = row(normal, 'shared-worker');
  if (shared.seenByRoute || !shared.reachedServer) out.push(`shared-worker: expected seenByRoute=false reachedServer=true, got ${shared.seenByRoute} ${shared.reachedServer}`);
  const stripped = row(init, 'shared-worker');
  if (stripped.reachedServer) out.push('shared-worker with init script: the write still reached the server');
  if (init.sharedWorkerType !== 'undefined' || init.sharedConstructor !== 'threw') out.push('shared-worker with init script: SharedWorker is still usable');
  const strippedPage = row(init, 'control-page');
  if (!strippedPage.seenByRoute || strippedPage.reachedServer) out.push('control-page with init script: expected seenByRoute=true reachedServer=false');
  return out;
}

if (import.meta.main) {
  const normal = await run(false);
  const init = await run(true);
  printRun('default (no init script)', normal);
  printRun("with addInitScript(() => { delete globalThis.SharedWorker })", init);
  const bad = problems(normal, init);
  if (bad.length === 0) {
    console.log('result: as documented');
  } else {
    console.log('result: DIFFERS from docs/m0-findings.md');
    for (const b of bad) console.log(`- ${b}`);
    process.exitCode = 1;
  }
}
