import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { redactText } from '../../src/shared/redact.ts';
import { DriverError } from '../../src/driver/types.ts';
import type { Decision, Instance, Page, RequestInfo } from '../../src/driver/types.ts';
import { createPlaywrightDriver, describeCandidates, dropTruncatedRuns, guardedHints, interceptHint } from '../../src/drivers/playwright/driver.ts';
import { runOps } from '../../src/kernel/executor.ts';
import { Recorder } from '../../src/kernel/recorder.ts';
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
let hops: { pageId: string; url: string }[] = [];
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
  inst.onNavigationHop((e) => { hops.push(e); });
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
  hops = [];
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
    sharedWorkers: 'covered',
    canHeadless: true,
    selectorDialect: 'playwright',
  });
  assert.equal(driver.name, 'playwright');
});

// SharedWorker 发出的请求不经 context.route（docs/m0-findings.md §9.9），所以驱动在所有页面里把它删掉。
test('SharedWorker is gone from the page, so it cannot make a write that bypasses routing', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/shared-worker.html');
  assert.equal(await page.evaluate(`document.documentElement.dataset.shared`), 'threw');
  assert.equal(await page.evaluate(`typeof SharedWorker`), 'undefined');
  await sleep(1000);
  assert.ok(!server.hits.some(h => h.path === '/api/sink' && h.query.case === 'shared-worker'), 'no write from a SharedWorker reached the server');
});

test('SharedWorker is gone from a same-origin iframe with a src', { timeout: 60_000 }, async () => {
  const typeOf = await page.evaluate(`new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.onload = () => resolve(typeof f.contentWindow.SharedWorker);
    f.src = '/frame-child.html';
    document.body.appendChild(f);
  })`);
  assert.equal(typeOf, 'undefined');
});

test('SharedWorker is gone from a blank iframe the script creates synchronously', { timeout: 60_000 }, async () => {
  assert.equal(await page.evaluate(`(() => {
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    return typeof f.contentWindow.SharedWorker;
  })()`), 'undefined');
});

test('SharedWorker is gone from a window opened with window.open(\'\')', { timeout: 60_000 }, async () => {
  assert.equal(await page.evaluate(`(() => {
    const w = window.open('');
    const t = typeof w.SharedWorker;
    w.close();
    return t;
  })()`), 'undefined');
});

test('a Dedicated Worker has no SharedWorker either', { timeout: 60_000 }, async () => {
  assert.equal(await page.evaluate(`new Promise((resolve, reject) => {
    const w = new Worker(URL.createObjectURL(new Blob(['postMessage(typeof SharedWorker)'], { type: 'text/javascript' })));
    w.onmessage = (e) => resolve(e.data);
    w.onerror = () => reject(new Error('worker failed'));
  })`), 'undefined');
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

// 信号归内核和 CLI：Playwright 默认会在 launch 时挂自己的 SIGINT/SIGTERM/SIGHUP 处理器，第二次 SIGINT 会直接 exit(130)，
// 抢在内核自己的收尾前面。不发真信号：在一个干净的子进程里 launch，看进程上有没有多出监听器
// （处理器每个进程只装一次，本文件里别的测试已经 launch 过，所以不能在本进程里数）。
test('launch does not add Playwright signal handlers to the process', { timeout: 60_000 }, () => {
  const script = `import { createPlaywrightDriver } from './src/drivers/playwright/driver.ts';
const count = () => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
const before = count();
const inst = await createPlaywrightDriver().launch({ name: 'signals', userDataDir: ${JSON.stringify(makeTmp('e2k-pw-'))} });
const after = count();
await inst.stop();
console.log(JSON.stringify({ before, after }));
process.exit(0);
`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 45_000 });
  const { before, after } = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { before: number[]; after: number[] };
  assert.deepEqual(after, before);
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

test('fromLoginForm: true on a page with a password field, false without one, null without a body', { timeout: 60_000 }, async () => {
  const post = (path: string): RequestInfo => seen.find(r => r.method === 'POST' && r.url.endsWith(path))!;
  // index.html 没有密码框
  await page.fill('#new-item', 'Delta'); await page.click('[data-testid="add"]'); await settle();
  assert.equal(post('/api/items').fromLoginForm, false);
  assert.equal(seen.find(r => r.method === 'GET' && r.url.endsWith('/index.html'))?.fromLoginForm, null);
  // profile.html 没有密码框
  await page.goto(server.origin + '/profile.html');
  await page.click('#send-ids'); await settle();
  assert.equal(post('/api/ids').fromLoginForm, false);
  assert.match(post('/api/ids').body!, /^ids=/);
  // sso.html 有：fetch 是 true；原生表单提交（导航请求）在路由回调里探测不了，是 null（内核照样不记体）
  seen = [];
  await page.goto(server.origin + '/sso.html');
  await page.click('#send-ids'); await settle();
  assert.equal(post('/api/ids').fromLoginForm, true);
  await page.evaluate(`document.querySelector('#pw').value = 'x'; document.querySelector('#sso').requestSubmit()`); await settle();
  const sso = post('/api/sso');
  assert.equal(sso.fromLoginForm, null); assert.equal(sso.isNavigation, true);
  assert.match(sso.body!, /state=/);
});

test('fromLoginForm also looks at the top document when the request comes from a child frame', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/sso.html');
  seen = [];
  // 子 frame（profile.html，自己没有密码框）里发写请求，顶层文档（sso.html）有密码框
  await page.evaluate(`new Promise(res => { const f = document.createElement('iframe'); f.id = 'kid'; f.src = '/profile.html'; f.onload = () => res(1); document.body.append(f); })`);
  await page.evaluate(`document.querySelector('#kid').contentWindow.fetch('/api/ids', { method: 'POST', body: 'a=1' }).then(() => 1, () => 0)`); await settle();
  const r = seen.find(x => x.method === 'POST' && x.url.endsWith('/api/ids'))!;
  assert.equal(r.topFrame, false); assert.equal(r.fromLoginForm, true);
});

test('fromLoginForm sees a password field inside an open shadow root, and a page cannot hide it by patching querySelector', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/profile.html');
  seen = [];
  await page.evaluate(`(() => { const host = document.createElement('div'); document.body.append(host); const root = host.attachShadow({ mode: 'open' });
    const i = document.createElement('input'); i.type = 'password'; root.append(i); })()`);
  await page.click('#send-ids'); await settle();
  assert.equal(seen.find(r => r.method === 'POST' && r.url.endsWith('/api/ids'))?.fromLoginForm, true);
  seen = [];
  await page.goto(server.origin + '/sso.html');
  await page.evaluate(`document.querySelector = () => null; Document.prototype.querySelector = () => null; Element.prototype.querySelector = () => null`);
  await page.click('#send-ids'); await settle();
  assert.equal(seen.find(r => r.method === 'POST' && r.url.endsWith('/api/ids'))?.fromLoginForm, true);
});

test('hasVisiblePasswordField: true only for a visible, current-password-like field on the top page', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/login.html');
  assert.equal(await page.hasVisiblePasswordField(), true);
  await page.goto(server.origin + '/index.html');
  assert.equal(await page.hasVisiblePasswordField(), false);
  const add = async (html: string): Promise<boolean> => {
    await page.goto(server.origin + '/index.html');
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)}); 1`);
    return page.hasVisiblePasswordField();
  };
  assert.equal(await add('<input type="password" style="display:none">'), false, 'a display:none field is not a wall');
  assert.equal(await add('<div hidden><input type="PASSWORD"></div>'), false, 'a field inside a hidden container is not a wall');
  assert.equal(await add('<input type="password">'), true);
  assert.equal(await add('<input type="PassWord">'), true, 'type is matched case-insensitively');
  assert.equal(await add('<input type="text" autocomplete="current-password">'), true);
  assert.equal(await add('<input type="text" autocomplete="section-x one-time-code">'), true, 'autocomplete is matched per token');
  assert.equal(await add('<input type="text" autocomplete="new-password">'), false, 'a sign-up field is not a wall');
  assert.equal(await add('<input type="text" autocomplete="not-current-password-ish">'), false);
});

test('hasVisiblePasswordField sees an open shadow root, but not an iframe', { timeout: 60_000 }, async () => {
  await page.evaluate(`(() => { const host = document.createElement('div'); document.body.append(host); const root = host.attachShadow({ mode: 'open' });
    const i = document.createElement('input'); i.type = 'password'; root.append(i); })()`);
  assert.equal(await page.hasVisiblePasswordField(), true);
  await page.goto(server.origin + '/index.html');
  await page.evaluate(`new Promise(res => { const f = document.createElement('iframe'); f.src = '/login.html'; f.onload = () => res(1); document.body.append(f); })`);
  assert.equal(await page.hasVisiblePasswordField(), false, 'a field only inside an iframe does not count');
});

test('hasVisiblePasswordField cannot be fooled by a page that patches querySelector', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/login.html');
  await page.evaluate(`document.querySelector = () => null; Document.prototype.querySelector = () => null; Document.prototype.querySelectorAll = () => []; 1`);
  assert.equal(await page.hasVisiblePasswordField(), true);
});

test('hasVisiblePasswordField on a closed page is a DriverError', { timeout: 60_000 }, async () => {
  const gone = await inst.openPage({});
  await gone.close();
  await assert.rejects(gone.hasVisiblePasswordField(), (e: DriverError) => e instanceof DriverError);
});

test('hasPasswordLikeField: true for a hidden field, an open shadow root, a same-origin iframe; false only when none; the page cannot fool it', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/index.html');
  assert.equal((await page.hasPasswordLikeField()).found, false);
  const add = async (html: string): Promise<boolean | null> => {
    await page.goto(server.origin + '/index.html');
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)}); 1`);
    return (await page.hasPasswordLikeField()).found;
  };
  assert.equal(await add('<input type="password" style="display:none">'), true, 'visibility does not matter here');
  assert.equal(await add('<input type="text" autocomplete="new-password">'), true, 'new-password counts too');
  assert.equal(await add('<input type="text" autocomplete="one-time-code">'), true);
  assert.equal(await add('<input type="text">'), false);
  await page.goto(server.origin + '/index.html');
  await page.evaluate(`(() => { const host = document.createElement('div'); document.body.append(host); const root = host.attachShadow({ mode: 'open' });
    const i = document.createElement('input'); i.type = 'password'; root.append(i); })()`);
  assert.equal((await page.hasPasswordLikeField()).found, true, 'open shadow root');
  await page.goto(server.origin + '/index.html');
  await page.evaluate(`new Promise(res => { const f = document.createElement('iframe'); f.src = '/login.html'; f.onload = () => res(1); document.body.append(f); })`);
  assert.equal((await page.hasPasswordLikeField()).found, true, 'a field inside an iframe counts (eval can read a same-origin iframe)');
  await page.goto(server.origin + '/login.html');
  await page.evaluate(`document.querySelector = () => null; Document.prototype.querySelector = () => null; Document.prototype.querySelectorAll = () => []; 1`);
  assert.equal((await page.hasPasswordLikeField()).found, true, 'patched querySelector');
});

test('hasPasswordLikeField is null when the probe cannot finish in time, and a DriverError on a closed page', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/index.html');
  // 同步循环占住页面线程：locator 的计数卡住，300 ms 一到给 null
  const busy = page.evaluate('new Promise(res => setTimeout(() => { const t = Date.now(); while (Date.now() - t < 2500); res(1); }, 0))');
  await sleep(100);
  const probe = await page.hasPasswordLikeField();
  assert.equal(probe.found, null);
  assert.ok(probe.frames.every((u) => typeof u === 'string') && probe.frames.length >= 1);
  await busy;
  const gone = await inst.openPage({});
  await gone.close();
  await assert.rejects(gone.hasPasswordLikeField(), (e: DriverError) => e instanceof DriverError);
});

// 请求发出后页面立刻换掉文档：探测不能落到新文档上得出一个错的 false。窗口取决于时序，所以只断言「不是 false」。
test('fromLoginForm is not false when the page navigates away right after sending', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/sso.html');
  seen = [];
  await page.evaluate(`fetch('/api/ids', { method: 'POST', body: 'a=1' }).catch(() => {}); location.href = '/profile.html'; 1`);
  await settle();
  const r = seen.find(x => x.method === 'POST' && x.url.endsWith('/api/ids'));
  assert.ok(r !== undefined && r.fromLoginForm !== false);
});

test('fromLoginForm is not false when a page with an inserted password field reloads right after sending', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/profile.html');
  await page.evaluate(`(() => { const i = document.createElement('input'); i.type = 'password'; document.body.append(i); })()`);
  seen = [];
  await page.evaluate(`fetch('/api/ids', { method: 'POST', body: 'a=1' }).catch(() => {}); location.reload(); 1`);
  await settle();
  const r = seen.find(x => x.method === 'POST' && x.url.endsWith('/api/ids'));
  assert.ok(r !== undefined && r.fromLoginForm !== false);
});

// 【实测】页面线程被同步 XHR 占着时，页面里的探测跑不起来：300 ms 后 null，请求照常交给内核，不被探测卡住。
test('a probe blocked by a synchronous XHR times out to null without stalling the request', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/profile.html');
  seen = [];
  const t0 = Date.now();
  await page.evaluate(`(() => { const x = new XMLHttpRequest(); x.open('POST', '/api/sync', false); x.setRequestHeader('content-type', 'text/plain'); x.send('a=1'); return x.status; })()`);
  const elapsed = Date.now() - t0;
  const r = seen.find(x => x.method === 'POST' && x.url.endsWith('/api/sync'))!;
  assert.equal(r.fromLoginForm, null);
  assert.ok(elapsed < 5000, `the request was held for ${elapsed} ms`);
  assert.ok(server.hits.some(h => h.path === '/api/sync'), 'the request still reached the server');
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

// followRedirects: false（design 5.10）：驱动自己发首跳（route.fetch maxRedirects:0），不跟随重定向，后续跳到不了服务端。
type Done = { id: string; status: number | null; failed: boolean; redirectRefused?: true };
const noRedirect = (r: RequestInfo, path: string): Decision =>
  r.method === 'POST' && r.url.endsWith(path) ? { action: 'continue', followRedirects: false } : { action: 'continue' };

test('followRedirects: false refuses a redirected write at the first hop and reports it once', { timeout: 60_000 }, async () => {
  const done: Done[] = [];
  inst.onRequestDone(e => { done.push(e); });
  const before = server.hits.length;
  decide = r => noRedirect(r, '/r307');
  const outcome = await page.evaluate(`fetch('/r307', { method: 'POST', body: 'x' }).then(() => 'sent', () => 'blocked')`);
  await settle();
  assert.equal(outcome, 'blocked');
  const mine = server.hits.slice(before);
  assert.equal(mine.filter(h => h.path === '/r307').length, 1, 'the first hop was sent exactly once');
  assert.ok(!mine.some(h => h.path === '/api/sink'), 'the redirect target must not be reached');
  const req = seen.find(r => r.method === 'POST' && r.url.endsWith('/r307'))!;
  assert.deepEqual(done.filter(e => e.id === req.id), [{ id: req.id, status: 307, failed: true, redirectRefused: true }]);
});

test('without followRedirects: false the same redirected write reaches its target', { timeout: 60_000 }, async () => {
  const before = server.hits.length;
  decide = () => ({ action: 'continue' });
  await page.evaluate(`fetch('/r307', { method: 'POST', body: 'x' })`); await settle();
  assert.ok(server.hits.slice(before).some(h => h.path === '/api/sink' && h.method === 'POST'));
});

test('followRedirects: false on a write that answers 200 passes the response through', { timeout: 60_000 }, async () => {
  const done: Done[] = [];
  inst.onRequestDone(e => { done.push(e); });
  const before = server.hits.length;
  decide = r => noRedirect(r, '/api/echo');
  const out = await page.evaluate(`fetch('/api/echo', { method: 'POST', body: 'payload' }).then(async r => r.status + ':' + await r.text())`);
  assert.equal(out, '200:{"ok":true}');
  const hit = server.hits.slice(before).find(h => h.path === '/api/echo')!;
  assert.equal(hit.body, 'payload');
  await settle();
  const req = seen.find(r => r.method === 'POST' && r.url.endsWith('/api/echo'))!;
  assert.deepEqual(done.filter(e => e.id === req.id), [{ id: req.id, status: 200, failed: false }]);
});

test('followRedirects: false still sends the browser cookies and hands Set-Cookie back to the browser', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/login.html'); await settle();   // 服务端在这里设 fixture_login=1
  const first = server.cookieSeen.length;
  decide = r => noRedirect(r, '/api/cookie');
  const out = await page.evaluate(`fetch('/api/cookie', { method: 'POST', body: 'x' }).then(r => r.status)`);
  assert.equal(out, 200);
  assert.equal(server.cookieSeen.length, first + 1);
  assert.match(server.cookieSeen.at(-1) ?? '', /fixture_login=1/);
  assert.match(String(await page.evaluate('document.cookie')), /\bk=v\b/);
});

test('followRedirects: false on a cross-origin write is continued natively, so SameSite still applies', { timeout: 60_000 }, async () => {
  await page.goto(server.altOrigin + '/set-strict'); await settle();   // localhost 上的 Strict cookie
  await page.goto(server.origin + '/index.html'); await settle();
  const first = server.cookieSeen.length;
  decide = r => noRedirect(r, '/api/cookie');
  // 页面在 127.0.0.1，目标在 localhost：跨站。浏览器自己发的话不会带 Strict cookie；经 route.fetch 发就会带上。
  await page.evaluate(`fetch('${server.altOrigin}/api/cookie', { method: 'POST', body: 'x', mode: 'no-cors', credentials: 'include' }).catch(() => {})`); await settle();
  assert.equal(server.cookieSeen.length, first + 1, 'the cross-origin write reached the server');
  assert.doesNotMatch(server.cookieSeen.at(-1) ?? '', /strict_c/, 'a SameSite=Strict cookie must not ride along on a cross-site request');
});

test('followRedirects: false does not call a failed fetch a refused redirect just because the message mentions redirect', { timeout: 60_000 }, async () => {
  const done: Done[] = [];
  inst.onRequestDone(e => { done.push(e); });
  decide = r => noRedirect(r, '/api/redirect-reset');
  const outcome = await page.evaluate(`fetch('/api/redirect-reset', { method: 'POST', body: 'x' }).then(() => 'sent', () => 'blocked')`);
  await settle();
  assert.equal(outcome, 'blocked');
  const req = seen.find(r => r.method === 'POST' && r.url.endsWith('/api/redirect-reset'))!;
  const mine = done.filter(e => e.id === req.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.failed, true);
  assert.equal(mine[0]!.status, null);
  assert.ok(!('redirectRefused' in mine[0]!), 'a failed fetch is not a refused redirect');
});

test('followRedirects: false decodes a gzip response body', { timeout: 60_000 }, async () => {
  decide = r => noRedirect(r, '/api/gzip');
  const out = await page.evaluate(`fetch('/api/gzip', { method: 'POST', body: 'x' }).then(r => r.text())`);
  assert.equal(out, '{"gzip":"decoded"}');
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

test('initiatorUrl of a form-submit navigation is the page that was committed when it was sent, also after a 302; other requests carry topUrl', { timeout: 60_000 }, async () => {
  seen = [];
  const formUrl = server.origin + '/form.html';
  await page.goto(formUrl);
  await page.click('#submit-form'); await settle();
  const nav = seen.find(r => r.method === 'POST' && r.url.endsWith('/api/form') && r.isNavigation)!;
  assert.ok(nav, 'the form navigation was not seen');
  assert.equal(nav.topFrame, true);
  assert.equal(nav.topUrl, server.origin + '/api/form');   // 目标
  assert.equal(nav.initiatorUrl, formUrl);                 // 发起页
  // 经 302 落到 form.html，再提交表单：发起页是 302 的最终地址。
  seen = [];
  await page.goto(server.origin + '/redir-form');
  assert.equal((await page.location()).url, formUrl);
  await page.click('#submit-form'); await settle();
  const after = seen.find(r => r.method === 'POST' && r.url.endsWith('/api/form') && r.isNavigation)!;
  assert.ok(after, 'the form navigation after the redirect was not seen');
  assert.equal(after.initiatorUrl, formUrl);
  // 非导航请求：initiatorUrl 和 topUrl 一样；落地页之后发起的 fetch 也一样。
  seen = [];
  await page.goto(server.origin + '/index.html');
  await page.evaluate(`fetch('/api/items?init=1', { method: 'POST', body: '{}' })`); await settle();
  const post = seen.find(r => r.url.includes('init=1'))!;
  assert.equal(post.initiatorUrl, post.topUrl); assert.equal(post.initiatorUrl, server.origin + '/index.html');
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

// 运行时生成的十六进制串，仓库里没有字面量。
function randomHex(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}

function hasFragment(text: string, secret: string, min = 8): boolean {
  for (let i = 0; i + min <= secret.length; i++) if (text.includes(secret.slice(i, i + min))) return true;
  return false;
}

async function failureOf(act: () => Promise<unknown>): Promise<DriverError> {
  const e = await act().then(() => null, (x: unknown) => x);
  assert.ok(e instanceof DriverError, String(e));
  return e;
}

function execCtx() {
  return { recorder: new Recorder(), runDir: makeTmp('e2k-hints-'), now: () => new Date() };
}

test('a selector that matches several elements: one-line message, a count, and the candidates with a way to pick one', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/overlay.html');
  const err = await failureOf(() => page.click('.dup'));
  assert.equal(err.kind, 'other'); assert.ok(!err.message.includes('\n'));
  assert.equal(err.hints[0], '共 2 个匹配');
  assert.equal(err.hints.length, 3);
  assert.match(err.hints[1]!, /^1\) 可写 \.dup >> nth=0 · button @\(-?\d+,-?\d+ \d+x\d+\) "First duplicate"$/);
  assert.match(err.hints[2]!, /^2\) 可写 \.dup >> nth=1 · button @\(.*\) "Second duplicate"$/);
  assert.equal(await page.text({ target: '.dup >> nth=1' }), 'Second duplicate');     // 提示里的写法真的能用
  const fillErr = await failureOf(() => page.fill('.dup-in', 'v'));
  assert.equal(fillErr.hints[0], '共 2 个匹配');
  assert.match(fillErr.hints[1]!, /^1\) 可写 \.dup-in >> nth=0 · textbox @\(.*\) "First field"$/);
  for (const act of [() => page.hover('.dup'), () => page.press('Enter', '.dup'), () => page.scroll({ target: '.dup' })])
    assert.equal((await failureOf(act)).hints[0], '共 2 个匹配');
  // 找不到的目标没有 hints：不提前失败，也不另外探测
  const gone = await failureOf(() => page.click('#nope'));
  assert.equal(gone.kind, 'not-found'); assert.deepEqual(gone.hints, []);
});

test('a click covered by another element: the intercepting element comes back as a hint, in full', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/overlay.html');
  const secret = randomHex(160);
  // Playwright 的预览把属性值短的排在前面：140 字符的填充在前、160 位的 data-x 在后，旧的 200 字符截断点正好落在 data-x 中间
  await page.evaluate(`(() => { document.getElementById('veil').outerHTML = '<div id="veil" style="position:fixed;inset:0" data-a="${'p'.repeat(140)}" data-x="${secret}"></div>'; })()`);
  const err = await failureOf(() => page.click('#covered'));
  assert.equal(err.kind, 'timeout'); assert.ok(!err.message.includes('\n'));
  const hint = err.hints.find(h => h.includes('veil') && h.includes('intercepts pointer events'));
  assert.ok(hint !== undefined, JSON.stringify(err.hints));
  assert.ok(hint.startsWith('被遮挡：<div')); assert.ok(hint.length > 200);
  assert.ok(hint.includes(secret), 'the driver only guards the length; it does not cut the line short');
  assert.equal(err.hints.length, 1);
});

test('the kernel redacts the real driver\'s hints before cutting them', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/overlay.html');
  const secret = randomHex(160);
  const nameSecret = randomHex(64);
  await page.evaluate(`(() => { document.getElementById('veil').outerHTML = '<div id="veil" style="position:fixed;inset:0" data-a="${'p'.repeat(140)}" data-x="${secret}"></div>';
    document.querySelectorAll('.dup')[1].setAttribute('aria-label', '${'n'.repeat(60)} ${nameSecret}'); })()`);
  const ctx = execCtx();
  const covered = await runOps(page, [{ op: 'click', target: '#covered' }], ctx);
  assert.equal(covered[0]!.outcome, 'failed');
  assert.ok(!hasFragment(JSON.stringify([covered, ctx.recorder.actions]), secret));
  assert.ok(covered[0]!.hints!.some(h => h.startsWith('被遮挡：') && h.includes('[REDACTED]')));
  const dup = await runOps(page, [{ op: 'click', target: '.dup' }], ctx);
  assert.ok(!hasFragment(JSON.stringify([dup, ctx.recorder.actions]), nameSecret));
  assert.ok(dup[0]!.hints!.some(h => h.startsWith('2) 可写 .dup >> nth=1 · button @(')));
  assert.ok(dup[0]!.hints!.every(h => h.length <= 330));
});

test('a long candidate name is cut at its tail: the way to pick it and its position stay in the hint', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/overlay.html');
  await page.evaluate(`document.querySelectorAll('.dup')[0].setAttribute('aria-label', '${'n'.repeat(9000)}')`);
  const err = await failureOf(() => page.click('.dup'));
  assert.ok(err.hints[1]!.length <= 4000);                 // 页内先截到 4000，驱动再留保护上限
  const ctx = execCtx();
  const [r] = await runOps(page, [{ op: 'click', target: '.dup' }], ctx);
  assert.ok(r!.hints![1]!.startsWith('1) 可写 .dup >> nth=0 · button @('), r!.hints![1]);
  assert.ok(r!.hints![1]!.length <= 330);
});

test('Playwright cuts the element preview at 500 characters: a token across that point is not left in pieces', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/overlay.html');
  const secret = randomHex(480);
  // 属性按长度升序拼：451 字符的填充在前，480 位的 data-x 在后，从第 480 个字符起只剩 data-x 的开头
  await page.evaluate(`(() => { document.getElementById('veil').outerHTML = '<div id="veil" style="position:fixed;inset:0" data-a="${'p'.repeat(451)}" data-x="${secret}"></div>'; })()`);
  const err = await failureOf(() => page.click('#covered'));
  const hint = err.hints.find(h => h.startsWith('被遮挡：'));
  assert.ok(hint !== undefined, JSON.stringify(err.hints));
  assert.ok(!hasFragment(hint, secret), hint);
  assert.ok(hint.includes('data-a=') && hint.includes('data-x="…></div>'), hint);
  const ctx = execCtx();
  const [r] = await runOps(page, [{ op: 'click', target: '#covered' }], ctx);
  assert.ok(!hasFragment(JSON.stringify([r, ctx.recorder.actions]), secret));
});

test('dropTruncatedRuns: drops the run in front of every ellipsis, keeps everything else, and is linear on hostile input', () => {
  assert.equal(dropTruncatedRuns('<div id="a" data-x="1234…></div>'), '<div id="a" data-x="…></div>');
  assert.equal(dropTruncatedRuns('<input id="a" data-x="1234…/>'), '<input id="a" data-x="…/>');
  assert.equal(dropTruncatedRuns('<div id="a">kkkab12…</div>'), '<div id="a">…</div>');
  assert.equal(dropTruncatedRuns('<div id="a" data-x="12 34 56…>t</div>'), '<div id="a" data-x="12 34 …>t</div>');
  assert.equal(dropTruncatedRuns('<div id="a" data-x="1234"></div>'), '<div id="a" data-x="1234"></div>');
  assert.equal(dropTruncatedRuns('<div id=\'a\' q=b…>x</div>'), '<div id=\'a\' q=…>x</div>');
  assert.equal(dropTruncatedRuns('<div>…</div>'), '<div>…</div>');
  for (const hostile of ['…'.repeat(40_000), 'a…'.repeat(40_000), '…>'.repeat(40_000), '="'.repeat(40_000) + '…>', 'a'.repeat(40_000) + '…', ' a="'.repeat(40_000) + '…/>']) {
    const t = Date.now();
    dropTruncatedRuns(hostile); interceptHint(`x\n  - ${hostile} intercepts pointer events`);
    assert.ok(Date.now() - t < 2000);
  }
});

// 预览里整段属性文字截在 500 个字符：数学上等价的 Playwright 行文，用来在单元里构造（真浏览器的版本见下）
function previewLine(attrs: [string, string][], text: string): string {
  const cut = (s: string, cap: number): string => ([...s].length > cap ? [...s].slice(0, cap - 1).join('') + '…' : s);
  const a = attrs.map(([n, v]) => ` ${n}="${v}"`).sort((x, y) => x.length - y.length);
  return `<div${cut(a.join(''), 500)}>${cut(text, 50)}</div>`;
}

test('a fake ellipsis-and-bracket in a short attribute does not stop the real cut from being cleaned (pads 436-459, several variants)', () => {
  const secret = randomHex(700);
  for (const fake of ['…>', '…/>', '…>q']) {
    for (let pad = 436; pad <= 459; pad++) {
      const line = previewLine([['id', 'veil'], ['data-f', 'p'.repeat(pad) + fake], ['data-x', secret]], '');
      const hint = interceptHint(`x\nCall log:\n  - ${line} intercepts pointer events`)!;
      assert.ok(!hasFragment(redactText(hint).slice(0, 300), secret), `${fake} ${pad}`);
      assert.ok(!hasFragment(hint, secret), `${fake} ${pad}`);
    }
  }
});

test('real browser: a fake ellipsis in an early attribute, and a token cut by the text-content limit, are not left in pieces', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/overlay.html');
  const secret = randomHex(700);
  await page.evaluate(`(() => { document.getElementById('veil').outerHTML = '<div id="veil" style="position:fixed;inset:0" data-f="${'p'.repeat(447)}…&gt;" data-x="${secret}"></div>'; })()`);
  const fake = await failureOf(() => page.click('#covered'));
  const h1 = fake.hints.find(h => h.startsWith('被遮挡：'))!;
  assert.ok(h1 !== undefined && !hasFragment(h1, secret), String(h1));
  // 文字内容在 50 字符处截断：30 个 k 加 64 位十六进制，只剩 20 位的开头
  const textSecret = randomHex(64);
  await page.evaluate(`(() => { document.getElementById('veil').outerHTML = '<div id="veil" style="position:fixed;inset:0">${'k'.repeat(30)}${textSecret}</div>'; })()`);
  const ctx = execCtx();
  const [r] = await runOps(page, [{ op: 'click', target: '#covered' }], ctx);
  assert.ok(r!.hints!.some(h => h.startsWith('被遮挡：')), JSON.stringify(r!.hints));
  assert.ok(!hasFragment(JSON.stringify([r, ctx.recorder.actions]), textSecret), JSON.stringify(r!.hints));
  const raw = await failureOf(() => page.click('#covered'));
  assert.ok(!hasFragment(raw.hints.join('\n'), textSecret), raw.hints.join('\n'));
});

test('describeCandidates caps every name at 4000 characters inside the page', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    await p.setContent(`<button class="c" aria-label="${'a'.repeat(9000)}">x</button><button class="c">${'b'.repeat(9000)}</button><input class="c" aria-label="${'d'.repeat(9000)}">`);
    const found = await p.locator('.c').evaluateAll(describeCandidates, 5);
    assert.deepEqual(found.map(c => c.name.length), [4000, 4000, 4000]);
  } finally {
    await browser.close();
  }
});

test('a strict-mode text that is not on the first line of the message is not a strict violation', { timeout: 60_000 }, async () => {
  // 页面文字可以出现在调用记录里；只有第一行里有 strict mode violation 才取候选
  await page.goto(server.origin + '/overlay.html');
  await page.evaluate(`document.getElementById('veil').outerHTML = '<div id="veil" style="position:fixed;inset:0" title="strict mode violation"></div>'`);
  const err = await failureOf(() => page.click('#covered'));
  assert.ok(err.hints.every(h => !h.startsWith('共 ')), JSON.stringify(err.hints));
  assert.ok(err.hints.some(h => h.startsWith('被遮挡：') && h.includes('strict mode violation')));
});

test('guardedHints: a collector that throws or hangs gives no hints, and a good one passes through', async () => {
  assert.deepEqual(await guardedHints(async () => ['a'], 1000), ['a']);
  assert.deepEqual(await guardedHints(() => Promise.reject(new Error('boom')), 1000), []);
  assert.deepEqual(await guardedHints(() => { throw new Error('sync boom'); }, 1000), []);
  const t = Date.now();
  assert.deepEqual(await guardedHints(() => new Promise<string[]>(() => {}), 100), []);   // 永不返回
  assert.ok(Date.now() - t < 1500);
  assert.deepEqual(await guardedHints(() => new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('late')), 200)), 50), []);
  await sleep(300);        // 超时之后才失败的收集不能变成未处理的拒绝
});

test('a failed fill carries >> nth hints, and the typed value is not in them', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/overlay.html');
  const value = 'typed-' + randomHex(6);
  await page.evaluate(`document.querySelectorAll('.dup-in')[1].setAttribute('aria-label', 'field ${value}')`);
  const ctx = execCtx();
  const [r] = await runOps(page, [{ op: 'fill', target: '.dup-in', value }], ctx);
  assert.equal(r!.outcome, 'failed');
  assert.ok(r!.hints!.some(h => h.includes('>> nth=0')), JSON.stringify(r!.hints));
  assert.ok(!JSON.stringify([r, ctx.recorder.actions]).includes(value));
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

// PNG 的宽高：IHDR 在固定位置。
function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// 把 png 文件画进页面里的 canvas，取 (x, y) 一点的 RGB。
async function pngPixel(p: Page, file: string, x: number, y: number): Promise<[number, number, number]> {
  const url = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  const px = await p.evaluate(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      resolve(Array.from(g.getImageData(${x}, ${y}, 1, 1).data).slice(0, 3));
    };
    img.onerror = () => reject(new Error('png did not decode'));
    img.src = ${JSON.stringify(url)};
  })`);
  return px as [number, number, number];
}

const near = (got: number[], want: number[]): boolean => got.every((v, i) => Math.abs(v - want[i]!) <= 8);

test('screenshot with format png writes a PNG', { timeout: 60_000 }, async () => {
  const file = join(makeTmp('e2k-shot-'), 'shot.png');
  await page.screenshot({ path: file, fullPage: false, format: 'png' });
  assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('screenshot of a target is narrower than the viewport and uses strict matching with diagnostics', { timeout: 60_000 }, async () => {
  const dir = makeTmp('e2k-shot-');
  const whole = join(dir, 'whole.png');
  await page.screenshot({ path: whole, fullPage: false, format: 'png' });
  const part = join(dir, 'part.png');
  await page.screenshot({ path: part, fullPage: false, format: 'png', target: '#styled' });
  assert.ok(pngSize(part).width < pngSize(whole).width, `${pngSize(part).width} vs ${pngSize(whole).width}`);
  assert.ok(pngSize(part).height < pngSize(whole).height);
  const jpg = join(dir, 'part.jpg');
  await page.screenshot({ path: jpg, fullPage: false, target: '#styled' });
  assert.deepEqual([...readFileSync(jpg).subarray(0, 2)], [0xff, 0xd8]);
  const gone = await failureOf(() => page.screenshot({ path: join(dir, 'gone.png'), fullPage: false, format: 'png', target: '#nope' }));
  assert.equal(gone.kind, 'not-found');
  await page.goto(server.origin + '/overlay.html');
  const err = await failureOf(() => page.screenshot({ path: join(dir, 'dup.png'), fullPage: false, format: 'png', target: '.dup' }));
  assert.equal(err.kind, 'other'); assert.ok(!err.message.includes('\n'));
  assert.equal(err.hints[0], '共 2 个匹配');
});

test('a mask target that matches nothing fails the screenshot and writes no file', { timeout: 60_000 }, async () => {
  const file = join(makeTmp('e2k-shot-'), 'masked.png');
  const err = await failureOf(() => page.screenshot({ path: file, fullPage: false, format: 'png', mask: ['#styled', '#nope'] }));
  assert.equal(err.kind, 'not-found'); assert.equal(err.message, 'mask[1] matched no element');
  assert.ok(!existsSync(file));
});

test('screenshot mask paints the masked element in the mask colour', { timeout: 60_000 }, async () => {
  const dir = makeTmp('e2k-shot-');
  const box = await page.evaluate(`(() => { const r = document.getElementById('styled').getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`) as [number, number];
  const plain = join(dir, 'plain.png');
  await page.screenshot({ path: plain, fullPage: false, format: 'png' });
  assert.ok(!near(await pngPixel(page, plain, box[0], box[1]), [255, 0, 255]), 'not magenta before masking');
  const masked = join(dir, 'masked.png');
  await page.screenshot({ path: masked, fullPage: false, format: 'png', mask: ['#styled'], maskColor: '#FF00FF' });
  const got = await pngPixel(page, masked, box[0], box[1]);
  assert.ok(near(got, [255, 0, 255]), `centre pixel ${got.join(',')}`);
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

// ---- waitFor { idle } ----

const startFetches = (urls: string[]): Promise<unknown> =>
  page.evaluate(`(() => { for (const u of ${JSON.stringify(urls)}) fetch(u).catch(() => {}); return 1; })()`);

// 给页面装一个会数「还连着的 observer」的 MutationObserver（在页面里自己数：只用来查内核有没有留下残留）。
const trackObservers = (): Promise<unknown> => page.evaluate(`(() => {
  window.__live = 0;
  const Orig = window.MutationObserver;
  window.MutationObserver = class extends Orig {
    observe(...a) { if (!this.__on) { this.__on = true; window.__live++; } return super.observe(...a); }
    disconnect() { if (this.__on) { this.__on = false; window.__live--; } return super.disconnect(); }
  };
  return 1;
})()`);

test('idle returns after a quiet window on a quiet page, and not before the window has passed', { timeout: 60_000 }, async () => {
  const t0 = Date.now();
  await page.waitFor({ idle: 300 }, 5000);
  const took = Date.now() - t0;
  assert.ok(took >= 290 && took < 4000, `took ${took} ms`);
});

test('idle waits for a late DOM change and then for a full quiet window after it', { timeout: 60_000 }, async () => {
  await page.evaluate(`setTimeout(() => { document.body.append(document.createElement('hr')); window.__inserted = performance.now(); }, 300)`);
  const t0 = Date.now();
  await page.waitFor({ idle: 500 }, 5000);
  const took = Date.now() - t0;
  assert.equal(typeof await page.evaluate('window.__inserted'), 'number', 'returned before the DOM change');
  assert.ok(took >= 750, `returned only ${took} ms in`);
});

test('idle times out while a request is in flight, naming at most 3 of them', { timeout: 60_000 }, async () => {
  await startFetches(['/slow?n=1']);
  const t0 = Date.now();
  await assert.rejects(page.waitFor({ idle: 200 }, 1000), (e: DriverError) => {
    assert.ok(e instanceof DriverError && e.kind === 'timeout', String(e));
    assert.equal(e.message, 'page did not become idle');
    assert.equal(e.hints.length, 1);
    assert.ok(e.hints[0]!.endsWith('/slow?n=1'), e.hints[0]);
    return true;
  });
  assert.ok(Date.now() - t0 < 4000);
  await startFetches(['/slow?n=2', '/slow?n=3', '/slow?n=4', '/slow?n=5']);
  await assert.rejects(page.waitFor({ idle: 200 }, 1000), (e: DriverError) => e.hints.length === 3 && e.hints.every((h) => h.includes('/slow?n=')));
});

test('idle does not return when a request starts and ends inside the first quiet window', { timeout: 60_000 }, async () => {
  // 150 ms 时发一个快请求：它在窗口里整个开始又结束，返回时刻的进行中个数是 0，只有活动序号看得出窗口不安静。
  await page.evaluate(`setTimeout(() => { fetch('/index.html').then((r) => r.text()); }, 150)`);
  const t0 = Date.now();
  await page.waitFor({ idle: 500 }, 5000);
  const took = Date.now() - t0;
  assert.ok(took >= 900, `returned after ${took} ms`);
});

test('idle comes back once the request has finished', { timeout: 60_000 }, async () => {
  await startFetches(['/slow?ms=700']);
  const t0 = Date.now();
  await page.waitFor({ idle: 200 }, 5000);
  assert.ok(Date.now() - t0 >= 700, `returned after ${Date.now() - t0} ms`);
});

test('idle is not stuck by a redirect chain, from fetch or from navigation', { timeout: 60_000 }, async () => {
  await startFetches(['/redir', '/redir']);
  await page.waitFor({ idle: 200 }, 5000);
  await page.evaluate(`setTimeout(() => { location.href = '/redir'; }, 50)`);
  await page.waitFor({ idle: 300 }, 8000);
  assert.equal(await page.read({ kind: 'url' }), server.origin + '/index.html');
});

test('idle does not count an event stream that is still waiting for its response, but a plain request waiting for one still counts', { timeout: 60_000 }, async () => {
  await page.evaluate(`(() => { window.__es = new EventSource('/events?late=1'); return 1; })()`);
  await page.waitFor({ idle: 300 }, 2000);
  await startFetches(['/slow?ms=30000']);
  await assert.rejects(page.waitFor({ idle: 300 }, 1000), (e: DriverError) => e.kind === 'timeout' && e.hints.length === 1 && e.hints[0]!.includes('/slow'));
});

test('idle leaves no observer behind: on success, on timeout, and the page gets nothing exposed', { timeout: 60_000 }, async () => {
  await trackObservers();
  const globals = (): Promise<unknown> => page.evaluate(`Object.getOwnPropertyNames(window).sort()`);
  const globalsBefore = await globals();
  await page.waitFor({ idle: 300 }, 5000);
  assert.equal(await page.evaluate('window.__live'), 0);
  // 之后再改 DOM：没有残留的 observer
  await page.evaluate(`document.body.append(document.createElement('hr'))`);
  await sleep(300);
  assert.equal(await page.evaluate('window.__live'), 0);
  // 超时路径：页面一直在变
  await page.evaluate(`window.__tick = setInterval(() => { document.body.append(document.createElement('i')); }, 100)`);
  await assert.rejects(page.waitFor({ idle: 1000 }, 1500), (e: DriverError) => e.kind === 'timeout' && e.hints.length === 0);
  assert.equal(await page.evaluate('window.__live'), 0);
  await page.evaluate(`clearInterval(window.__tick)`);
  // 页面里没有内核留下的全局或回调
  assert.deepEqual((await globals() as string[]).filter((k) => k !== '__tick'), globalsBefore);
});

test('idle retries when a navigation destroys the page context, and a page closed mid-wait is an error', { timeout: 60_000 }, async () => {
  await page.evaluate(`setTimeout(() => { location.href = '/index.html?again=1'; }, 150)`);
  await page.waitFor({ idle: 1000 }, 8000);
  assert.equal(await page.read({ kind: 'url' }), server.origin + '/index.html?again=1');
  await startFetches(['/slow?n=9']);
  const pending = page.waitFor({ idle: 300 }, 8000);
  const outcome = assert.rejects(pending, (e: DriverError) => e instanceof DriverError);
  await sleep(200);
  await page.close();
  await outcome;
});

// ---- openPage({ touch: true }): 会话页按页模拟触屏，`(pointer: coarse)` 成立 ----

const COARSE = `matchMedia('(pointer: coarse)').matches`;

test('touch: a touch page matches (pointer: coarse) after goto, and a plain page in the same context does not', { timeout: 60_000 }, async () => {
  const touch = await inst.openPage({ touch: true });
  const plain = await inst.openPage({});
  try {
    await touch.goto(server.origin + '/index.html');
    await plain.goto(server.origin + '/index.html');
    assert.equal(await touch.evaluate(COARSE), true);
    assert.equal(await touch.evaluate(`matchMedia('(any-pointer: coarse)').matches`), true);
    assert.equal(await plain.evaluate(COARSE), false);
    assert.equal(await page.evaluate(COARSE), false);           // beforeEach 开的那页
    assert.equal(await touch.evaluate(COARSE), true);            // 另开的页没有把它冲掉
  } finally {
    await touch.close().catch(() => {});
    await plain.close().catch(() => {});
  }
});

test('touch: still coarse after setViewport, after every kind of screenshot, and after a cross-site goto', { timeout: 60_000 }, async () => {
  const touch = await inst.openPage({ touch: true, viewport: { width: 800, height: 600 } });
  const dir = makeTmp('e2k-touch-');
  try {
    await touch.goto(server.origin + '/index.html');
    assert.equal(await touch.evaluate(COARSE), true);
    await touch.setViewport({ width: 600, height: 500 });
    assert.equal(await touch.evaluate(COARSE), true);
    await touch.screenshot({ path: join(dir, 'a.jpg'), fullPage: false });
    assert.equal(await touch.evaluate(COARSE), true);
    await touch.evaluate(`document.body.style.minHeight = '5000px'`);   // 超出视口：fullPage 截图会走 captureBeyondViewport
    await touch.screenshot({ path: join(dir, 'b.jpg'), fullPage: true });
    assert.equal(await touch.evaluate(COARSE), true);
    await touch.screenshot({ path: join(dir, 'c.png'), fullPage: false, format: 'png', target: 'body' });
    assert.equal(await touch.evaluate(COARSE), true);
    await touch.goto(server.altOrigin + '/index.html');
    assert.equal(await touch.evaluate(COARSE), true);
    assert.equal(await touch.evaluate(`'ontouchstart' in window`), true);
  } finally {
    await touch.close().catch(() => {});
  }
});

test('touch: closing the touch page leaves other pages alone, and a new touch page can be opened after it', { timeout: 60_000 }, async () => {
  const touch = await inst.openPage({ touch: true });
  await touch.goto(server.origin + '/index.html');
  await touch.close();
  await page.goto(server.origin + '/index.html');
  assert.equal(await page.evaluate(COARSE), false);
  const again = await inst.openPage({ touch: true });
  try {
    await again.goto(server.origin + '/index.html');
    assert.equal(await again.evaluate(COARSE), true);
  } finally {
    await again.close().catch(() => {});
  }
});

// ---- 触屏模拟的失败路径和会话生命周期（桩住 context.newCDPSession） ----

interface Stubbable { context: { newCDPSession: (page: unknown) => Promise<unknown>; pages: () => unknown[] } }

// 临时替换 newCDPSession，跑完还原。
async function withCdpStub(stub: (real: Stubbable['context']['newCDPSession'], context: Stubbable['context']) => Stubbable['context']['newCDPSession'],
  fn: (context: Stubbable['context']) => Promise<void>): Promise<void> {
  const context = (inst as unknown as Stubbable).context;
  const real = context.newCDPSession.bind(context);
  context.newCDPSession = stub(real, context);
  try {
    await fn(context);
  } finally {
    context.newCDPSession = real;
  }
}

test('touch: a CDP session that cannot be created fails the open with a DriverError and leaves no page', { timeout: 60_000 }, async () => {
  await withCdpStub(() => async () => { throw new Error('no cdp here'); }, async (context) => {
    const before = context.pages().length;
    await assert.rejects(inst.openPage({ touch: true }), (e: DriverError) => e instanceof DriverError && e.kind === 'other');
    await until(() => context.pages().length === before);
  });
});

test('touch: a session whose commands succeed but whose pointer is not coarse fails the open, closes the page and detaches exactly once', { timeout: 60_000 }, async () => {
  let detached = 0;
  const sent: string[] = [];
  const fake = { send: async (m: string) => { sent.push(m); }, detach: async () => { detached++; } };
  await withCdpStub(() => async () => fake, async (context) => {
    const before = context.pages().length;
    await assert.rejects(inst.openPage({ touch: true }), (e: DriverError) => e instanceof DriverError && /touch emulation is not available/.test(e.message));
    await until(() => context.pages().length === before);
    assert.deepEqual(sent, ['Emulation.setTouchEmulationEnabled']);
    assert.equal(detached, 1);
  });
});

test('touch: closing a touch page detaches its CDP session exactly once, and a plain openPage creates none', { timeout: 60_000 }, async () => {
  let created = 0;
  let detached = 0;
  await withCdpStub((real) => async (p) => {
    created++;
    const session = await real(p) as { detach: () => Promise<void> };
    const detach = session.detach.bind(session);
    session.detach = async () => { detached++; return detach(); };
    return session;
  }, async () => {
    const plain = await inst.openPage({});
    await plain.close();
    assert.equal(created, 0);
    const touch = await inst.openPage({ touch: true });
    assert.equal(created, 1);
    assert.equal(detached, 0);
    await touch.close();
    await until(() => detached >= 1);
    await sleep(200);
    assert.equal(detached, 1);
  });
});

// 每个 profile 一个实例：两个持久化 context 同时跑，请求各归各的实例、页面 id 不重复、关一个不影响另一个。
test('two persistent instances run side by side: requests are attributed to their own instance, page ids differ, closing one leaves the other alive', { timeout: 120_000 }, async () => {
  const a = await driver.launch({ name: 'admin', userDataDir: makeTmp('e2k-pw-a-') });
  const b = await driver.launch({ name: 'admin@t1', userDataDir: makeTmp('e2k-pw-b-') });
  try {
    const seenA: RequestInfo[] = []; const seenB: RequestInfo[] = [];
    const closed = { a: 0, b: 0 };
    a.setRequestHandler((r) => { seenA.push(r); return { action: 'continue' }; });
    b.setRequestHandler((r) => { seenB.push(r); return { action: 'continue' }; });
    a.onClosed(() => { closed.a++; }); b.onClosed(() => { closed.b++; });
    const pa = await a.openPage({}); const pb = await b.openPage({});
    assert.notEqual(pa.id, pb.id);
    await pa.goto(server.origin + '/index.html'); await pb.goto(server.origin + '/index.html');
    await pa.evaluate(`fetch('/api/ids?who=a', { method: 'POST', body: 'a=1' }).catch(() => {}); 1`);
    await pb.evaluate(`fetch('/api/ids?who=b', { method: 'POST', body: 'b=1' }).catch(() => {}); 1`);
    await until(() => seenA.some((r) => r.url.includes('who=a')) && seenB.some((r) => r.url.includes('who=b')));
    assert.ok(!seenA.some((r) => r.url.includes('who=b')) && !seenB.some((r) => r.url.includes('who=a')));
    assert.ok(seenA.every((r) => r.pageId === pa.id) && seenB.every((r) => r.pageId === pb.id));
    const ids = [...seenA, ...seenB].map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'request ids are unique across instances');
    await a.stop();
    await until(() => closed.a === 1);
    assert.equal(closed.b, 0);
    assert.equal((await b.health()).ok, true);
    assert.equal(await pb.evaluate('1 + 1'), 2);
  } finally {
    await a.stop().catch(() => {}); await b.stop().catch(() => {});
  }
});

test('onNavigationHop reports each hop after the first of a main-frame redirect, with the page id and the hop url; the first request, plain navigations, sub-resources and iframes report nothing', { timeout: 60_000 }, async () => {
  hops = [];
  await page.goto(server.origin + '/index.html');
  await page.evaluate(`fetch('/redir').then((r) => r.status)`);                                                    // 子资源的重定向
  await page.evaluate(`(() => { const f = document.createElement('iframe'); f.src = '/redir'; document.body.append(f); return true; })()`);   // 子 frame 的重定向
  await settle();
  assert.deepEqual(hops, [], 'nothing so far: no main-frame redirect happened');
  // 一跳：127.0.0.1/hop → localhost/index.html（路由回调只见第一个地址，第二跳只能从这里知道）
  await page.goto(`${server.origin}/hop?to=${server.altOrigin}/index.html`);
  await until(() => hops.length >= 1);
  assert.deepEqual(hops, [{ pageId: page.id, url: server.altOrigin + '/index.html' }]);
  assert.deepEqual(seen.filter((r) => r.isNavigation && r.topFrame).map((r) => r.url).slice(-1), [`${server.origin}/hop?to=${server.altOrigin}/index.html`], 'the handler saw only the first request of the chain');
  // 两跳：每一跳都报，按顺序
  hops = [];
  await page.goto(`${server.origin}/hop?to=${server.altOrigin}/hop?to=${server.origin}/index.html`);
  await until(() => hops.length >= 2);
  assert.deepEqual(hops.map((h) => h.url), [`${server.altOrigin}/hop?to=${server.origin}/index.html`, `${server.origin}/index.html`]);
  assert.ok(hops.every((h) => h.pageId === page.id));
});

test('onNavigationHop reports a redirect that a click starts in the page', { timeout: 60_000 }, async () => {
  await page.goto(server.origin + '/cross-hop.html');
  hops = [];
  await page.click('#go');
  await until(() => hops.length >= 1);
  assert.deepEqual(hops, [{ pageId: page.id, url: server.altOrigin + '/index.html' }]);
});

test('clearCookies removes the cookies of that host only: the other host name keeps its own', { timeout: 60_000 }, async () => {
  const cookieOf = async (origin: string): Promise<string> => {
    await page.goto(origin + '/index.html');
    return String(await page.evaluate('document.cookie'));
  };
  await page.goto(server.altOrigin + '/set-strict');                                                                 // localhost 上设一个 cookie
  await page.goto(server.origin + '/set-strict');                                                                    // 127.0.0.1 上设一个
  assert.ok((await cookieOf(server.altOrigin)).includes('strict_c=1'));
  assert.ok((await cookieOf(server.origin)).includes('strict_c=1'));
  await inst.clearCookies('localhost');
  assert.equal(await cookieOf(server.altOrigin), '', 'the host that was cleared has no cookie left');
  assert.ok((await cookieOf(server.origin)).includes('strict_c=1'), 'the other host name keeps its cookie');
  await inst.clearCookies('127.0.0.1');
  assert.equal(await cookieOf(server.origin), '');
  await inst.clearCookies('no-such-host.example.com');                                                               // 没有 cookie 的主机：不报错
});
