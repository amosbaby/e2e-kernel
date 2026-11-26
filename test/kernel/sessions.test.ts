import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DriverError } from '../../src/driver/types.ts';
import { defaultOnlyResolver } from '../../src/kernel/mode.ts';
import { SessionManager } from '../../src/kernel/sessions.ts';
import type { SessionDeps } from '../../src/kernel/sessions.ts';
import { allowAllPolicy } from '../../src/kernel/write-policy.ts';
import type { WritePolicy } from '../../src/kernel/write-policy.ts';
import { RUN_DIR_RE, runDirName } from '../../src/report/store.ts';
import type { RunResult } from '../../src/report/result.ts';
import { E2kError } from '../../src/shared/errors.ts';
import type { Mode } from '../../src/shared/protocol.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

const HOME_PAGE: FakePageSpec = {
  snapshot: '- button "Add" [ref=e2]',
  elements: { e2: {}, '#status': { text: 'Added' }, '#gone': { failWith: 'not-found' } },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function setup(overrides: Partial<SessionDeps> & { launchDelayMs?: number; failOpenWith?: Error } = {}) {
  const { launchDelayMs, failOpenWith, ...depsOverrides } = overrides;
  const fake = new FakeDriver({
    pages: { 'http://localhost:5173/': HOME_PAGE, 'http://localhost:5173/down': { gotoFailWith: 'timeout' },
      'http://localhost:5173/login-down': { gotoFailWith: 'other' } },
    ...(launchDelayMs === undefined ? {} : { launchDelayMs }),
    ...(failOpenWith === undefined ? {} : { failOpenWith }),
  });
  const tmp = makeTmpHome();
  const logs: string[] = [];
  const sm = new SessionManager({
    driver: fake, home: tmp.home, modes: defaultOnlyResolver, policy: allowAllPolicy,
    idleMs: 15 * 60_000, keepRuns: 20, now: () => new Date(), kernelVersion: '0.1.0', log: (line) => { logs.push(line); },
    ...depsOverrides,
  });
  cleanups.push(async () => {
    await sm.shutdown();
    tmp.cleanup();
  });
  return { sm, fake, home: tmp.home, logs };
}

async function opened(sm: SessionManager, fake: FakeDriver, name?: string) {
  const r = await sm.open({ url: 'http://localhost:5173/', ...(name === undefined ? {} : { name }) });
  return { session: r.session, runDir: r.runDir, pageId: fake.openPages().at(-1)! };
}

function readResult(runDir: string): RunResult {
  return JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')) as RunResult;
}

async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met within 2 s');
    await sleep(10);
  }
}

function methodCount(fake: FakeDriver, method: string): number {
  return fake.calls.filter((c) => c.method === method).length;
}

test('open creates a session, a private run dir and a first reading', async () => {
  const { sm, home } = setup();
  const r = await sm.open({ url: 'http://localhost:5173/', name: 'orders' });
  assert.match(r.session, /^s-[0-9a-f]{6}$/); assert.equal(r.mode, 'default'); assert.equal(r.snapshot, '- button "Add" [ref=e2]');
  assert.equal(dirname(r.runDir), join(home.runsDir, 'orders')); assert.match(basename(r.runDir), RUN_DIR_RE);
  assert.equal(statSync(r.runDir).mode & 0o777, 0o700);
  assert.equal((await sm.open({ url: 'http://localhost:5173/' })).name, 'session');
});

test('the default profile is launched lazily and once, even for concurrent opens', async () => {
  const { sm, fake, home } = setup({ launchDelayMs: 50 });
  assert.equal(sm.instanceState(), 'stopped');
  const [a, b] = await Promise.all([sm.open({ url: 'http://localhost:5173/a' }), sm.open({ url: 'http://localhost:5173/b' })]);
  assert.equal(fake.launches, 1); assert.equal(fake.lastProfile!.userDataDir, join(home.profilesDir, 'default'));
  assert.equal(sm.list().length, 2); assert.notEqual(a.session, b.session);
});

test('open fails cleanly when the first navigation fails', async () => {
  const { sm, fake, home } = setup();
  await assert.rejects(sm.open({ url: 'http://localhost:5173/down', name: 'gone' }), (e: E2kError) => e.code === 'action-failed');
  assert.deepEqual(fake.openPages(), []); assert.deepEqual(sm.list(), []);
  assert.ok(!existsSync(join(home.runsDir, 'gone')) || readdirSync(join(home.runsDir, 'gone')).length === 0);
});

test('open cleans up before mapping errors: a driver error becomes a redacted action-failed, anything else is rethrown', async () => {
  // 长得像 token 的串在运行时拼出来，不写成字面量。
  const secret = 'eyJ' + 'a'.repeat(21) + '.' + 'b'.repeat(24) + '.' + 'c'.repeat(24);
  const leaky = setup({ failOpenWith: new DriverError('other', `cannot open http://localhost:5173/?access_token=${secret}\nsecond line`) });
  await assert.rejects(leaky.sm.open({ url: 'http://localhost:5173/', name: 'leaky' }), (e: E2kError) =>
    e.code === 'action-failed' && !e.message.includes(secret) && !e.message.includes('second line'));
  assert.deepEqual(leaky.sm.list(), []);
  assert.ok(!existsSync(join(leaky.home.runsDir, 'leaky')) || readdirSync(join(leaky.home.runsDir, 'leaky')).length === 0);

  const bug = new Error('not a driver error');
  const other = setup({ failOpenWith: bug });
  await assert.rejects(other.sm.open({ url: 'http://localhost:5173/', name: 'bug' }), (e: unknown) => e === bug);
  assert.deepEqual(other.sm.list(), []);
  assert.ok(!existsSync(join(other.home.runsDir, 'bug')) || readdirSync(join(other.home.runsDir, 'bug')).length === 0);
});

test('concurrent step on the same session is rejected as busy', async () => {
  const { sm, fake } = setup(); const { session } = await opened(sm, fake);
  const snapshotsBefore = methodCount(fake, 'snapshot');
  const first = sm.step({ session, ops: [{ op: 'wait', for: { ms: 100 } }] });
  await assert.rejects(sm.step({ session, ops: [{ op: 'snapshot' }] }), (e: E2kError) => e.code === 'busy' && e.next === '稍后重试');
  await first;
  // 被拒的那次一个操作也没碰页面：两次 step 不会交错。
  assert.equal(methodCount(fake, 'snapshot'), snapshotsBefore);
});

test('close while a step is running is rejected as busy, and the session stays usable', async () => {
  const { sm, fake } = setup(); const { session } = await opened(sm, fake);
  const first = sm.step({ session, ops: [{ op: 'wait', for: { ms: 100 } }] });
  await assert.rejects(sm.close({ session }), (e: E2kError) => e.code === 'busy');
  assert.equal((await first).exit, 0);
  const r = await sm.close({ session });
  assert.equal(r.exit, 0); assert.equal(readResult(r.runDir).closedBy, 'agent');
});

test('unknown or closed sessions are not-found', async () => {
  const { sm, fake } = setup(); const { session } = await opened(sm, fake);
  await sm.close({ session });
  await assert.rejects(sm.step({ session, ops: [{ op: 'snapshot' }] }), (e: E2kError) => e.code === 'not-found');
  await assert.rejects(sm.close({ session }), (e: E2kError) => e.code === 'not-found');
  await assert.rejects(sm.step({ session: 's-000000', ops: [{ op: 'snapshot' }] }), (e: E2kError) => e.code === 'not-found');
});

test('close reports mismatch through exit 10 and flags a contradicting verdict', async () => {
  const { sm, fake } = setup(); const { session } = await opened(sm, fake);
  await sm.step({ session, ops: [{ op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Nope' }] });
  const r = await sm.close({ session, verdict: { value: 'pass' } });
  assert.equal(r.exit, 10); assert.equal(r.consistency, 'conflict');
  assert.ok(existsSync(r.reportPath)); assert.ok(existsSync(r.resultPath));
});

test('idle sessions are closed with a report, but not while a step is running', async () => {
  const { sm, fake } = setup({ idleMs: 60 }); const { session, runDir } = await opened(sm, fake);
  await sm.step({ session, ops: [{ op: 'wait', for: { ms: 200 } }] });          // 比闲置超时长
  assert.equal(sm.list().length, 1);
  await until(() => existsSync(join(runDir, 'result.json')));
  assert.equal(readResult(runDir).closedBy, 'idle-timeout'); assert.equal(sm.list().length, 0);
});

test('fails closed when the resolver returns a non-default mode', async () => {
  const { sm, fake } = setup({ modes: { resolve: () => 'readonly' } });
  await assert.rejects(sm.open({ url: 'http://localhost:5173/' }), (e: E2kError) => e.code === 'internal');
  assert.deepEqual(fake.openPages(), []);
});

test('a session request that touches a non-default host is aborted without asking the policy (fail closed)', async () => {
  const asked: string[] = [];
  const spy: WritePolicy = { decide: (r) => { asked.push(r.url); return { action: 'continue' }; }, decideUnattributed: () => ({ action: 'continue' }) };
  const modes = { resolve: (host: string): Mode => (host === 'example.com' ? 'readonly' : 'default') };
  const { sm, fake } = setup({ policy: spy, modes }); const { session, runDir, pageId } = await opened(sm, fake);
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.com/api' }), { action: 'abort' });
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'POST', url: 'http://localhost:5173/api', topUrl: 'http://example.com/' }), { action: 'abort' });
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'POST', url: 'http://localhost:5173/api' }), { action: 'continue' });
  assert.deepEqual(asked, ['http://localhost:5173/api']);
  await sm.close({ session });
  assert.deepEqual(readResult(runDir).writes.blocked.map((w) => w.url), ['http://example.com/api', 'http://localhost:5173/api']);
});

test('shutdown closes every session as kernel-shutdown and stops the instance', async () => {
  const { sm, fake } = setup(); const { runDir } = await opened(sm, fake);
  await sm.shutdown();
  assert.equal(readResult(runDir).closedBy, 'kernel-shutdown'); assert.equal(sm.instanceState(), 'stopped');
});

test('a session id that is in use, or whose run dir already exists, is drawn again', async () => {
  const at = new Date('2026-11-26T10:00:00Z');
  const { sm, home } = setup({ now: () => at });
  const draws = ['aaaaaa', 'aaaaaa', 'cccccc', 'dddddd'];
  const m = mock.method(crypto, 'randomBytes', () => Buffer.from(draws.shift() ?? '000000', 'hex'));
  syncBuiltinESMExports();
  try {
    assert.equal((await sm.open({ url: 'http://localhost:5173/' })).session, 's-aaaaaa');
    mkdirSync(join(home.runsDir, 'session', runDirName(at, 's-cccccc')), { mode: 0o700 });   // 别人留下的同名目录
    assert.equal((await sm.open({ url: 'http://localhost:5173/' })).session, 's-dddddd');
    assert.deepEqual(draws, []);
  } finally {
    m.mock.restore();
    syncBuiltinESMExports();
  }
});

test("same-name concurrent sessions: the running one's dir survives", async () => {
  let t = Date.parse('2026-11-26T10:00:00Z');
  const { sm, fake } = setup({ keepRuns: 1, now: () => new Date(t += 1000) });
  const older = await opened(sm, fake, 'orders');
  const newer = await opened(sm, fake, 'orders');
  assert.ok(basename(older.runDir) < basename(newer.runDir));
  await sm.close({ session: newer.session });             // 保留 1 份：最老的那份本该被删，但它的会话还在跑
  assert.ok(existsSync(older.runDir)); assert.ok(existsSync(newer.runDir));
  const r = await sm.close({ session: older.session });   // 刚收尾的这份是要交给调用方的，也不删
  assert.ok(existsSync(r.resultPath));
});

test('session writes are allowed and recorded; reads are not listed as writes', async () => {
  const { sm, fake } = setup(); const { session, runDir, pageId } = await opened(sm, fake);
  assert.deepEqual(await fake.emitRequest({ id: 'r1', pageId, method: 'POST', url: 'http://localhost:5173/api/items', body: '{"password":"p1"}', contentType: 'application/json' }), { action: 'continue' });
  await fake.emitRequest({ id: 'r2', pageId, method: 'GET', url: 'http://localhost:5173/api/items' });
  fake.emitRequestDone('r1', 201);
  await sm.close({ session });
  const result = readResult(runDir);
  assert.equal(result.writes.allowed.length, 1); assert.equal(result.writes.allowed[0].status, 201);
  assert.deepEqual(result.hosts, [{ host: 'localhost', mode: 'default' }]);
  assert.ok(!JSON.stringify(result).includes('p1'));
});

test('login pages and their popups are continued and never recorded', async () => {
  const { sm, fake } = setup(); const { session, runDir } = await opened(sm, fake);
  const { loginId } = await sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  const loginPageId = fake.openPages().at(-1)!;
  assert.deepEqual(await fake.emitRequest({ pageId: loginPageId, method: 'POST', url: 'http://localhost:5173/api/login' }), { action: 'continue' });
  assert.deepEqual(await fake.emitRequest({ pageId: 'p-sso', openerPageId: loginPageId, method: 'POST', url: 'http://localhost:5173/api/sso' }), { action: 'continue' });
  await sm.loginEnd({ loginId }); assert.ok(!fake.openPages().includes(loginPageId));
  await sm.close({ session });
  const w = readResult(runDir).writes; assert.deepEqual([w.allowed.length, w.unattributed.length], [0, 0]);
});

test('writes from unknown pages are allowed in M1 but reported as unattributed', async () => {
  const { sm, fake } = setup(); const { session, runDir } = await opened(sm, fake);
  assert.deepEqual(await fake.emitRequest({ id: 'u1', pageId: null, method: 'POST', url: 'http://localhost:5173/api/form-blank' }), { action: 'continue' });
  await fake.emitRequest({ id: 'u2', pageId: 'p-stranger', method: 'GET', url: 'http://localhost:5173/' });
  fake.emitRequestDone('u1', 200);
  await sm.close({ session });
  const w = readResult(runDir).writes;
  assert.equal(w.allowed.length, 0); assert.equal(w.unattributed.length, 1);
  assert.equal(w.unattributed[0].url, 'http://localhost:5173/api/form-blank'); assert.equal(w.unattributed[0].status, 200);
});

test('the policy can refuse unattributed requests', async () => {
  const deny: WritePolicy = { decide: () => ({ action: 'continue' }), decideUnattributed: () => ({ action: 'abort' }) };
  const { sm, fake } = setup({ policy: deny }); await opened(sm, fake);
  assert.deepEqual(await fake.emitRequest({ pageId: null, method: 'POST', url: 'http://localhost:5173/api/x' }), { action: 'abort' });
});

test('popup requests are attributed through the opener, and popups are closed with the session', async () => {
  const { sm, fake } = setup(); const { session, runDir, pageId } = await opened(sm, fake);
  await fake.emitRequest({ id: 'p1', pageId: 'p-early', openerPageId: pageId, method: 'POST', url: 'http://localhost:5173/api/early' });
  fake.emitPopup(pageId, 'http://localhost:5173/popup');
  await sm.close({ session });
  assert.deepEqual(fake.openPages(), []);
  assert.equal(readResult(runDir).writes.allowed[0].url, 'http://localhost:5173/api/early');
});

test('page closed by the human: the session ends as page-gone and close-time errors are contained', async () => {
  const { sm, fake, logs } = setup(); const { runDir, pageId } = await opened(sm, fake);
  fake.closePage(pageId);
  await until(() => existsSync(join(runDir, 'result.json')));
  assert.equal(readResult(runDir).closedBy, 'page-gone'); assert.equal(sm.list().length, 0);
  assert.equal(readResult(runDir).coverage.webSockets, 0);                               // 页面已经没了，location() 抛错被接住，按 0 记
  assert.ok(logs.length > 0);                                                            // 接住的异常进了日志
  await sm.open({ url: 'http://localhost:5173/' }); assert.equal(fake.launches, 1);      // 实例还在，直接复用
});

test('browser gone: every session ends as browser-gone exactly once and the next open relaunches', async () => {
  const { sm, fake, home } = setup(); const { runDir } = await opened(sm, fake);
  fake.closeBrowser();
  await until(() => existsSync(join(runDir, 'result.json')));
  assert.equal(readResult(runDir).closedBy, 'browser-gone');
  assert.equal(readdirSync(join(home.runsDir, 'session')).length, 1);
  await sm.open({ url: 'http://localhost:5173/' }); assert.equal(fake.launches, 2);
});

test('browser gone with several sessions and a login page: each session reports once, the login table is cleared', async () => {
  const { sm, fake, home, logs } = setup();
  const a = await opened(sm, fake, 'alpha'); const b = await opened(sm, fake, 'beta');
  const { loginId } = await sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  fake.closeBrowser();
  await until(() => existsSync(join(a.runDir, 'result.json')) && existsSync(join(b.runDir, 'result.json')));
  await sleep(50);                                                                       // 晚到的事件也不会再出一份
  for (const name of ['alpha', 'beta']) assert.equal(readdirSync(join(home.runsDir, name)).length, 1);
  assert.equal(readResult(a.runDir).closedBy, 'browser-gone'); assert.equal(readResult(b.runDir).closedBy, 'browser-gone');
  // 同一个会话只收尾一次：收尾第一步（读 WebSocket 数）在页面没了时必失败并记一行，每个会话正好一行。
  for (const id of [a.session, b.session]) assert.equal(logs.filter((l) => l.includes(id) && l.includes('WebSocket')).length, 1);
  await assert.rejects(sm.loginEnd({ loginId }), (e: E2kError) => e.code === 'not-found');
});

test('a popup closed by the human is only dropped from the session', async () => {
  const { sm, fake, logs } = setup(); const { session, runDir, pageId } = await opened(sm, fake);
  const popup = fake.emitPopup(pageId, 'http://localhost:5173/popup');
  fake.closePage(popup.id);
  await sleep(20);
  assert.equal(sm.list().length, 1);
  await sm.close({ session });
  assert.equal(readResult(runDir).closedBy, 'agent'); assert.deepEqual(logs, []);         // 收尾时没有再去关那个已经没了的弹窗
});

test('the kernel closing its own pages and instance never reports a session twice', async () => {
  const { sm, fake, home } = setup(); const { session } = await opened(sm, fake, 'own');
  fake.emitPopup(fake.openPages().at(-1)!, 'http://localhost:5173/popup');
  await sm.close({ session });
  await opened(sm, fake, 'own');
  await sm.shutdown();
  await sleep(50);
  assert.equal(readdirSync(join(home.runsDir, 'own')).length, 2);
  assert.ok(readdirSync(join(home.runsDir, 'own')).every((d) => ['agent', 'kernel-shutdown'].includes(readResult(join(home.runsDir, 'own', d)).closedBy)));
});

test('session requests: the mode check uses the top URL and falls back to the request URL; top-frame navigations add hosts', async () => {
  const seen: { mode: string; topHost: string | null }[] = [];
  const spy: WritePolicy = { decide: (_r, ctx) => { seen.push(ctx); return { action: 'continue' }; }, decideUnattributed: () => ({ action: 'continue' }) };
  const { sm, fake } = setup({ policy: spy }); const { session, runDir, pageId } = await opened(sm, fake);
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://127.0.0.1:5173/x', topUrl: null });
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://localhost:5173/y', topUrl: 'http://example.com/' });
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.org/', isNavigation: true, topFrame: true, topUrl: 'http://example.org/' });
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.net/frame', isNavigation: true, topFrame: false });
  assert.deepEqual(seen.map((c) => c.topHost), ['127.0.0.1', 'example.com', 'example.org', 'localhost']);
  await sm.close({ session });
  assert.deepEqual(readResult(runDir).hosts.map((h) => h.host), ['localhost', 'example.org']);
});

test('a request whose mode cannot be decided is aborted (fail closed)', async () => {
  let calls = 0;
  const { sm, fake, logs } = setup({ modes: { resolve: () => { if (++calls > 1) throw new Error('rule error'); return 'default'; } } });
  const { pageId } = await opened(sm, fake);
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'GET', url: 'http://localhost:5173/x' }), { action: 'abort' });
  assert.ok(logs.some((l) => l.includes('rule error')));
});

test('login: a failed navigation closes the page; unknown ids are not-found; shutdown closes login pages', async () => {
  const { sm, fake } = setup();
  await assert.rejects(sm.loginBegin({ url: 'http://localhost:5173/login-down' }), (e: E2kError) => e.code === 'action-failed');
  assert.deepEqual(fake.openPages(), []);
  await assert.rejects(sm.loginEnd({ loginId: 'l-000000' }), (e: E2kError) => e.code === 'not-found');
  const { loginId } = await sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  assert.match(loginId, /^l-[0-9a-f]{6}$/);
  const popup = fake.emitPopup(fake.openPages().at(-1)!, 'http://localhost:5173/sso');
  assert.deepEqual(await fake.emitRequest({ pageId: popup.id, method: 'POST', url: 'http://localhost:5173/api/sso' }), { action: 'continue' });
  await sm.shutdown();
  assert.deepEqual(fake.openPages(), []); assert.equal(sm.instanceState(), 'stopped');
});

test('loginEnd closes the login page and its popups, even if a person already closed one', async () => {
  const { sm, fake } = setup();
  const { loginId } = await sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  const loginPageId = fake.openPages().at(-1)!;
  const popup = fake.emitPopup(loginPageId, 'http://localhost:5173/sso');
  fake.closePage(loginPageId);
  assert.deepEqual(await sm.loginEnd({ loginId }), {});
  assert.ok(!fake.openPages().includes(popup.id));
  await assert.rejects(sm.loginEnd({ loginId }), (e: E2kError) => e.code === 'not-found');
});

test('a login id that is in use is drawn again', async () => {
  const { sm } = setup();
  const draws = ['aaaaaa', 'aaaaaa', 'bbbbbb'];
  const m = mock.method(crypto, 'randomBytes', () => Buffer.from(draws.shift() ?? '000000', 'hex'));
  syncBuiltinESMExports();
  try {
    assert.equal((await sm.loginBegin({ url: 'http://localhost:5173/login.html' })).loginId, 'l-aaaaaa');
    assert.equal((await sm.loginBegin({ url: 'http://localhost:5173/login.html' })).loginId, 'l-bbbbbb');
    assert.deepEqual(draws, []);
  } finally {
    m.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a page that goes away while the agent is closing the session is reported once, as the agent close', async () => {
  const { sm, fake, logs } = setup(); const { session, runDir, pageId } = await opened(sm, fake);
  fake.closePage(pageId);                                    // 页面监听器在等健康检查……
  const r = await sm.close({ session });                     // ……这时 agent 的 close 先进了收尾
  await sleep(50);
  assert.equal(readResult(r.runDir).closedBy, 'agent'); assert.equal(r.runDir, runDir);
  assert.equal(logs.filter((l) => l.includes(session) && l.includes('WebSocket')).length, 1);
});

test('browser gone, with the instance event arriving late: the page listener sees the browser is down and each session still reports once', async () => {
  const { sm, fake, logs } = setup();
  // 让实例的 onClosed 晚 30 毫秒才到：页面监听器的健康检查先完成，走「健康检查不 ok → 按浏览器没了处理」这条路。
  const launch = fake.launch.bind(fake);
  fake.launch = async (profile) => {
    const inst = await launch(profile);
    const onClosed = inst.onClosed.bind(inst);
    inst.onClosed = (listener) => { onClosed(() => { setTimeout(listener, 30); }); };
    return inst;
  };
  const a = await opened(sm, fake, 'alpha'); const b = await opened(sm, fake, 'beta');
  fake.closeBrowser();
  await until(() => existsSync(join(a.runDir, 'result.json')) && existsSync(join(b.runDir, 'result.json')));
  await sleep(80);                                                                       // 晚到的实例事件已经来过
  for (const s of [a, b]) {
    assert.equal(readResult(s.runDir).closedBy, 'browser-gone');
    assert.equal(logs.filter((l) => l.includes(s.session) && l.includes('WebSocket')).length, 1);
  }
  await sm.open({ url: 'http://localhost:5173/' }); assert.equal(fake.launches, 2);
});

test('shutdown drains an open that is still launching the browser: it is rejected, cleaned up and never registered', async () => {
  const { sm, fake, home } = setup({ launchDelayMs: 50 });
  const pending = sm.open({ url: 'http://localhost:5173/', name: 'late' });
  const login = sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  await sm.shutdown();
  await assert.rejects(pending, (e: E2kError) => e.code === 'busy' && e.message === '内核正在关停');
  await assert.rejects(login, (e: E2kError) => e.code === 'busy');
  assert.deepEqual(sm.list(), []); assert.deepEqual(fake.openPages(), []); assert.equal(sm.instanceState(), 'stopped');
  assert.ok(!existsSync(join(home.runsDir, 'late')) || readdirSync(join(home.runsDir, 'late')).length === 0);
});

test('shutdown drains an open that is past the launch: the established session gets a report, the in-flight one is rejected', async () => {
  const { sm, fake, home } = setup();
  const { runDir } = await opened(sm, fake, 'early');
  const pending = sm.open({ url: 'http://localhost:5173/', name: 'late' });   // 实例已在，停在开页面、导航之间
  const login = sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  const done = sm.shutdown();
  await assert.rejects(pending, (e: E2kError) => e.code === 'busy');
  await assert.rejects(login, (e: E2kError) => e.code === 'busy');
  await done;
  assert.equal(readResult(runDir).closedBy, 'kernel-shutdown');
  assert.deepEqual(sm.list(), []); assert.deepEqual(fake.openPages(), []); assert.equal(sm.instanceState(), 'stopped');
  assert.ok(!existsSync(join(home.runsDir, 'late')) || readdirSync(join(home.runsDir, 'late')).length === 0);
  assert.equal(fake.launches, 1);
});

test('after shutdown every entry point rejects and the browser is not launched again; shutdown stays idempotent', async () => {
  const { sm, fake } = setup(); const { session } = await opened(sm, fake);
  const { loginId } = await sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  await sm.shutdown();
  const isStopping = (e: E2kError) => e.code === 'busy' && e.message === '内核正在关停';
  await assert.rejects(sm.open({ url: 'http://localhost:5173/' }), isStopping);
  await assert.rejects(sm.step({ session, ops: [{ op: 'snapshot' }] }), isStopping);
  await assert.rejects(sm.close({ session }), isStopping);
  await assert.rejects(sm.loginBegin({ url: 'http://localhost:5173/login.html' }), isStopping);
  await assert.rejects(sm.loginEnd({ loginId }), isStopping);
  assert.equal(fake.launches, 1); assert.equal(sm.instanceState(), 'stopped'); assert.deepEqual(sm.list(), []);
  await sm.shutdown();
  assert.equal(fake.launches, 1);
});

test('shutdown stops the browser only after an in-flight open has settled', async () => {
  const { sm, fake, logs } = setup();
  // 导航慢 50 毫秒：关停开始时 open 还停在 goto 上。
  const launch = fake.launch.bind(fake);
  fake.launch = async (profile) => {
    const inst = await launch(profile);
    const openPage = inst.openPage.bind(inst);
    inst.openPage = async (o) => {
      const page = await openPage(o);
      const goto = page.goto.bind(page);
      page.goto = async (url) => { await sleep(50); return goto(url); };
      return page;
    };
    return inst;
  };
  await sm.open({ url: 'http://localhost:5173/' });            // 先把实例启动起来
  let settled = false;
  const pending = sm.open({ url: 'http://localhost:5173/', name: 'late' });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await sleep(10);
  await sm.shutdown();
  assert.equal(settled, true);
  await assert.rejects(pending, (e: E2kError) => e.code === 'busy');
  assert.ok(!logs.some((l) => l.includes('关页面')));                // 页面是在实例停掉之前、好好关掉的
  assert.deepEqual(fake.openPages(), []);
});
