import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DriverError } from '../../src/driver/types.ts';
import type { Decision, Instance, Page, RequestInfo } from '../../src/driver/types.ts';
import { createPlaywrightDriver } from '../../src/drivers/playwright/driver.ts';
import { startFixtureServer } from '../support/fixture-server.ts';
import type { FixtureServer } from '../support/fixture-server.ts';

// 整份文件共用一个 fixture 服务和一个浏览器实例；每条测试自己开一页。
const driver = createPlaywrightDriver();
const tmpDirs: string[] = [];
let server: FixtureServer;
let inst: Instance;
let page: Page;
let seen: RequestInfo[] = [];
let opened: [Page, string | null][] = [];
let decide: (r: RequestInfo) => Decision = () => ({ action: 'continue' });

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const settle = (): Promise<void> => sleep(500);

async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) assert.fail('condition not met within 5 seconds');
    await sleep(50);
  }
}

before(async () => {
  server = await startFixtureServer();
  inst = await driver.launch({ name: 'default', userDataDir: makeTmp('e2k-pw-') });
  inst.setRequestHandler(r => { seen.push(r); return decide(r); });
  inst.onPageOpened((p, openerId) => { opened.push([p, openerId]); });
});

after(async () => {
  await inst?.stop();
  await server?.close();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  decide = () => ({ action: 'continue' });
  seen = [];
  opened = [];
  page = await inst.openPage({});
  await page.goto(server.origin + '/index.html');
});

afterEach(async () => {
  // 弹窗页和测试开的页都收掉，免得影响后面的测试；已经关了的页再关会抛错，忽略。
  for (const [p] of opened) await p.close().catch(() => {});
  await page.close().catch(() => {});
});

test('capabilities follow the measured facts', { timeout: 60_000 }, () => {
  assert.deepEqual(driver.capabilities, {
    networkInterception: true,
    crossProcessIframes: 'covered',
    nativeFormSubmit: 'covered',
    sharesUserProfile: false,
    canHeadless: true,
    selectorDialect: 'playwright',
  });
  assert.equal(driver.name, 'playwright');
});

test('selfCheck reports the bundled chromium', { timeout: 60_000 }, async () => {
  const checks = await driver.selfCheck();
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.name, 'chromium-installed');
  assert.equal(checks[0]?.ok, true);
});

test('launch refuses a relative or empty user data dir', { timeout: 60_000 }, async () => {
  for (const userDataDir of ['', 'relative/dir'])
    await assert.rejects(driver.launch({ name: 'x', userDataDir }), (e: DriverError) => e instanceof DriverError && e.kind === 'other');
});

test('the launched browser is headed', { timeout: 60_000 }, async () => {
  const ua = await page.evaluate('navigator.userAgent');
  assert.equal(typeof ua, 'string');
  assert.ok(!(ua as string).includes('Headless'), ua as string);
});

test('request handler sees writes with bodies and can block them', { timeout: 60_000 }, async () => {
  decide = r => r.method === 'PUT' ? { action: 'fulfill', status: 403, contentType: 'text/plain', body: 'blocked' } : { action: 'continue' };
  await page.click('#save'); await settle();
  assert.ok(seen.some(r => r.method === 'PUT' && r.url.endsWith('/api/items/1') && r.pageId === page.id));
  assert.ok(!server.hits.some(h => h.method === 'PUT'));
  decide = () => ({ action: 'continue' });
  await page.fill('#new-item', 'Delta'); await page.click('[data-testid="add"]'); await settle();
  const post = seen.find(r => r.method === 'POST' && r.url.endsWith('/api/items'))!;
  assert.match(post.body!, /"name":"Delta"/); assert.equal(post.contentType, 'application/json');
});

test('a throwing handler aborts the request', { timeout: 60_000 }, async () => {
  const before = server.hits.length;
  decide = () => { throw new Error('boom'); };
  await page.click('[data-testid="add"]'); await settle();
  assert.equal(server.hits.length, before);
});

test('an abort decision stops the request, and the finished request is reported', { timeout: 60_000 }, async () => {
  const done: { id: string; status: number | null; failed: boolean }[] = [];
  inst.onRequestDone(e => { done.push(e); });
  const before = server.hits.length;
  decide = r => r.method === 'POST' ? { action: 'abort' } : { action: 'continue' };
  await page.click('[data-testid="add"]'); await settle();
  assert.equal(server.hits.length, before);
  const post = seen.find(r => r.method === 'POST' && r.url.endsWith('/api/items'))!;
  assert.deepEqual(done.filter(e => e.id === post.id), [{ id: post.id, status: null, failed: true }]);
  await page.goto(server.origin + '/index.html'); await settle();
  const get = seen.filter(r => r.method === 'GET' && r.isNavigation).at(-1)!;
  assert.deepEqual(done.filter(e => e.id === get.id), [{ id: get.id, status: 200, failed: false }]);
});

test('writes issued by an evaluated script go through the handler too', { timeout: 60_000 }, async () => {
  await page.evaluate(`fetch('/api/items?from=eval', { method: 'POST', body: '{}' })`); await settle();
  assert.ok(seen.some(r => r.method === 'POST' && r.url.includes('from=eval') && r.pageId === page.id));
  assert.equal(await page.evaluate('document.title'), 'Fixture Items');
});

test('request ids are unique, even for identical requests', { timeout: 60_000 }, async () => {
  await page.evaluate(`fetch('/api/items?same=1', { method: 'POST', body: '{}' })`);
  await page.evaluate(`fetch('/api/items?same=1', { method: 'POST', body: '{}' })`);
  await settle();
  const posts = seen.filter(r => r.method === 'POST' && r.url.includes('same=1'));
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0]!.id, posts[1]!.id);
  assert.equal(new Set(seen.map(r => r.id)).size, seen.length);
});

test('page and request ids are not reused across launches of one driver object', { timeout: 60_000 }, async () => {
  const second = await driver.launch({ name: 'second', userDataDir: makeTmp('e2k-pw-') });
  try {
    const secondSeen: RequestInfo[] = [];
    second.setRequestHandler(r => { secondSeen.push(r); return { action: 'continue' }; });
    const other = await second.openPage({});
    assert.notEqual(other.id, page.id);
    await other.goto(server.origin + '/index.html');
    assert.ok(secondSeen.length > 0);
    const firstIds = new Set(seen.map(r => r.id));
    for (const r of secondSeen) assert.ok(!firstIds.has(r.id), r.id);
  } finally {
    await second.stop();
  }
});

test('native form submits show up as navigation writes', { timeout: 60_000 }, async () => {
  // docs/m0-findings.md 的结论是 nativeFormSubmit: 'not-covered' 时，把这条的断言体换成：
  //   assert.equal(createPlaywrightDriver().capabilities.nativeFormSubmit, 'not-covered');
  await page.goto(server.origin + '/form.html');
  await page.click('#submit-form'); await settle();
  assert.ok(seen.some(r => r.method === 'POST' && r.url.endsWith('/api/form') && r.isNavigation && r.pageId === page.id));
  await page.goto(server.origin + '/form.html');
  await page.click('#submit-blank'); await settle();
  assert.ok(seen.some(r => r.method === 'POST' && r.url.endsWith('/api/form-blank')));   // pageId 可能是 null，见 m0-findings「归属」
});

test('writes from a cross-process iframe reach the handler with the right page id', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/frames.html');
  await page.click('iframe[title="cross"] >> internal:control=enter-frame >> #do-fetch'); await settle();
  const post = seen.find(r => r.url.includes('case=cross-fetch'))!;
  assert.ok(post, 'the cross-origin iframe write was not seen');
  assert.equal(post.method, 'POST');
  assert.equal(post.pageId, page.id);
  assert.equal(post.topFrame, false);
  assert.equal(post.topUrl, server.origin + '/frames.html');
  assert.ok(post.url.startsWith(server.altOrigin), post.url);
});

test('popup requests carry their opener; a popup closing itself fires Page.onClosed', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/popup.html');
  await page.click('#open-popup');
  await until(() => seen.some(r => r.url.includes('case=popup-fetch')));
  const post = seen.find(r => r.url.includes('case=popup-fetch'))!;
  assert.ok(post.pageId !== null && post.pageId !== page.id); assert.equal(post.openerPageId, page.id);
  await until(() => opened.length === 1);
  const [popup, openerId] = opened[0]!;
  assert.equal(popup.id, post.pageId); assert.equal(openerId, page.id);
  let closed = 0; popup.onClosed(() => closed++);
  await popup.click('#close-self');
  await until(() => closed === 1);
});

test('location reports the url, title, frames and popups', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/popup.html');
  await page.click('#open-popup');
  await until(() => opened.length === 1);
  const loc = await page.location();
  assert.equal(loc.url, server.origin + '/popup.html');
  assert.equal(loc.title, 'Fixture Popup');
  assert.deepEqual(loc.frames, []);
  assert.equal(loc.popups.length, 1);
  assert.ok(loc.popups[0]!.endsWith('/popup-child.html'), loc.popups[0]);
  await page.goto(server.origin + '/frames.html');
  const framed = await page.location();
  assert.equal(framed.frames.length, 2);
  assert.ok(framed.frames.some(f => f.url.startsWith(server.altOrigin)));
});

test('goto and waitFor failures map to DriverError kinds', { timeout: 60_000 }, async () => {
  await assert.rejects(page.goto('http://127.0.0.1:9/'), (e: DriverError) => e instanceof DriverError && e.kind === 'other' && !e.message.includes('\n'));
  await assert.rejects(page.waitFor({ text: 'never appears' }, 300), (e: DriverError) => e instanceof DriverError && e.kind === 'timeout');
});

test('no service worker gets registered', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/sw.html');
  await page.waitFor({ target: '#sw-state', state: 'visible' }, 5000);
  assert.equal(await page.read({ kind: 'text', target: '#sw-state' }), 'none');
  // docs/m0-findings.md「Service Worker」一节的实测：register() 本身是 resolve 的，但没有注册生成。
  assert.equal(await page.read({ kind: 'text', target: '#sw-register' }), 'resolved');
});

test('websocket connections are counted', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/ws.html');
  await page.waitFor({ text: 'open' }, 5000);
  assert.equal((await page.location()).webSockets, 1);
});

test('closing a page fires its onClosed exactly once, and a second close is refused', { timeout: 60_000 }, async () => {
  const mine = await inst.openPage({ viewport: { width: 800, height: 600 } });
  let closed = 0; mine.onClosed(() => closed++);
  await mine.close(); await settle();
  assert.equal(closed, 1);
  await assert.rejects(mine.close(), (e: DriverError) => e instanceof DriverError && e.kind === 'other');
  await settle();
  assert.equal(closed, 1);
});

test('stopping the instance fires onClosed once for it and for each open page, and stop is idempotent', { timeout: 60_000 }, async () => {
  const own = await driver.launch({ name: 'stopper', userDataDir: makeTmp('e2k-stop-') });
  const p = await own.openPage({});
  let instClosed = 0; own.onClosed(() => instClosed++);
  let pageClosed = 0; p.onClosed(() => pageClosed++);
  await own.stop(); await settle();
  assert.equal(instClosed, 1);
  assert.equal(pageClosed, 1);
  assert.equal((await own.health()).ok, false);
  await own.stop(); await settle();
  assert.equal(instClosed, 1);
  assert.equal(pageClosed, 1);
  await assert.rejects(own.openPage({}), (e: DriverError) => e instanceof DriverError && e.kind === 'other');
});

test('killing the browser process fires Instance.onClosed', { timeout: 60_000 }, async () => {
  const dir = makeTmp('e2k-kill-');
  const victim = await createPlaywrightDriver().launch({ name: 'x', userDataDir: dir });
  let closed = 0; victim.onClosed(() => closed++);
  try { execFileSync('pkill', ['-9', '-f', dir]); } catch { /* pkill 没匹配到时退出码非零，下面的断言会失败 */ }
  await until(() => closed === 1);
  assert.equal((await victim.health()).ok, false);
});
