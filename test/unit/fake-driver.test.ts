import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTION_TIMEOUT_MS, DriverError, NAVIGATION_TIMEOUT_MS } from '../../src/driver/types.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';

async function setup(spec: FakePageSpec) {
  const d = new FakeDriver({ pages: { 'http://localhost/a': spec, 'http://localhost/down': { gotoFailWith: 'timeout' } } });
  const inst = await d.launch({ name: 'default', userDataDir: '/tmp/e2k-fake-profile' });
  const page = await inst.openPage({});
  await page.goto('http://localhost/a');
  return { d, inst, page };
}

test('constants and DriverError', () => {
  assert.equal(ACTION_TIMEOUT_MS, 10_000);
  assert.equal(NAVIGATION_TIMEOUT_MS, 30_000);
  const e = new DriverError('timeout', 'slow');
  assert.ok(e instanceof Error);
  assert.equal(e.kind, 'timeout');
  assert.equal(e.message, 'slow');
});

test('records calls and serves page specs', async () => {
  const { d, page } = await setup({ title: 'A', snapshot: '- button "Add" [ref=e2]', elements: { e2: { text: 'Add' } } });
  await page.click('e2');
  assert.equal(await page.snapshot({}), '- button "Add" [ref=e2]');
  assert.deepEqual(d.calls.at(-2), { pageId: page.id, method: 'click', args: ['e2'] });
  assert.equal(d.launches, 1);
});

test('element failures, goto failures and read semantics', async () => {
  const { inst, page } = await setup({ elements: { '#gone': { failWith: 'not-found' }, '#flaky': { describeFails: 1, stable: null } } });
  await assert.rejects(page.click('#gone'), (e: DriverError) => e.kind === 'not-found');
  await assert.rejects(page.read({ kind: 'text', target: '#nope' }), (e: DriverError) => e.kind === 'not-found');
  assert.equal(await page.read({ kind: 'count', target: '#nope' }), 0);
  assert.equal(await page.read({ kind: 'visible', target: '#nope' }), false);
  await assert.rejects(page.describe('#flaky'), DriverError);
  assert.deepEqual(await page.describe('#flaky'), { stable: null, isPassword: false, kind: 'other' });
  const other = await inst.openPage({});
  await assert.rejects(other.goto('http://localhost/down'), (e: DriverError) => e.kind === 'timeout');
  await assert.rejects(page.click('#not-in-spec'), (e: DriverError) => e.kind === 'not-found');
});

test('request handler: default abort, handler decision, abort when the handler throws', async () => {
  const { d, inst, page } = await setup({});
  assert.deepEqual(await d.emitRequest({ pageId: page.id, method: 'POST', url: 'http://localhost/api' }), { action: 'abort' });
  inst.setRequestHandler(() => ({ action: 'continue' }));
  assert.deepEqual(await d.emitRequest({ pageId: page.id, method: 'POST', url: 'http://localhost/api' }), { action: 'continue' });
  inst.setRequestHandler(() => ({ action: 'abort' }));
  assert.deepEqual(await d.emitRequest({ pageId: page.id, method: 'POST', url: 'http://localhost/api' }), { action: 'abort' });
  inst.setRequestHandler(() => { throw new Error('x'); });
  assert.deepEqual(await d.emitRequest({ pageId: page.id, method: 'GET', url: 'http://localhost/' }), { action: 'abort' });
});

test('popups are announced with their opener', async () => {
  const { d, inst, page } = await setup({});
  const seen: [string, string | null][] = []; inst.onPageOpened((p, opener) => seen.push([p.id, opener]));
  const popup = d.emitPopup(page.id, 'http://localhost/popup');
  assert.deepEqual(seen, [[popup.id, page.id]]);
});

test('closePage and closeBrowser fire the right listeners', async () => {
  const { d, inst, page } = await setup({});
  const second = await inst.openPage({});
  let pageClosed = 0, secondClosed = 0, browserClosed = 0;
  page.onClosed(() => pageClosed++); second.onClosed(() => secondClosed++); inst.onClosed(() => browserClosed++);
  d.closePage(page.id);
  assert.deepEqual([pageClosed, secondClosed, browserClosed], [1, 0, 0]); assert.deepEqual(d.openPages(), [second.id]);
  d.closeBrowser();
  assert.deepEqual([pageClosed, secondClosed, browserClosed], [1, 1, 1]); assert.equal((await inst.health()).ok, false);
});

// 约定：先置为已关闭，再依次触发每页的 onClosed、实例的 onClosed；监听器里查状态必须已经是「已关」。
test('closeBrowser sets the closed state before any listener runs', async () => {
  const { d, inst, page } = await setup({});
  const order: string[] = [];
  page.onClosed(() => { order.push('page'); assert.deepEqual(d.openPages(), []); });
  inst.onClosed(() => { order.push('instance'); });
  page.onClosed(() => { void inst.health().then((c) => order.push(`health:${c.ok}`)); });
  await new Promise<void>((resolve) => { inst.onClosed(() => resolve()); d.closeBrowser(); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['page', 'instance', 'health:false']);
  await assert.rejects(page.snapshot({}), (e: DriverError) => e.kind === 'other');
  await assert.rejects(inst.openPage({}), (e: DriverError) => e.kind === 'other');
});

test('a closed page rejects every method with DriverError other', async () => {
  const { d, page } = await setup({ elements: { e1: { text: 'x' } } });
  d.closePage(page.id);
  await assert.rejects(page.click('e1'), (e: DriverError) => e.kind === 'other');
  await assert.rejects(page.location(), (e: DriverError) => e.kind === 'other');
  await assert.rejects(page.goto('http://localhost/a'), (e: DriverError) => e.kind === 'other');
});

// 约定：页面 id 和请求 id 在驱动对象的整个生命期内唯一，不按实例或按启动重置。
test('page and request ids stay unique across browser restarts', async () => {
  const d = new FakeDriver();
  const pageIds: string[] = [];
  const requestIds: string[] = [];
  for (let round = 0; round < 2; round++) {
    const inst = await d.launch({ name: 'default', userDataDir: '/tmp/e2k-fake-profile' });
    inst.setRequestHandler((r) => { requestIds.push(r.id); return { action: 'continue' }; });
    const page = await inst.openPage({});
    pageIds.push(page.id, d.emitPopup(page.id, 'http://localhost/popup').id);
    await d.emitRequest({ pageId: page.id, method: 'GET', url: 'http://localhost/' });
    await d.emitRequest({ pageId: page.id, method: 'GET', url: 'http://localhost/x' });
    d.closeBrowser();
  }
  assert.equal(d.launches, 2);
  assert.equal(pageIds.length, 4);
  assert.equal(new Set(pageIds).size, 4);
  assert.equal(requestIds.length, 4);
  assert.equal(new Set(requestIds).size, 4);
});

test('emitRequest fills in RequestInfo and emitRequestDone reaches listeners', async () => {
  const { d, inst, page } = await setup({});
  let seen: unknown = null;
  inst.setRequestHandler((r) => { seen = r; return { action: 'continue' }; });
  await d.emitRequest({ pageId: page.id, method: 'GET', url: 'http://localhost/doc', isNavigation: true, resourceType: 'document' });
  const r = seen as { id: string; pageId: string; openerPageId: null; isNavigation: boolean; resourceType: string; body: null };
  assert.equal(r.pageId, page.id);
  assert.equal(r.openerPageId, null);
  assert.equal(r.isNavigation, true);
  assert.equal(r.resourceType, 'document');
  assert.equal(r.body, null);
  const done: unknown[] = [];
  inst.onRequestDone((e) => done.push(e));
  d.emitRequestDone(r.id, 200);
  assert.deepEqual(done, [{ id: r.id, status: 200, failed: false }]);
});

test('emitRequestDone carries failed and redirectRefused, and a continue with followRedirects: false is recorded', async () => {
  const { d, inst, page } = await setup({});
  inst.setRequestHandler((r) => (r.url.endsWith('/w') ? { action: 'continue', followRedirects: false } : { action: 'continue' }));
  const w = await d.emitRequest({ pageId: page.id, method: 'POST', url: 'http://localhost/w' });
  await d.emitRequest({ pageId: page.id, method: 'POST', url: 'http://localhost/other' });
  assert.deepEqual(w, { action: 'continue', followRedirects: false });
  assert.equal(d.noRedirectIds.length, 1);
  const done: unknown[] = [];
  inst.onRequestDone((e) => done.push(e));
  d.emitRequestDone('a', 307, { redirectRefused: true });
  d.emitRequestDone('b', null, { failed: true });
  d.emitRequestDone('c', 200);
  assert.deepEqual(done, [
    { id: 'a', status: 307, failed: true, redirectRefused: true },
    { id: 'b', status: null, failed: true },
    { id: 'c', status: 200, failed: false },
  ]);
});

// 约定：{ ms } 真的睡这么久，其他条件立刻成功，都记下 (cond, timeoutMs)。
test('waitFor sleeps for ms conditions and succeeds immediately otherwise', async () => {
  const { d, page } = await setup({});
  const t0 = performance.now();
  await page.waitFor({ ms: 60 }, 1000);
  assert.ok(performance.now() - t0 >= 55, 'ms condition must really sleep');
  assert.deepEqual(d.calls.at(-1), { pageId: page.id, method: 'waitFor', args: [{ ms: 60 }, 1000] });
  const t1 = performance.now();
  await page.waitFor({ text: 'never on the page' }, 5000);
  await page.waitFor({ target: '#absent', state: 'visible' }, 5000);
  assert.ok(performance.now() - t1 < 50);
  assert.deepEqual(d.calls.at(-1), { pageId: page.id, method: 'waitFor', args: [{ target: '#absent', state: 'visible' }, 5000] });
});

// 约定：规格里有 stable 键就原样返回（含 null）；没有时选择器给 given，引用给 null。
test('describe: explicit stable wins, otherwise selector is given and ref is unresolved', async () => {
  const testid = { selector: '[data-testid="save"]', via: 'testid' as const };
  const { page } = await setup({ elements: {
    e3: { stable: testid }, e4: {}, '#pw': { password: true }, '#nulled': { stable: null }, '#t': { kind: 'text-input' },
  } });
  assert.deepEqual(await page.describe('e3'), { stable: testid, isPassword: false, kind: 'other' });
  assert.deepEqual(await page.describe('e4'), { stable: null, isPassword: false, kind: 'other' });   // 规格没写 kind：往保守处判
  assert.deepEqual(await page.describe('#pw'), { stable: { selector: '#pw', via: 'given' }, isPassword: true, kind: 'other' });
  assert.deepEqual(await page.describe('#nulled'), { stable: null, isPassword: false, kind: 'other' });
  assert.deepEqual(await page.describe('#t'), { stable: { selector: '#t', via: 'given' }, isPassword: false, kind: 'text-input' });
  await assert.rejects(page.describe('e99'), (e: DriverError) => e.kind === 'not-found');
});

test('fill, read, text, location, console, eval and screenshot', async () => {
  const { page } = await setup({
    title: 'A', evalResult: 42, console: [{ level: 'log', text: 'hi' }],
    elements: { '#in': { text: '' }, '#big': { css: { 'font-size': '18px' }, count: 3, visible: false } },
  });
  await page.fill('#in', 'hello');
  assert.equal(await page.read({ kind: 'text', target: '#in' }), 'hello');
  assert.equal(await page.text({ target: '#in' }), 'hello');
  assert.equal(await page.read({ kind: 'css', target: '#big', property: 'font-size' }), '18px');
  assert.equal(await page.read({ kind: 'count', target: '#big' }), 3);
  assert.equal(await page.read({ kind: 'visible', target: '#big' }), false);
  assert.equal(await page.read({ kind: 'url' }), 'http://localhost/a');
  const loc = await page.location();
  assert.equal(loc.url, 'http://localhost/a');
  assert.equal(loc.title, 'A');
  assert.deepEqual(await page.console(), [{ level: 'log', text: 'hi' }]);
  assert.equal(await page.evaluate('1'), 42);
  const dir = mkdtempSync(join(tmpdir(), 'e2k-shot-'));
  try {
    const path = join(dir, '01.jpg');
    await page.screenshot({ path, fullPage: false });
    assert.deepEqual([...readFileSync(path)], [0xff, 0xd8, 0xff, 0xd9]);
    const png = join(dir, '02.png');
    await page.screenshot({ path: png, fullPage: false, format: 'png' });
    assert.deepEqual([...readFileSync(png).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launch options: delay, launched profiles, capabilities, checks and failOpenWith', async () => {
  const boom = new Error('cannot open');
  const d = new FakeDriver({ capabilities: { networkInterception: false }, checks: [{ name: 'x', ok: false, detail: 'd' }], failOpenWith: boom, launchDelayMs: 40 });
  assert.equal(d.capabilities.networkInterception, false);
  assert.equal(typeof d.capabilities.selectorDialect, 'string');
  assert.deepEqual(await d.selfCheck(), [{ name: 'x', ok: false, detail: 'd' }]);
  assert.deepEqual(d.launched, []);
  const t0 = performance.now();
  const inst = await d.launch({ name: 'p', userDataDir: '/tmp/e2k-fake-profile' });
  assert.ok(performance.now() - t0 >= 35);
  assert.deepEqual(d.launched, [{ name: 'p', userDataDir: '/tmp/e2k-fake-profile' }]);
  assert.equal((await inst.health()).ok, true);
  await assert.rejects(inst.openPage({}), (e) => e === boom);
});

// 约定：onClosed 对任何关闭都触发，包括调用方自己 close() / stop()；每次关闭只触发一次。
test('page.close() fires the page onClosed exactly once', async () => {
  const { d, inst, page } = await setup({});
  const second = await inst.openPage({});
  let closed = 0, secondClosed = 0;
  page.onClosed(() => { closed++; assert.deepEqual(d.openPages(), [second.id]); });
  second.onClosed(() => secondClosed++);
  await page.close();
  assert.deepEqual([closed, secondClosed], [1, 0]);
  assert.deepEqual(d.openPages(), [second.id]);
  await assert.rejects(page.close(), (e: DriverError) => e.kind === 'other');
  d.closePage(page.id);
  d.closeBrowser();
  assert.deepEqual([closed, secondClosed], [1, 1]);
});

test('instance.stop() sets the closed state, then fires page and instance onClosed exactly once', async () => {
  const { d, inst, page } = await setup({});
  const second = await inst.openPage({});
  await second.close();
  const order: string[] = [];
  page.onClosed(() => { order.push('page'); assert.deepEqual(d.openPages(), []); });
  second.onClosed(() => order.push('second'));
  inst.onClosed(() => order.push('instance'));
  page.onClosed(() => { void inst.health().then((c) => order.push(`health:${c.ok}`)); });
  await inst.stop();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['page', 'instance', 'health:false']);
  await inst.stop();
  d.closeBrowser();
  assert.deepEqual(order, ['page', 'instance', 'health:false']);
  assert.equal((await inst.health()).ok, false);
  await assert.rejects(page.snapshot({}), (e: DriverError) => e.kind === 'other');
});

// 多实例：每个 launch 是独立的浏览器；页面、请求、弹窗都归它自己的实例，关一个不影响另一个。
test('two instances run side by side: requests, popups and request-done stay with the owning instance; closeInstance closes only one', async () => {
  const d = new FakeDriver({ pages: { 'http://localhost/a': {} } });
  const a = await d.launch({ name: 'admin', userDataDir: '/tmp/e2k-fake/admin' });
  const b = await d.launch({ name: 'admin@t1', userDataDir: '/tmp/e2k-fake/admin@t1' });
  assert.deepEqual(d.launched, [{ name: 'admin', userDataDir: '/tmp/e2k-fake/admin' }, { name: 'admin@t1', userDataDir: '/tmp/e2k-fake/admin@t1' }]);
  assert.equal(d.launches, 2);
  const seen: string[] = [];
  const done: string[] = [];
  const popups: string[] = [];
  for (const [tag, inst] of [['a', a], ['b', b]] as const) {
    inst.setRequestHandler((r) => { seen.push(`${tag}:${r.id}`); return { action: 'continue' }; });
    inst.onRequestDone((e) => { done.push(`${tag}:${e.id}`); });
    inst.onPageOpened((p) => { popups.push(`${tag}:${p.id}`); });
  }
  const pa = await a.openPage({});
  const pb = await b.openPage({});
  assert.notEqual(pa.id, pb.id);
  await d.emitRequest({ pageId: pa.id, method: 'GET', url: 'http://localhost/a' });
  await d.emitRequest({ pageId: pb.id, method: 'GET', url: 'http://localhost/a' });
  await d.emitRequest({ pageId: null, method: 'GET', url: 'http://localhost/a' }, 0);
  assert.deepEqual(seen, ['a:r1', 'b:r2', 'a:r3']);
  d.emitRequestDone('r2', 200);
  d.emitRequestDone('r1', 200);
  assert.deepEqual(done, ['b:r2', 'a:r1']);
  const popA = d.emitPopup(pa.id, 'http://localhost/a');
  const popB = d.emitPopup(pb.id, 'http://localhost/a');
  assert.deepEqual(popups, [`a:${popA.id}`, `b:${popB.id}`]);
  assert.equal(new Set([pa.id, pb.id, popA.id, popB.id]).size, 4);
  let aClosed = 0, bClosed = 0, paClosed = 0, pbClosed = 0;
  a.onClosed(() => aClosed++); b.onClosed(() => bClosed++); pa.onClosed(() => paClosed++); pb.onClosed(() => pbClosed++);
  d.closeInstance(0);
  assert.deepEqual([aClosed, bClosed, paClosed, pbClosed], [1, 0, 1, 0]);
  assert.equal((await a.health()).ok, false); assert.equal((await b.health()).ok, true);
  assert.deepEqual(d.openPages(), [pb.id, popB.id]);
  await assert.rejects(d.emitRequest({ pageId: null, method: 'GET', url: 'http://localhost/a' }, 0), /no running instance/);
  assert.deepEqual(await d.emitRequest({ pageId: pb.id, method: 'GET', url: 'http://localhost/a' }), { action: 'continue' });
  d.closeBrowser();                                    // 最近启动的是第二个
  assert.equal((await b.health()).ok, false);
});

test('emitHop reaches only the listeners of the instance that owns the page; clearCookies is recorded per instance and refuses on a closed one', async () => {
  const d = new FakeDriver();
  const a = await d.launch({ name: 'a', userDataDir: '/tmp/e2k-fake-a' });
  const b = await d.launch({ name: 'b', userDataDir: '/tmp/e2k-fake-b' });
  const pageA = await a.openPage({});
  const seenA: { pageId: string; url: string }[] = [];
  const seenB: { pageId: string; url: string }[] = [];
  a.onNavigationHop((e) => { seenA.push(e); });
  b.onNavigationHop((e) => { seenB.push(e); });
  d.emitHop(pageA.id, 'http://localhost/landed');
  assert.deepEqual(seenA, [{ pageId: pageA.id, url: 'http://localhost/landed' }]);
  assert.deepEqual(seenB, []);
  await a.clearCookies('localhost');
  assert.deepEqual([d.clearedHosts(0), d.clearedHosts(1)], [['localhost'], []]);
  d.closeInstance(1);
  await assert.rejects(b.clearCookies('localhost'), DriverError);
});
