// M0 (spike): does per-page CDP touch emulation make `(pointer: coarse)` match on a page of a persistent context?
// Run with `node scripts/m0/touch-probe.ts`. Prints one line per probe.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { CDPSession, Page } from 'playwright';
import { startFixtureServer } from '../../test/support/fixture-server.ts';

const server = await startFixtureServer();
const userDataDir = mkdtempSync(join(tmpdir(), 'e2k-touch-'));
const context = await chromium.launchPersistentContext(userDataDir, { headless: false, serviceWorkers: 'block' });
const probe = (p: Page): Promise<string> => p.evaluate(() => [
  'pointer:coarse=' + matchMedia('(pointer: coarse)').matches,
  'any-pointer:coarse=' + matchMedia('(any-pointer: coarse)').matches,
  'hover:none=' + matchMedia('(hover: none)').matches,
  'maxTouchPoints=' + navigator.maxTouchPoints,
  'ontouchstart=' + ('ontouchstart' in window),
].join(' '));
const log = async (label: string, p: Page): Promise<void> => { console.log(label.padEnd(44), await probe(p)); };
try {
  // 方法一：setTouchEmulationEnabled
  const a = await context.newPage();
  await log('plain blank page', a);
  const cdpA: CDPSession = await context.newCDPSession(a);
  await cdpA.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await log('A: touch emu, blank page', a);
  await a.goto(server.origin + '/index.html');
  await log('A: touch emu, after goto', a);
  const b = await context.newPage();
  await b.goto(server.origin + '/index.html');
  await log('B: other page, no touch', b);
  await a.setViewportSize({ width: 800, height: 600 });
  await log('A: after setViewportSize', a);
  await a.screenshot({ fullPage: true });
  await log('A: after fullPage screenshot', a);
  await a.goto(server.altOrigin + '/index.html');
  await log('A: after cross-site goto', a);

  // 方法二（退路 A）：setEmulatedMedia features
  const c = await context.newPage();
  const cdpC = await context.newCDPSession(c);
  await cdpC.send('Emulation.setEmulatedMedia', { features: [
    { name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' },
    { name: 'hover', value: 'none' }, { name: 'any-hover', value: 'none' },
  ] });
  await c.goto(server.origin + '/index.html');
  await log('C: emulated media features, after goto', c);
  const d = await context.newPage();
  await d.goto(server.origin + '/index.html');
  await log('D: other page, no emulation', d);
  await c.goto(server.altOrigin + '/index.html');
  await log('C: after cross-site goto', c);

  // 方法三：两者都发
  const e = await context.newPage();
  const cdpE = await context.newCDPSession(e);
  await cdpE.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdpE.send('Emulation.setEmulatedMedia', { features: [
    { name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' },
    { name: 'hover', value: 'none' }, { name: 'any-hover', value: 'none' },
  ] });
  await e.goto(server.origin + '/index.html');
  await log('E: both, after goto', e);

  // 生命周期：detach 之后还在不在？元素截图之后呢？
  const f = await context.newPage();
  const cdpF = await context.newCDPSession(f);
  await cdpF.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await f.goto(server.origin + '/index.html');
  await f.locator('body').screenshot();
  await log('F: after element screenshot', f);
  await cdpF.detach();
  await log('F: after detach', f);
  await f.goto(server.altOrigin + '/index.html');
  await log('F: after detach + cross-site goto', f);

  // 弹窗和跨站 iframe 继承吗？同站 iframe 呢？
  const g = await context.newPage();
  const cdpG = await context.newCDPSession(g);
  await cdpG.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await g.goto(server.origin + '/index.html');
  const popupPromise = context.waitForEvent('page');
  await g.evaluate(`window.open(${JSON.stringify(server.origin + '/index.html')})`);
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await log('G: popup opened by a touch page', popup);
  for (const [label, src] of [['same-site', server.origin], ['cross-site', server.altOrigin]] as const) {
    await g.evaluate(`new Promise((resolve) => { const f = document.createElement('iframe'); f.id = ${JSON.stringify(label)}; f.onload = resolve; f.src = ${JSON.stringify(src + '/index.html')}; document.body.append(f); })`);
    const frame = g.frames().find((f) => f.url().startsWith(src) && f !== g.mainFrame());
    if (frame === undefined) { console.log(`${label} iframe: not found`); continue; }
    console.log(`G: ${label} iframe`.padEnd(44), await frame.evaluate(() => 'pointer:coarse=' + matchMedia('(pointer: coarse)').matches + ' maxTouchPoints=' + navigator.maxTouchPoints));
  }
} finally {
  await context.close().catch(() => {});
  await server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
