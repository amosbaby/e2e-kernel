import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DriverError } from '../../src/driver/types.ts';
import type { Decision, Instance, Page, RequestInfo } from '../../src/driver/types.ts';
import { createPlaywrightDriver } from '../../src/drivers/playwright/driver.ts';
import { startFixtureServer } from '../support/fixture-server.ts';
import type { FixtureServer } from '../support/fixture-server.ts';

// 整份文件共用一个 fixture 服务和一个浏览器实例；每条测试自己开一页。
// 动作等目标的上限压到 1.5 秒：「永远不出现」的目标也只等这么久，测试才快。
const ACTION_WAIT_MS = 1500;
const driver = createPlaywrightDriver({ actionTimeoutMs: ACTION_WAIT_MS });
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

// 快照里 button "<label>" 那一行的引用。
async function refOf(p: Page, label: string): Promise<string> {
  const snap = await p.snapshot({});
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`button "${escaped}" \\[ref=([^\\]]+)\\]`).exec(snap);
  assert.ok(m, `no button "${label}" in the snapshot:\n${snap}`);
  return m[1]!;
}

// 快照里匹配某个正则的第一处引用（正则第 1 组是引用）。
async function refMatching(p: Page, re: RegExp): Promise<string> {
  const snap = await p.snapshot({});
  const m = re.exec(snap);
  assert.ok(m, `no match for ${re} in the snapshot:\n${snap}`);
  return m[1]!;
}

// 轮询页面里的一个表达式，直到为真（最多 5 秒）。
async function untilEval(p: Page, expr: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await p.evaluate(expr))) {
    if (Date.now() > deadline) assert.fail(`page condition not met within 5 seconds: ${expr}`);
    await sleep(50);
  }
}

// JPEG 的宽高：读第一个 SOF 标记（0xFFC0..0xFFCF 里除了 C4、C8、CC）。
function jpegSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  let i = 2;
  while (i + 9 < b.length) {
    assert.equal(b[i], 0xff, 'not at a JPEG marker');
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return assert.fail('no SOF marker in the JPEG');
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

test('requests that arrive before a handler is set are aborted, then pass once it is', { timeout: 60_000 }, async () => {
  const fresh = await driver.launch({ name: 'fresh', userDataDir: makeTmp('e2k-pw-') });
  try {
    const freshSeen: RequestInfo[] = [];
    const before = server.hits.length;
    const other = await fresh.openPage({});
    // 写请求也一样：no-cors 的 POST 到得了写端点才会进 hits，没装 handler 时它必须被中止。
    await other.evaluate(`fetch('${server.origin}/api/items?pre=1', { method: 'POST', body: '{}', mode: 'no-cors' }).then(() => 'sent', () => 'blocked')`);
    await assert.rejects(other.goto(server.origin + '/index.html'), DriverError);
    // 等被中止的导航留下的错误页落定，免得它打断下一次 goto；轮询有上限。
    const deadline = Date.now() + 5000;
    while (!(await other.location()).url.startsWith('chrome-error:')) {
      if (Date.now() > deadline) assert.fail('the aborted navigation never settled on the error page');
      await sleep(50);
    }
    assert.equal(server.hits.length, before);
    fresh.setRequestHandler(r => { freshSeen.push(r); return { action: 'continue' }; });
    await other.goto(server.origin + '/index.html');
    assert.ok(freshSeen.some(r => r.url.endsWith('/index.html')));
  } finally {
    await fresh.stop();
  }
});

// 只记录现状：Playwright 的路由 handler 只对重定向链的第一个 URL 调用，后续跳不经 handler（见 docs/m0-findings.md）。
test('a redirect target is not shown to the handler (known gap, recorded not fixed)', { timeout: 60_000 }, async () => {
  const before = server.hits.length;
  await page.evaluate(`fetch('/r307', { method: 'POST', body: '{}' })`); await settle();
  assert.ok(seen.some(r => r.method === 'POST' && r.url.endsWith('/r307')));
  assert.ok(!seen.some(r => r.url.endsWith('/api/sink')), 'the redirect target reached the handler');
  assert.ok(server.hits.slice(before).some(h => h.path === '/api/sink'), 'the redirect target reached the server');
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

test('a fire-and-forget POST with an unread body is reported with its status, also after the page navigates away', { timeout: 60_000 }, async () => {
  const done: { id: string; status: number | null; failed: boolean }[] = [];
  inst.onRequestDone(e => { done.push(e); });
  await page.click('[data-testid="add"]'); await settle();   // 首页的 fetch 不读响应体
  const post = seen.find(r => r.method === 'POST' && r.url.endsWith('/api/items'))!;
  assert.deepEqual(done.filter(e => e.id === post.id), [{ id: post.id, status: 200, failed: false }]);
  await page.goto(server.origin + '/index.html'); await settle();
  assert.deepEqual(done.filter(e => e.id === post.id), [{ id: post.id, status: 200, failed: false }]);
});

test('every request is reported exactly once', { timeout: 60_000 }, async () => {
  const done: { id: string; status: number | null; failed: boolean }[] = [];
  inst.onRequestDone(e => { done.push(e); });
  const first = seen.length;   // 监听器是现在才挂上的，之前已经完成的请求不算
  await page.evaluate(`fetch('/api/items?read=1', { method: 'POST', body: '{}' }).then(r => r.text())`);
  await page.evaluate(`fetch('/api/items?unread=1', { method: 'POST', body: '{}' })`);
  await settle();
  await page.goto(server.origin + '/login.html'); await settle();
  const mine = seen.slice(first);
  assert.ok(mine.length >= 3);
  for (const r of mine) assert.equal(done.filter(e => e.id === r.id).length, 1, `${r.method} ${r.url} reported ${done.filter(e => e.id === r.id).length} times`);
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

test('topUrl is the document being navigated to, else the page http url, else null', { timeout: 60_000 }, async () => {
  const fresh = await inst.openPage({});
  try {
    seen = [];
    const target = server.origin + '/index.html';
    await fresh.goto(target);
    const nav = seen.find(r => r.isNavigation && r.url === target)!;
    assert.ok(nav.topFrame);
    assert.equal(nav.topUrl, target);
    await fresh.evaluate(`fetch('/api/items?top=1', { method: 'POST', body: '{}' })`); await settle();
    const post = seen.find(r => r.url.includes('top=1'))!;
    assert.equal(post.topUrl, target);
    // 页面在 about:blank 上发的请求：顶层地址不是 http，所以是 null。
    const blank = await inst.openPage({});
    try {
      seen = [];
      await blank.evaluate(`fetch('${server.origin}/api/items?blank=1', { method: 'POST', body: '{}', mode: 'no-cors' })`); await settle();
      const fromBlank = seen.find(r => r.url.includes('blank=1'))!;
      assert.ok(fromBlank, 'the request from about:blank was not seen');
      assert.equal(fromBlank.topUrl, null);
    } finally {
      await blank.close().catch(() => {});
    }
  } finally {
    await fresh.close().catch(() => {});
  }
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

test('snapshot has refs; click by ref changes the page', { timeout: 60_000 }, async () => {
  await page.fill('role=textbox[name="New item"]', 'Gamma');
  await page.click(await refOf(page, 'Add'));
  await page.waitFor({ text: 'Added' }, 5000);
  assert.equal(await page.read({ kind: 'count', target: '#list li' }), 3);
});

test('describe resolves refs to stable selectors', { timeout: 60_000 }, async () => {
  assert.deepEqual((await page.describe(await refOf(page, 'Add'))).stable, { selector: '[data-testid="add"]', via: 'testid' });
  assert.deepEqual((await page.describe(await refOf(page, 'Save'))).stable, { selector: '#save', via: 'id' });
  assert.deepEqual((await page.describe(await refOf(page, 'Plain'))).stable, { selector: 'role=button[name="Plain"]', via: 'role' });
  assert.deepEqual(await page.describe('#save'), { stable: { selector: '#save', via: 'given' }, isPassword: false, kind: 'other' });
  await page.goto(server.origin + '/login.html');
  assert.equal((await page.describe('#pw')).isPassword, true);
});

test('describe falls back to a css path, and skips candidates that are ambiguous or unsafe', { timeout: 60_000 }, async () => {
  // 没有 testid、id、可用的角色：从最近带 id 的祖先连下来（这里是 #list）。
  const item = await refMatching(page, /listitem \[ref=(e\d+)\]: Beta/);
  assert.deepEqual((await page.describe(item)).stable, { selector: '#list > li:nth-of-type(2)', via: 'css' });
  // 同一个 testid 出现两次：匹配数不是 1，跳过，落到角色。
  const add = await refOf(page, 'Add');
  await page.evaluate(`(() => { const d = document.createElement('div'); d.setAttribute('data-testid', 'add'); document.body.append(d); })()`);
  assert.deepEqual((await page.describe(add)).stable, { selector: 'role=button[name="Add"]', via: 'role' });
  // 两个同名按钮：角色也不唯一，落到 css（从 body 起）。
  const plain = await refOf(page, 'Plain');
  await page.evaluate(`(() => { const b = document.createElement('button'); b.textContent = 'Plain'; document.body.append(b); })()`);
  assert.deepEqual((await page.describe(plain)).stable, { selector: 'body > button:nth-of-type(3)', via: 'css' });
  // 值里有换行的 testid 和 id：不写进选择器，落到下一个候选。
  const save = await refOf(page, 'Save');
  await page.evaluate(`(() => {
    document.getElementById('save').setAttribute('data-testid', 'a\\nb');
    document.getElementById('save').id = 'sa\\nve';
  })()`);
  assert.deepEqual((await page.describe(save)).stable, { selector: 'role=button[name="Save"]', via: 'role' });
});

test('describe: missing elements, iframe refs and the password flag', { timeout: 60_000 }, async () => {
  await assert.rejects(page.describe('#nope'), (e: DriverError) => e instanceof DriverError && e.kind === 'not-found');
  await assert.rejects(page.describe('e999'), (e: DriverError) => e instanceof DriverError && e.kind === 'not-found');
  await page.goto(server.origin + '/frames.html');
  const framed = await refMatching(page, /\[ref=(f\d+e\d+)\]/);
  assert.deepEqual(await page.describe(framed), { stable: null, isPassword: false, kind: 'other' });
  await page.goto(server.origin + '/login.html');
  assert.equal((await page.describe('input[name="user"]')).isPassword, false);
});

test('describe: password-like detection and element kind, failing closed', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/login.html');
  await page.evaluate(`(() => {
    const add = (html) => document.body.insertAdjacentHTML('beforeend', html);
    add('<input id="t-plain" type="text">');
    add('<input id="t-current" type="text" autocomplete="current-password">');
    add('<input id="t-new" type="text" autocomplete="NEW-PASSWORD">');
    add('<input id="t-otp" type="text" autocomplete="username one-time-code">');
    add('<input id="t-user" type="text" autocomplete="username">');
    add('<input id="t-num" type="number">');
    add('<input id="t-check" type="checkbox">');
    add('<textarea id="t-area"></textarea>');
    add('<div id="t-edit" contenteditable="true"></div>');
    add('<div id="t-role" role="textbox" tabindex="0"></div>');
  })()`);
  const info = async (sel: string) => { const d = await page.describe(sel); return [d.isPassword, d.kind]; };
  assert.deepEqual(await info('#pw'), [true, 'other']);
  assert.deepEqual(await info('#t-plain'), [false, 'text-input']);
  assert.deepEqual(await info('#t-current'), [true, 'text-input']);
  assert.deepEqual(await info('#t-new'), [true, 'text-input']);
  assert.deepEqual(await info('#t-otp'), [true, 'text-input']);
  assert.deepEqual(await info('#t-user'), [false, 'text-input']);
  assert.deepEqual(await info('#t-num'), [false, 'text-input']);
  assert.deepEqual(await info('#t-check'), [false, 'other']);
  assert.deepEqual(await info('#t-area'), [false, 'textarea']);
  assert.deepEqual(await info('#t-edit'), [false, 'other']);
  assert.deepEqual(await info('#t-role'), [false, 'other']);
});

// fill 落到 label（或 label 里的文字）上时，Playwright 改填这个 label 的 control；describe 判断的必须是那个元素。
test('describe: a label, or text inside it, is judged by the field it controls', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/login.html');
  await page.evaluate(`(() => {
    const add = (html) => document.body.insertAdjacentHTML('beforeend', html);
    add('<label id="t-wrap"><span id="t-wrap-text">Code</span> <input type="text" autocomplete="one-time-code"></label>');
    add('<label for="t-name" id="t-name-label"><b id="t-name-text">Name</b></label><input id="t-name" type="text">');
    add('<label id="t-bare"><span id="t-bare-text">Nothing</span></label>');
  })()`);
  const info = async (sel: string) => { const d = await page.describe(sel); return [d.isPassword, d.kind]; };
  assert.deepEqual(await info('#lab'), [true, 'other']);
  assert.deepEqual(await info('#sp'), [true, 'other']);
  assert.deepEqual(await info('text=Password'), [true, 'other']);
  assert.deepEqual(await info('#t-wrap'), [true, 'text-input']);
  assert.deepEqual(await info('#t-wrap-text'), [true, 'text-input']);
  assert.deepEqual(await info('#t-name-label'), [false, 'text-input']);
  assert.deepEqual(await info('#t-name-text'), [false, 'text-input']);
  assert.deepEqual(await info('#t-bare-text'), [false, 'other']);
  // describe 里看到的 stable 仍是调用方给的目标本身
  assert.deepEqual((await page.describe('#sp')).stable, { selector: '#sp', via: 'given' });
});

test('snapshot honours depth', { timeout: 60_000 }, async () => {
  const full = await page.snapshot({});
  assert.match(full, /heading "Items"/);
  assert.match(full, /listitem \[ref=e\d+\]: Alpha/);
  const shallow = await page.snapshot({ depth: 1 });
  assert.match(shallow, /heading "Items"/);
  assert.ok(!shallow.includes('Alpha'), shallow);
});

test('read: css, text, url, visible, missing', { timeout: 60_000 }, async () => {
  assert.equal(await page.read({ kind: 'css', target: '#styled', property: 'color' }), 'rgb(0, 128, 0)');
  assert.equal(await page.read({ kind: 'css', target: '#styled', property: 'font-size' }), '18px');
  assert.equal(await page.read({ kind: 'text', target: 'h1' }), 'Items');
  assert.equal(await page.read({ kind: 'url' }), server.origin + '/index.html');
  assert.equal(await page.read({ kind: 'visible', target: '#styled' }), true);
  assert.equal(await page.read({ kind: 'visible', target: '#nope' }), false);
  await assert.rejects(page.read({ kind: 'text', target: '#nope' }), (e: DriverError) => e.kind === 'not-found');
  assert.match(await page.text({}), /Items[\s\S]*Alpha[\s\S]*Beta/);
});

test('read: count, css and visible edge cases', { timeout: 60_000 }, async () => {
  assert.equal(await page.read({ kind: 'count', target: '#list li' }), 2);
  assert.equal(await page.read({ kind: 'count', target: '#nope' }), 0);
  assert.equal(await page.read({ kind: 'count', target: 'role=button[name="Plain"]' }), 1);
  assert.equal(await page.read({ kind: 'count', target: 'role=button[name="Nobody"]' }), 0);
  await assert.rejects(page.read({ kind: 'css', target: '#nope', property: 'color' }), (e: DriverError) => e.kind === 'not-found');
  await assert.rejects(page.read({ kind: 'css', target: '#styled' }), (e: DriverError) => e instanceof DriverError && e.kind === 'other');
  await assert.rejects(page.read({ kind: 'count' }), (e: DriverError) => e instanceof DriverError && e.kind === 'other');
  // 几个元素都匹配时 visible 看第一个，不抛严格模式的错。
  assert.equal(await page.read({ kind: 'visible', target: '#list li' }), true);
  await page.evaluate(`document.getElementById('styled').style.display = 'none'`);
  assert.equal(await page.read({ kind: 'visible', target: '#styled' }), false);
  assert.equal(await page.read({ kind: 'count', target: '#styled' }), 1);
});

test('text with a target reads that element; missing target is not-found', { timeout: 60_000 }, async () => {
  assert.equal(await page.text({ target: '#styled' }), 'Styled');
  assert.match(await page.text({ target: '#list' }), /Alpha\s+Beta/);
  await assert.rejects(page.text({ target: '#nope' }), (e: DriverError) => e.kind === 'not-found');
});

test('console returns what the page logged', { timeout: 60_000 }, async () => {
  await page.evaluate(`console.log('hello-console'); console.error('oops-console')`);
  const msgs = await page.console();
  assert.ok(msgs.some(m => m.level === 'log' && m.text === 'hello-console'), JSON.stringify(msgs));
  assert.ok(msgs.some(m => m.level === 'error' && m.text === 'oops-console'), JSON.stringify(msgs));
});

test('navigation failures and timeouts map to DriverError', { timeout: 60_000 }, async () => {
  await assert.rejects(page.goto('http://127.0.0.1:9/'), DriverError);             // 没人监听的端口
  await assert.rejects(page.waitFor({ text: 'never appears' }, 300), (e: DriverError) => e.kind === 'timeout');
});

test('action errors: a missing target is not-found, messages are one line', { timeout: 60_000 }, async () => {
  for (const act of [() => page.click('#nope'), () => page.hover('#nope'), () => page.fill('#nope', 'x'),
    () => page.press('Enter', '#nope'), () => page.scroll({ target: '#nope' }), () => page.click('e999'),
    () => page.click('role=button[name="Nobody"]')])
    await assert.rejects(act(), (e: DriverError) => e instanceof DriverError && e.kind === 'not-found' && !e.message.includes('\n'));
  // 两个元素匹配同一个选择器：不乱点第一个，当作别的错。
  await assert.rejects(page.click('#list li'), (e: DriverError) => e instanceof DriverError && e.kind === 'other' && !e.message.includes('\n'));
  await assert.rejects(page.press('NoSuchKey'), (e: DriverError) => e instanceof DriverError && e.kind === 'other' && !e.message.includes('\n'));
  await assert.rejects(page.evaluate('throw new Error("page threw")'), (e: DriverError) => e instanceof DriverError && e.kind === 'other' && !e.message.includes('\n'));
  await assert.rejects(page.goto('http://127.0.0.1:9/'), (e: DriverError) => e instanceof DriverError && e.kind === 'other' && !e.message.includes('\n'));
});

test('actions wait for a late target to attach; one that never appears is not-found after the action timeout', { timeout: 60_000 }, async () => {
  await page.evaluate(`setTimeout(() => {
    const b = document.createElement('button'); b.id = 'late-btn'; b.textContent = 'Late'; b.onclick = () => { b.dataset.clicked = 'yes'; };
    const i = document.createElement('input'); i.id = 'late-input';
    document.body.append(b, i);
  }, 400)`);
  assert.equal(await page.read({ kind: 'count', target: '#late-btn' }), 0);   // read 不等待
  await page.click('#late-btn');
  assert.equal(await page.read({ kind: 'css', target: '#late-btn', property: 'display' }), 'inline-block');
  assert.equal(await page.evaluate(`document.querySelector('#late-btn').dataset.clicked`), 'yes');
  await page.fill('#late-input', 'typed');
  assert.equal(await page.evaluate(`document.querySelector('#late-input').value`), 'typed');
  // 永远不出现：等满上限才 not-found（不会立刻失败，也不会拖到 Playwright 默认的更长时间）。
  const t0 = Date.now();
  await assert.rejects(page.click('#never'), (e: DriverError) => e instanceof DriverError && e.kind === 'not-found');
  const waited = Date.now() - t0;
  assert.ok(waited >= ACTION_WAIT_MS - 200 && waited < ACTION_WAIT_MS + 3000, `waited ${waited} ms`);
  // read 照旧不等待。
  const t1 = Date.now();
  await assert.rejects(page.read({ kind: 'text', target: '#never' }), (e: DriverError) => e instanceof DriverError && e.kind === 'not-found');
  assert.ok(Date.now() - t1 < ACTION_WAIT_MS / 2);
});

test('screenshot is a JPEG', { timeout: 60_000 }, async () => {
  const file = join(makeTmp('e2k-shot-'), 'shot.jpg');
  await page.screenshot({ path: file, fullPage: false });
  assert.deepEqual([...readFileSync(file).subarray(0, 2)], [0xff, 0xd8]);
});

test('screenshot is in CSS pixels and, without fullPage, no wider than the viewport', { timeout: 60_000 }, async () => {
  const small = await inst.openPage({ viewport: { width: 640, height: 480 } });
  try {
    await small.goto(server.origin + '/index.html');
    await small.evaluate(`document.body.style.minHeight = '3000px'`);
    const file = join(makeTmp('e2k-shot-'), 'view.jpg');
    await small.screenshot({ path: file, fullPage: false });
    const view = jpegSize(file);
    assert.ok(view.width <= 640, `width ${view.width}`);
    assert.ok(view.height <= 480, `height ${view.height}`);
    const full = join(makeTmp('e2k-shot-'), 'full.jpg');
    await small.screenshot({ path: full, fullPage: true });
    const all = jpegSize(full);
    assert.ok(all.width <= 640, `width ${all.width}`);
    assert.ok(all.height > 480, `height ${all.height}`);
  } finally {
    await small.close().catch(() => {});
  }
});

test('press works with a target and without one', { timeout: 60_000 }, async () => {
  const value = (): Promise<unknown> => page.evaluate(`document.getElementById('new-item').value`);
  await page.click('#new-item');
  await page.press('A');                      // 没有目标：发给当前焦点
  assert.equal(await value(), 'A');
  await page.press('Backspace', '#new-item'); // 有目标：先聚焦再按
  assert.equal(await value(), '');
  await page.press('B', 'role=textbox[name="New item"]');
  assert.equal(await value(), 'B');
});

test('hover moves the pointer onto the target', { timeout: 60_000 }, async () => {
  await page.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '#styled:hover { color: rgb(255, 0, 0) !important }'; document.head.append(s); })()`);
  assert.equal(await page.read({ kind: 'css', target: '#styled', property: 'color' }), 'rgb(0, 128, 0)');
  await page.hover('#styled');
  assert.equal(await page.read({ kind: 'css', target: '#styled', property: 'color' }), 'rgb(255, 0, 0)');
});

test('scroll by target and by dx/dy', { timeout: 60_000 }, async () => {
  await page.evaluate(`(() => {
    document.body.style.minHeight = '4000px'; document.body.style.minWidth = '4000px';
    const d = document.createElement('div'); d.id = 'bottom'; d.style.marginTop = '3000px'; d.textContent = 'bottom'; document.body.append(d);
  })()`);
  assert.equal(await page.evaluate('window.scrollY'), 0);
  // 每一步 resolve 之后立刻读：不轮询、不等待，滚动已经落地才算 scroll 完成。
  await page.scroll({ target: '#bottom' });
  assert.ok((await page.evaluate('window.scrollY')) as number > 1000);
  await page.evaluate('window.scrollTo(0, 0)');
  await page.scroll({ dy: 300 });
  assert.equal(await page.evaluate('window.scrollY'), 300);
  await page.scroll({ dx: 200 });
  assert.equal(await page.evaluate('window.scrollX'), 200);
  await page.scroll({ dy: -100 });
  assert.equal(await page.evaluate('window.scrollY'), 200);
});

test('setViewport resizes the page, and openPage applies a requested viewport', { timeout: 60_000 }, async () => {
  await page.setViewport({ width: 640, height: 480 });
  assert.deepEqual(await page.evaluate('[window.innerWidth, window.innerHeight]'), [640, 480]);
  const sized = await inst.openPage({ viewport: { width: 800, height: 600 } });
  try {
    await sized.goto(server.origin + '/index.html');
    assert.deepEqual(await sized.evaluate('[window.innerWidth, window.innerHeight]'), [800, 600]);
  } finally {
    await sized.close().catch(() => {});
  }
});

test('waitFor urlContains and ms', { timeout: 60_000 }, async () => {
  await page.waitFor({ urlContains: 'index.html' }, 1000);          // 已经满足：马上返回
  await page.evaluate(`setTimeout(() => history.pushState({}, '', '/index.html?later=yes'), 200)`);
  await page.waitFor({ urlContains: 'later=yes' }, 5000);
  assert.equal(await page.read({ kind: 'url' }), server.origin + '/index.html?later=yes');
  await assert.rejects(page.waitFor({ urlContains: 'never-in-the-url' }, 300), (e: DriverError) => e instanceof DriverError && e.kind === 'timeout');
  // 子串，不是通配也不是正则：星号和点只代表它们自己。
  await assert.rejects(page.waitFor({ urlContains: 'index*html' }, 300), (e: DriverError) => e.kind === 'timeout');
  await assert.rejects(page.waitFor({ urlContains: 'index.+html' }, 300), (e: DriverError) => e.kind === 'timeout');
  const t0 = Date.now();
  await page.waitFor({ ms: 300 }, 5000);
  assert.ok(Date.now() - t0 >= 280, `waited only ${Date.now() - t0} ms`);
});

test('waitFor target states', { timeout: 60_000 }, async () => {
  await page.waitFor({ target: '#nope', state: 'hidden' }, 1000);       // 不存在也算隐藏
  await assert.rejects(page.waitFor({ target: '#nope', state: 'visible' }, 300), (e: DriverError) => e.kind === 'timeout');
  await page.evaluate(`setTimeout(() => { document.getElementById('styled').style.display = 'none'; }, 200)`);
  await page.waitFor({ target: '#styled', state: 'hidden' }, 5000);
  assert.equal(await page.read({ kind: 'visible', target: '#styled' }), false);
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

test('browser death with session pages open: page listeners already see health().ok === false, then the instance listener fires', { timeout: 60_000 }, async () => {
  const dir = makeTmp('e2k-kill2-');
  const errors: unknown[] = [];
  const victim = await createPlaywrightDriver({ onListenerError: (e) => errors.push(e) }).launch({ name: 'x', userDataDir: dir });
  const order: string[] = [];
  const pageHealth: Promise<{ ok: boolean }>[] = [];
  let pageFired = 0;
  for (const label of ['a', 'b']) {
    const p = await victim.openPage({});
    p.onClosed(() => { pageFired++; order.push('page-' + label); pageHealth.push(victim.health()); });
  }
  let instFired = 0;
  let instHealth: Promise<{ ok: boolean }> | undefined;
  victim.onClosed(() => { instFired++; order.push('instance'); instHealth = victim.health(); });
  try { execFileSync('pkill', ['-9', '-f', dir]); } catch { /* pkill 没匹配到时退出码非零，下面的断言会失败 */ }
  await until(() => instFired === 1);
  await settle();
  assert.equal(pageFired, 2);
  assert.equal(instFired, 1);
  assert.deepEqual(order, ['page-a', 'page-b', 'instance']);
  assert.deepEqual((await Promise.all(pageHealth)).map((h) => h.ok), [false, false]);
  assert.equal((await instHealth)?.ok, false);
  assert.equal((await victim.health()).ok, false);
  assert.deepEqual(errors, []);
});

test('a tab closed from outside the driver API fires Page.onClosed once while the browser stays healthy', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/popup.html');
  await page.click('#open-popup');
  await until(() => opened.length === 1);
  const [popup] = opened[0]!;
  let closed = 0;
  const healthAtFire: Promise<{ ok: boolean }>[] = [];
  popup.onClosed(() => { closed++; healthAtFire.push(inst.health()); });
  let instClosed = 0; inst.onClosed(() => instClosed++);
  await popup.click('#close-self');
  await until(() => closed === 1);
  await settle();
  assert.equal(closed, 1);
  assert.equal(instClosed, 0);
  assert.deepEqual((await Promise.all(healthAtFire)).map((h) => h.ok), [true]);
  assert.equal((await inst.health()).ok, true);
  await assert.rejects(popup.location(), (e: DriverError) => e instanceof DriverError && e.kind === 'other');
});

test('a throwing listener does not stop the others, and its error reaches onListenerError', { timeout: 60_000 }, async () => {
  const errors: unknown[] = [];
  const own = await createPlaywrightDriver({ onListenerError: (e) => errors.push(e) }).launch({ name: 'thrower', userDataDir: makeTmp('e2k-throw-') });
  const p = await own.openPage({});
  const fired: string[] = [];
  p.onClosed(() => { fired.push('page-1'); throw new Error('page listener bug'); });
  p.onClosed(() => { fired.push('page-2'); });
  own.onClosed(() => { fired.push('instance-1'); throw new Error('instance listener bug'); });
  own.onClosed(() => { fired.push('instance-2'); });
  await own.stop(); await settle();
  assert.deepEqual(fired, ['page-1', 'page-2', 'instance-1', 'instance-2']);
  assert.deepEqual(errors.map((e) => (e as Error).message), ['page listener bug', 'instance listener bug']);
});

test('without a hook, a listener error is rethrown asynchronously (uncaughtException) and the other listeners still run', { timeout: 60_000 }, async () => {
  const own = await createPlaywrightDriver().launch({ name: 'rethrow', userDataDir: makeTmp('e2k-rethrow-') });
  const fired: string[] = [];
  own.onClosed(() => { fired.push('first'); throw new Error('kernel handler bug'); });
  own.onClosed(() => { fired.push('second'); });
  // node:test 自己会接 uncaughtException 并判当前测试失败；这里临时换成我们的捕获，结束后还原。
  const saved = process.listeners('uncaughtException');
  const caught: unknown[] = [];
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (e) => { caught.push(e); });
  try {
    await own.stop(); await settle();
  } finally {
    process.removeAllListeners('uncaughtException');
    for (const l of saved) process.on('uncaughtException', l);
  }
  assert.deepEqual(fired, ['first', 'second']);
  assert.equal(caught.length, 1);
  assert.equal((caught[0] as Error).message, 'kernel handler bug');
});
