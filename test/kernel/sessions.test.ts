import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DriverError } from '../../src/driver/types.ts';
import { defaultOnlyResolver } from '../../src/kernel/mode.ts';
import type { ModeResolver } from '../../src/kernel/mode.ts';
import { DEFAULT_PROFILE, profileInfo } from '../../src/kernel/profiles.ts';
import { SessionManager } from '../../src/kernel/sessions.ts';
import type { SessionDeps } from '../../src/kernel/sessions.ts';
import { allowAllPolicy, policy } from '../../src/kernel/write-policy.ts';
import type { PolicyVerdict, WritePolicy } from '../../src/kernel/write-policy.ts';
import { RUN_DIR_RE, runDirName } from '../../src/report/store.ts';
import type { RunResult } from '../../src/report/result.ts';
import { E2kError } from '../../src/shared/errors.ts';
import type { Op } from '../../src/shared/ops.ts';
import type { Mode } from '../../src/shared/protocol.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

const CONTINUE: PolicyVerdict = { decision: { action: 'continue' }, reason: null };

const HOME_PAGE: FakePageSpec = {
  snapshot: '- button "Add" [ref=e2]',
  elements: { e2: {}, '#status': { text: 'Added' }, '#gone': { failWith: 'not-found' } },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function setup(overrides: Partial<SessionDeps> & { launchDelayMs?: number; failOpenWith?: Error; extraPages?: Record<string, FakePageSpec> } = {}) {
  const { launchDelayMs, failOpenWith, extraPages, ...depsOverrides } = overrides;
  const fake = new FakeDriver({
    pages: { 'http://localhost:5173/': HOME_PAGE, 'http://localhost:5173/down': { gotoFailWith: 'timeout' },
      'http://localhost:5173/login-down': { gotoFailWith: 'other' }, ...extraPages },
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

test('open --touch asks the driver for a touch page and records start.touch; without it the page is plain and start.touch is false', async () => {
  const { sm, fake } = setup();
  const plain = await sm.open({ url: 'http://localhost:5173/', name: 'plain' });
  const touch = await sm.open({ url: 'http://localhost:5173/', name: 'touch', touch: true });
  const opens = fake.calls.filter((c) => c.method === 'openPage').map((c) => c.args[0]);
  assert.deepEqual(opens, [{}, { touch: true }]);
  await sm.close({ session: plain.session });
  await sm.close({ session: touch.session });
  assert.equal(readResult(plain.runDir).start.touch, false);
  assert.equal(readResult(touch.runDir).start.touch, true);
});

test('open --touch fails cleanly when the driver cannot emulate touch: no session, no page, no run dir', async () => {
  const { sm, fake, home } = setup({ failOpenWith: new DriverError('other', 'touch emulation is not available') });
  await assert.rejects(sm.open({ url: 'http://localhost:5173/', name: 'nt', touch: true }), (e: E2kError) => e.code === 'action-failed');
  assert.deepEqual(fake.openPages(), []); assert.deepEqual(sm.list(), []);
  assert.ok(!existsSync(join(home.runsDir, 'nt')) || readdirSync(join(home.runsDir, 'nt')).length === 0);
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

// [#gone 点击失败(1), 点击 e2 完成(2), assert 相符(3), assert 不符(4), 点击 #gone 失败(5)]，keepGoing
const SUP_OPS: Op[] = [
  { op: 'click', target: '#gone' }, { op: 'click', target: 'e2' },
  { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Added' },
  { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Nope' },
  { op: 'click', target: '#gone' },
];

test('close with superseded: the record gets both ops and targets from the kernel, and the verdict has no conflict', async () => {
  const { sm, fake } = setup(); const { session } = await opened(sm, fake);
  const st = await sm.step({ session, ops: [SUP_OPS[0]!, SUP_OPS[1]!, SUP_OPS[2]!], keepGoing: true });
  assert.deepEqual(st.results.map((x) => [x.seq, x.outcome]), [[1, 'failed'], [2, 'ok'], [3, 'match']]);
  const r = await sm.close({ session, verdict: { value: 'pass' }, superseded: [{ failed: 1, by: 2 }] });
  assert.equal(r.consistency, 'ok');
  const res = readResult(r.runDir);
  assert.deepEqual(res.superseded, [{ failed: 1, by: 2, failedOp: 'click', failedTarget: '#gone', byOp: 'click', byTarget: 'e2', byReadOnly: false }]);
  assert.deepEqual(res.conflicts, []);
  assert.equal(res.tallies.failed, 1); assert.equal(r.exit, 0);
  assert.ok(readFileSync(join(r.runDir, 'report.html'), 'utf8').includes('已恢复的失败'));
});

test('close with a bad superseded is usage, writes nothing, and the session stays open and can be closed again', async () => {
  const { sm, fake } = setup(); const { session, runDir } = await opened(sm, fake);
  const st = await sm.step({ session, ops: SUP_OPS, keepGoing: true });
  assert.deepEqual(st.results.map((x) => x.outcome), ['failed', 'ok', 'match', 'mismatch', 'failed']);
  const bad: { failed: number; by: number }[][] = [
    [{ failed: 2, by: 3 }],                 // failed 指向 ok
    [{ failed: 3, by: 4 }],                 // failed 指向 match
    [{ failed: 4, by: 5 }],                 // mismatch 不可被取代，by 也不是 ok
    [{ failed: 1, by: 4 }],                 // by 指向 mismatch
    [{ failed: 1, by: 5 }],                 // by 指向 failed
    [{ failed: 1, by: 99 }], [{ failed: 77, by: 99 }],   // 不存在的序号
    [{ failed: 1, by: 2 }, { failed: 1, by: 3 }],         // 同一个 failed 两次
  ];
  for (const superseded of bad) {
    await assert.rejects(sm.close({ session, verdict: { value: 'pass' }, superseded }), (e: E2kError) => e.code === 'usage', JSON.stringify(superseded));
    assert.equal(sm.list().length, 1); assert.equal(sm.list()[0]!.session, session);
    assert.ok(!existsSync(join(runDir, 'result.json')) && !existsSync(join(runDir, 'report.html')), 'no half-written report');
  }
  await assert.rejects(sm.close({ session, superseded: [{ failed: 2, by: 3 }] }), (e: E2kError) => !e.message.includes('#gone') && /superseded\[0\]/.test(e.message));
  const step = await sm.step({ session, ops: [{ op: 'snapshot' }] });          // 会话还能用
  assert.equal(step.results[0]!.outcome, 'ok');
  const r = await sm.close({ session, verdict: { value: 'pass' }, superseded: [{ failed: 1, by: 2 }, { failed: 5, by: 6 }] });
  assert.equal(r.consistency, 'conflict');                                       // mismatch 还在
  assert.deepEqual(readResult(r.runDir).conflicts, ['mismatch']);
  assert.deepEqual(r.conflicts, ['mismatch']);                                   // 回应里也带
});

test('idle sessions are closed with a report, but not while a step is running', async () => {
  const { sm, fake } = setup({ idleMs: 60 }); const { session, runDir } = await opened(sm, fake);
  await sm.step({ session, ops: [{ op: 'wait', for: { ms: 200 } }] });          // 比闲置超时长
  assert.equal(sm.list().length, 1);
  await until(() => existsSync(join(runDir, 'result.json')));
  assert.equal(readResult(runDir).closedBy, 'idle-timeout'); assert.equal(sm.list().length, 0);
});

test('a rule that makes the start host read-only: open succeeds in read-only mode and the policy sees it', async () => {
  const { sm, fake } = setup({ modes: { ...defaultOnlyResolver, resolve: () => 'readonly' } });
  const r = await sm.open({ url: 'http://localhost:5173/' });
  assert.equal(r.mode, 'readonly'); assert.deepEqual(fake.openPages().length, 1);
});

test('the policy is asked with the effective mode: a read-only page turns a default-host write into a block, a default page lets a write to a read-only host through', async () => {
  const asked: { url: string; mode: Mode }[] = [];
  const spy: WritePolicy = { decide: (r, ctx) => { asked.push({ url: r.url, mode: ctx.mode }); return CONTINUE; }, decideUnattributed: () => CONTINUE };
  const modes = { ...defaultOnlyResolver, resolve: (host: string): Mode => (host === 'example.com' ? 'readonly' : 'default') };
  const { sm, fake } = setup({ policy: spy, modes }); const { session, runDir, pageId } = await opened(sm, fake);
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.com/api' }), { action: 'continue' });
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'POST', url: 'http://localhost:5173/api', topUrl: 'http://example.com/' }), { action: 'continue' });
  assert.deepEqual(asked, [{ url: 'http://example.com/api', mode: 'default' }, { url: 'http://localhost:5173/api', mode: 'readonly' }]);
  await sm.close({ session });
  assert.deepEqual(readResult(runDir).writes.allowed.map((w) => [w.url, w.mode, w.targetMode]),
    [['http://example.com/api', 'default', 'readonly'], ['http://localhost:5173/api', 'readonly', 'default']]);
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

test('a write from a page with a password field (or an undetermined one) is recorded without its body', async () => {
  const { sm, fake } = setup(); const { session, runDir, pageId } = await opened(sm, fake);
  const secret = 'not-a-real-password-xyz';
  await fake.emitRequest({ id: 'r1', pageId, method: 'POST', url: 'http://localhost:5173/api/sso', body: `note=${secret}`, contentType: 'application/x-www-form-urlencoded', fromLoginForm: true });
  await fake.emitRequest({ id: 'r2', pageId, method: 'POST', url: 'http://localhost:5173/api/sso2', body: `note=${secret}`, contentType: 'application/x-www-form-urlencoded', fromLoginForm: null });
  await fake.emitRequest({ id: 'r3', pageId, method: 'POST', url: 'http://localhost:5173/api/ok', body: 'note=plain', contentType: 'application/x-www-form-urlencoded' });
  await sm.close({ session });
  const result = readResult(runDir);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(result.writes.allowed.map((w: any) => [w.body, w.bodyOmitted]), [[null, true], [null, true], ['note=plain', false]]);
  assert.ok(readFileSync(join(runDir, 'report.html'), 'utf8').includes('请求体未记录'));
});

test('an unattributed write from a password page is recorded without its body', async () => {
  const { sm, fake } = setup(); const { session, runDir } = await opened(sm, fake);
  const secret = 'not-a-real-password-xyz';
  await fake.emitRequest({ id: 'u1', pageId: null, method: 'POST', url: 'http://localhost:5173/api/form-blank', body: `note=${secret}`, contentType: 'application/x-www-form-urlencoded', fromLoginForm: true });
  await sm.close({ session });
  const result = readResult(runDir);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.writes.unattributed[0].bodyOmitted, true);
  assert.equal(result.writes.unattributed[0].body, null);
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
  const deny: WritePolicy = { decide: () => CONTINUE, decideUnattributed: () => ({ decision: { action: 'abort' }, reason: 'unattributed' }) };
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

test('keepGoing: a page that closes in the middle of a step turns the rest into not-run, not a pile of failures', async () => {
  const { sm, fake } = setup(); const { session, pageId } = await opened(sm, fake);
  const ops: Op[] = [{ op: 'wait', for: { ms: 100 } }, { op: 'click', target: 'e2' }, { op: 'snapshot' }];
  const step = sm.step({ session, ops, keepGoing: true });
  await sleep(30);
  fake.closePage(pageId);
  const r = await step;
  assert.deepEqual(r.results.map((x) => x.outcome), ['ok', 'not-run', 'not-run']);
  assert.equal(r.tallies.failed, 0); assert.equal(r.tallies.notRun, 2);
});

test('keepGoing: the browser going away in the middle of a step also turns the rest into not-run', async () => {
  const { sm, fake } = setup(); const { session } = await opened(sm, fake);
  const ops: Op[] = [{ op: 'wait', for: { ms: 100 } }, { op: 'click', target: 'e2' }, { op: 'snapshot' }];
  const step = sm.step({ session, ops, keepGoing: true });
  await sleep(30);
  fake.closeBrowser();
  const r = await step;
  assert.deepEqual(r.results.map((x) => x.outcome), ['ok', 'not-run', 'not-run']);
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
  const seen: { mode: string }[] = [];
  const spy: WritePolicy = { decide: (_r, ctx) => { seen.push(ctx); return CONTINUE; }, decideUnattributed: () => CONTINUE };
  const { sm, fake } = setup({ policy: spy }); const { session, runDir, pageId } = await opened(sm, fake);
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://127.0.0.1:5173/x', topUrl: null });
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://localhost:5173/y', topUrl: 'http://example.com/' });
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.org/', isNavigation: true, topFrame: true, topUrl: 'http://example.org/' });
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.net/frame', isNavigation: true, topFrame: false });
  assert.deepEqual(seen.map((c) => c.mode), ['default', 'default', 'default', 'default']);
  await sm.close({ session });
  assert.deepEqual(readResult(runDir).hosts.map((h) => h.host), ['localhost', 'example.org']);
});

test('a request whose mode cannot be decided is aborted (fail closed)', async () => {
  let armed = false;
  const { sm, fake, logs } = setup({ modes: { ...defaultOnlyResolver, resolve: () => { if (armed) throw new Error('rule error'); return 'default'; } } });
  const { pageId } = await opened(sm, fake);
  armed = true;
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'GET', url: 'http://localhost:5173/x' }), { action: 'abort' });
  assert.ok(logs.some((l) => l.includes('rule error')));
});

test('loginEnd records the time and host of the login next to the profile directory', async () => {
  const at = new Date('2026-11-26T08:09:10.000Z');
  const { sm, home } = setup({ now: () => at });
  assert.deepEqual(profileInfo(home, DEFAULT_PROFILE).lastLogin, null);
  const { loginId } = await sm.loginBegin({ url: 'http://localhost:5173/login.html?next=%2Fa#frag' });
  assert.deepEqual(profileInfo(home, DEFAULT_PROFILE).lastLogin, null);          // 还没按回车：不记
  await sm.loginEnd({ loginId });
  const file = join(home.profilesDir, 'default.login.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schema: 1, at: at.toISOString(), host: 'localhost' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(home.profilesDir, 'default')), []);          // 不在 user data 目录里
});

test('a login whose navigation failed is not recorded', async () => {
  const { sm, home } = setup();
  await assert.rejects(sm.loginBegin({ url: 'http://localhost:5173/login-down' }));
  assert.equal(profileInfo(home, DEFAULT_PROFILE).lastLogin, null);
  assert.ok(!existsSync(join(home.profilesDir, 'default.login.json')));
});

test('a login record that cannot be written is logged, and loginEnd still finishes', async () => {
  const { sm, fake, home, logs } = setup();
  const { loginId } = await sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  const loginPageId = fake.openPages().at(-1)!;
  const outside = join(home.root, 'outside.txt'); writeFileSync(outside, 'keep');
  symlinkSync(outside, join(home.profilesDir, 'default.login.json'));
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 0 });
  assert.ok(!fake.openPages().includes(loginPageId));
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
  assert.ok(logs.some((l) => l.includes('登录记录')), logs.join('\n'));
  await assert.rejects(sm.loginEnd({ loginId }), (e: E2kError) => e.code === 'not-found');
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
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 0 });
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

const WALL = 'http://localhost:5173/wall';
const WALL_PAGES: Record<string, FakePageSpec> = {
  [WALL]: { snapshot: '- textbox "Password"', passwordField: true },
  'http://localhost:5173/wall-err': { passwordField: true, passwordFieldFailWith: 'other' },
};

test('open reports a login wall when the top page has a visible password field, and the session stays usable', async () => {
  const { sm } = setup({ extraPages: WALL_PAGES });
  const plain = await sm.open({ url: 'http://localhost:5173/' });
  assert.equal(plain.blocked, null); assert.equal(plain.next, null);
  const wall = await sm.open({ url: WALL });
  assert.equal(wall.blocked, 'login');
  assert.equal(wall.next, `页面停在登录页（有可见的密码框）：请人运行 login ${WALL} 登录后重试；若这是预期页面（如修改密码页）可忽略。会话仍开着，用完请 close`);
  // 会话没被暂停也没被关掉：照常能 step、能 close
  const r = await sm.step({ session: wall.session, ops: [{ op: 'snapshot' }] });
  assert.equal(r.tallies.failed, 0);
  await sm.close({ session: wall.session });
});

test('the redacted start url is what the login-wall hint shows', async () => {
  const token = ['tk', crypto.randomBytes(12).toString('hex')].join('_');
  const url = `${WALL}?token=${token}`;
  const { sm } = setup({ extraPages: { [url]: { passwordField: true } } });
  const wall = await sm.open({ url });
  assert.equal(wall.blocked, 'login');
  assert.ok(wall.next!.includes('[REDACTED]')); assert.ok(!wall.next!.includes(token)); assert.ok(!wall.url.includes(token));
  const r = await sm.step({ session: wall.session, ops: [{ op: 'snapshot' }] });
  assert.equal(r.blocked, 'login'); assert.ok(r.next!.includes('[REDACTED]')); assert.ok(!r.next!.includes(token));
});

test('step reports exit 20 on a login wall; 20 beats 11 and 10; tallies stay as they were', async () => {
  const { sm } = setup({ extraPages: WALL_PAGES });
  const wall = await sm.open({ url: WALL });
  const ok = await sm.step({ session: wall.session, ops: [{ op: 'snapshot' }] });
  assert.deepEqual([ok.exit, ok.blocked], [20, 'login']);
  assert.deepEqual(ok.tallies, { ok: 1, match: 0, mismatch: 0, failed: 0, notRun: 0 });
  const failing = await sm.step({ session: wall.session, ops: [{ op: 'click', target: '#nope' }, { op: 'snapshot' }] });
  assert.equal(failing.exit, 20); assert.equal(failing.tallies.failed, 1); assert.equal(failing.tallies.notRun, 1);
  const { sm: sm2 } = setup();
  const s = await sm2.open({ url: 'http://localhost:5173/' });
  const clean = await sm2.step({ session: s.session, ops: [{ op: 'snapshot' }] });
  assert.deepEqual([clean.exit, clean.blocked, clean.next], [0, null, null]);
});

test('a step that navigates onto a login wall reports it, and one that leaves it stops reporting', async () => {
  const { sm } = setup({ extraPages: WALL_PAGES });
  const s = await sm.open({ url: 'http://localhost:5173/' });
  assert.equal((await sm.step({ session: s.session, ops: [{ op: 'goto', url: WALL }] })).exit, 20);
  const back = await sm.step({ session: s.session, ops: [{ op: 'goto', url: 'http://localhost:5173/' }] });
  assert.deepEqual([back.exit, back.blocked], [0, null]);
});

test('when the probe itself fails, no login wall is claimed (a hint only)', async () => {
  const { sm } = setup({ extraPages: WALL_PAGES });
  const o = await sm.open({ url: 'http://localhost:5173/wall-err' });
  assert.deepEqual([o.blocked, o.next], [null, null]);
  const r = await sm.step({ session: o.session, ops: [{ op: 'snapshot' }] });
  assert.deepEqual([r.exit, r.blocked, r.next], [0, null, null]);
});

test('close writes blocked: login when the last wall check found one, and null when the session left the wall', async () => {
  const { sm } = setup({ extraPages: WALL_PAGES });
  const s = await sm.open({ url: 'http://localhost:5173/' });
  await sm.step({ session: s.session, ops: [{ op: 'goto', url: WALL }] });
  assert.equal(readResult((await sm.close({ session: s.session })).runDir).blocked, 'login');
  const s2 = await sm.open({ url: WALL });
  await sm.step({ session: s2.session, ops: [{ op: 'goto', url: 'http://localhost:5173/' }] });
  assert.equal(readResult((await sm.close({ session: s2.session })).runDir).blocked, null);
  const s3 = await sm.open({ url: WALL });                     // 只 open、没 step：open 时的检查结果也算
  assert.equal(readResult((await sm.close({ session: s3.session })).runDir).blocked, 'login');
});

// ---- 只读模式（任务 12） ----

const RO = 'http://example.com/';
const GRAPHQL_QUERY = { method: 'POST', url: 'http://example.com/graphql', contentType: 'application/json', body: '{"query":"{ viewer { id } }"}' };

// 可以在测试里改的规则解析器：ro 里的主机只读；pending 在下一次 refresh 时生效（模拟人改了规则文件）。
// readonlyHosts 里 `*.x` 形式的按后缀匹配；loginHosts 精确匹配。
function mutableRules(readonlyHosts: string[], loginHosts: string[] = []) {
  const isRo = (h: string): boolean => st.ro.has(h) || [...st.ro].some((p) => p.startsWith('*.') && h.endsWith(p.slice(1)));
  const st = { ro: new Set(readonlyHosts), hash: 'sha256:0000000000000001' as string | null, error: null as string | null, pending: null as (() => void) | null, refreshes: 0 };
  const resolver: ModeResolver = {
    resolve: (h) => (isRo(h) ? 'readonly' : 'default'),
    ruleFor: (h) => (isRo(h) ? 'readonly' : null),
    groupOf: defaultOnlyResolver.groupOf,
    group: defaultOnlyResolver.group,
    isLoginHost: (h) => loginHosts.includes(h),
    refresh: () => { st.refreshes++; const p = st.pending; st.pending = null; p?.(); },
    state: () => ({ count: st.ro.size, hash: st.hash, error: st.error }),
  };
  return { st, resolver };
}

function setupRo(readonlyHosts: string[] = ['example.com'], overrides: Partial<SessionDeps> = {}, loginHosts: string[] = []) {
  const rules = mutableRules(readonlyHosts, loginHosts);
  return { ...setup({ modes: rules.resolver, policy, ...overrides }), ...rules };
}

// 会话内部状态，只给测试看：主页面的顶层主机和记录里的模式时间线。
function inner(sm: SessionManager, id: string): { topHost: string; pendingHosts: Set<string>; recorder: { modes: { mode: string; reason: string; rulesHash: string | null; host: string }[] } } {
  return (sm as unknown as { sessions: Map<string, never> }).sessions.get(id) as never;
}

test('read-only by rule: writes from the session page get a 403, a strict GraphQL query goes through without following redirects', async () => {
  const { sm, fake } = setupRo(); const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  assert.equal(r.mode, 'readonly');
  const post = await fake.emitRequest({ id: 'w1', pageId, method: 'POST', url: 'http://example.com/api/items', body: '{"a":1}', contentType: 'application/json' });
  assert.equal(post.action, 'fulfill'); assert.equal((post as { status: number }).status, 403);
  assert.deepEqual(await fake.emitRequest({ id: 'q1', pageId, ...GRAPHQL_QUERY }), { action: 'continue', followRedirects: false });
  assert.deepEqual(fake.noRedirectIds, ['q1']);
  await sm.close({ session: r.session });
  const blocked = readResult(r.runDir).writes.blocked;
  assert.deepEqual(blocked.map((w) => [w.id, w.decision, w.reason, w.mode]), [['w1', 'blocked', 'method', 'readonly']]);
});

test('open --readonly forces read-only on a host without rules, also after navigating to another default host', async () => {
  const { sm, fake } = setupRo(); const r = await sm.open({ url: 'http://localhost:5173/', readonly: true }); const pageId = fake.openPages().at(-1)!;
  assert.equal(r.mode, 'readonly');
  assert.equal((await fake.emitRequest({ pageId, method: 'POST', url: 'http://localhost:5173/api' })).action, 'fulfill');
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.org/', isNavigation: true, topFrame: true, topUrl: 'http://example.org/' }), { action: 'continue' });
  assert.equal((await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.org/api', topUrl: 'http://example.org/' })).action, 'fulfill');
  assert.equal(inner(sm, r.session).topHost, 'example.org');
  const modes = inner(sm, r.session).recorder.modes;
  assert.equal(modes.length, 1); assert.equal(modes[0]!.reason, 'forced'); assert.equal(modes[0]!.mode, 'readonly');
  assert.equal(modes[0]!.rulesHash, 'sha256:0000000000000001');
  const plain = await sm.open({ url: 'http://localhost:5173/' });
  assert.equal(plain.mode, 'default'); assert.equal(inner(sm, plain.session).recorder.modes[0]!.reason, 'no-rule');
  const ruled = await sm.open({ url: RO });
  assert.equal(inner(sm, ruled.session).recorder.modes[0]!.reason, 'rule');
});

test('close writes the mode timeline, the rules in force, start.readonly and the blocked summary (unattributed included)', async () => {
  const { sm, fake, st } = setupRo(['example.com']);
  const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  await fake.emitRequest({ id: 'w1', pageId, method: 'POST', url: 'http://example.com/api/items', body: '{"a":1}', contentType: 'application/json' });
  await fake.emitRequest({ id: 'u1', pageId: null, method: 'POST', url: 'http://localhost:5173/api' });
  st.hash = 'sha256:0000000000000002';
  const res = readResult((await sm.close({ session: r.session })).runDir);
  assert.deepEqual(res.modes.map((m) => [m.host, m.mode, m.reason, m.rulesHash]), [['example.com', 'readonly', 'rule', 'sha256:0000000000000001']]);
  assert.deepEqual(res.rules, { hash: 'sha256:0000000000000002', count: 1 });   // 收尾时生效的那份
  assert.equal(res.start.readonly, false);
  assert.deepEqual(res.writes.blockedSummary, [
    { host: 'example.com', method: 'POST', reason: 'method', count: 1, unattributed: false },
    { host: 'localhost', method: 'POST', reason: 'unattributed', count: 1, unattributed: true },
  ]);
  const forced = await sm.open({ url: 'http://localhost:5173/', readonly: true });
  const res2 = readResult((await sm.close({ session: forced.session })).runDir);
  assert.equal(res2.start.readonly, true);
  assert.deepEqual(res2.modes.map((m) => m.reason), ['forced']);
});

test('a popup of a read-only session is read-only even when its own top host is a default host', async () => {
  const { sm, fake } = setupRo(); const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  const popup = fake.emitPopup(pageId, 'http://localhost:5173/popup');
  const post = await fake.emitRequest({ pageId: popup.id, method: 'POST', url: 'http://localhost:5173/api' });
  assert.equal(post.action, 'fulfill');
  assert.equal(readResult((await sm.close({ session: r.session })).runDir).writes.blocked[0]!.mode, 'readonly');
});

test('a cross-host native form POST from a read-only page is blocked, and the session stays on the old host', async () => {
  const { sm, fake } = setupRo(); const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  const post = await fake.emitRequest({ pageId, method: 'POST', url: 'http://localhost:5173/submit', isNavigation: true, topFrame: true, topUrl: 'http://localhost:5173/submit',
    body: 'a=1', contentType: 'application/x-www-form-urlencoded' });
  assert.equal(post.action, 'fulfill'); assert.match((post as { contentType: string }).contentType, /html/);
  assert.equal(inner(sm, r.session).topHost, 'example.com');
});

test('a default page may write to a read-only host: allowed, only recorded as targetMode read-only', async () => {
  const { sm, fake } = setupRo(); const { session, runDir, pageId } = await opened(sm, fake);
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.com/api' }), { action: 'continue' });
  await sm.close({ session });
  const w = readResult(runDir).writes.allowed[0]!;
  assert.deepEqual([w.mode, w.targetMode, w.decision, w.reason], ['default', 'readonly', 'allowed', null]);
});

test('a read-only page writing to a default host is blocked', async () => {
  const { sm, fake } = setupRo(); const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  assert.equal((await fake.emitRequest({ pageId, method: 'POST', url: 'http://localhost:5173/api' })).action, 'fulfill');
  const w = readResult((await sm.close({ session: r.session })).runDir).writes.blocked[0]!;
  assert.deepEqual([w.mode, w.targetMode], ['readonly', 'default']);
});

test('a redirect that lands the main page on a read-only host moves the session to read-only, for unattributed requests too', async () => {
  const { sm, fake } = setupRo(); const { session, pageId } = await opened(sm, fake);
  assert.equal((await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.org/', isNavigation: true, topFrame: true, topUrl: 'http://example.org/' })).action, 'continue');
  assert.equal((await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.org/api', topUrl: 'http://example.org/' })).action, 'continue');
  assert.equal(inner(sm, session).topHost, 'example.org');
  assert.equal((await fake.emitRequest({ pageId: null, method: 'POST', url: 'http://localhost:5173/api' })).action, 'continue');
  // 子资源请求带着新的顶层地址（重定向落到了只读主机）：判定之后主机跟过去，时间线多一条。
  assert.equal((await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.com/app.js', topUrl: RO })).action, 'continue');
  assert.equal(inner(sm, session).topHost, 'example.com');
  assert.deepEqual(inner(sm, session).recorder.modes.map((m) => m.mode), ['default', 'readonly']);
  assert.equal((await fake.emitRequest({ pageId: null, method: 'POST', url: 'http://localhost:5173/api' })).action, 'fulfill');
  assert.equal((await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.org/api', topUrl: RO })).action, 'fulfill');
});

test('a step reports the writes blocked while it ran (and only those), and the exit code is unchanged', async () => {
  const { sm, fake } = setupRo(); const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  const step = sm.step({ session: r.session, ops: [{ op: 'wait', for: { ms: 150 } }] });
  await sleep(40);
  await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.com/a' });
  await fake.emitRequest({ pageId, method: 'DELETE', url: 'http://example.com/b' });
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.com/c' });
  const res = await step;
  assert.equal(res.writesBlocked, 2); assert.equal(res.exit, 0);
  assert.deepEqual(res.notices, ['本批被拦 2 条写（只读模式），详见报告']);
  const next = await sm.step({ session: r.session, ops: [{ op: 'snapshot' }] });
  assert.deepEqual([next.writesBlocked, next.notices], [0, []]);
  // 一条已放行的严格查询事后被发现重定向被拒：落进下一批。
  await fake.emitRequest({ id: 'q9', pageId, ...GRAPHQL_QUERY });
  const during = sm.step({ session: r.session, ops: [{ op: 'wait', for: { ms: 100 } }] });
  await sleep(30); fake.emitRequestDone('q9', 307, { redirectRefused: true });
  assert.equal((await during).writesBlocked, 1);
});

test('a rules file with an error: open is refused (usage) and no page opens; an open session keeps going and its step carries a notice', async () => {
  const { sm, fake, st } = setupRo();
  const r = await sm.open({ url: 'http://localhost:5173/' });
  st.error = 'rules.json: bad json';
  await assert.rejects(sm.open({ url: 'http://localhost:5173/' }), (e: E2kError) => e.code === 'usage' && e.message.includes('规则文件有错') && e.next === 'e2k rule list 看错误');
  assert.equal(fake.openPages().length, 1);
  const step = await sm.step({ session: r.session, ops: [{ op: 'snapshot' }] });
  assert.equal(step.exit, 0); assert.deepEqual(step.notices, ['规则文件有错：已开的会话按旧规则继续，新的 open 会被拒绝']);
});

test('unattributed writes are blocked while a read-only session is alive, and let through after it ended', async () => {
  const { sm, fake } = setupRo(); const r = await sm.open({ url: RO });
  const blocked = await fake.emitRequest({ id: 'u1', pageId: null, method: 'POST', url: 'http://localhost:5173/api' });
  assert.equal(blocked.action, 'fulfill');
  assert.equal((await fake.emitRequest({ pageId: null, method: 'GET', url: 'http://localhost:5173/' })).action, 'continue');
  const closed = await sm.close({ session: r.session });
  const u = readResult(closed.runDir).writes.unattributed[0]!;
  assert.deepEqual([u.id, u.decision, u.reason, u.mode], ['u1', 'blocked', 'unattributed', 'readonly']);
  assert.deepEqual(await fake.emitRequest({ pageId: null, method: 'POST', url: 'http://localhost:5173/api' }), { action: 'continue' });
});

test('a refused redirect turns the allowed write into a blocked redirected-write, for session and unattributed requests', async () => {
  const noRedirect: WritePolicy = { decide: policy.decide, decideUnattributed: () => ({ decision: { action: 'continue', followRedirects: false }, reason: null }) };
  const { sm, fake } = setupRo(['example.com'], { policy: noRedirect });
  const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  await fake.emitRequest({ id: 'q1', pageId, ...GRAPHQL_QUERY });
  await fake.emitRequest({ id: 'u1', pageId: null, method: 'POST', url: 'http://localhost:5173/api' });
  fake.emitRequestDone('q1', 307, { redirectRefused: true });
  fake.emitRequestDone('u1', 302, { redirectRefused: true });
  const result = readResult((await sm.close({ session: r.session })).runDir);
  assert.deepEqual(result.writes.blocked.map((w) => [w.id, w.decision, w.reason, w.status, w.failed]), [['q1', 'blocked', 'redirected-write', 307, true]]);
  assert.deepEqual(result.writes.unattributed.map((w) => [w.id, w.decision, w.reason, w.status, w.failed]), [['u1', 'blocked', 'redirected-write', 302, true]]);
});

test('a driver that cannot intercept requests refuses to open read-only (by rule or by --readonly), and opens nothing', async () => {
  const fake = new FakeDriver({ capabilities: { networkInterception: false }, pages: { 'http://localhost:5173/': HOME_PAGE } });
  const rules = mutableRules(['example.com']); const tmp = makeTmpHome();
  const sm = new SessionManager({ driver: fake, home: tmp.home, modes: rules.resolver, policy, idleMs: 60_000, keepRuns: 20, now: () => new Date(), kernelVersion: '0.1.0', log: () => {} });
  cleanups.push(async () => { await sm.shutdown(); tmp.cleanup(); });
  await assert.rejects(sm.open({ url: RO }), (e: E2kError) => e.code === 'internal' && e.message.includes('不能拦网络请求'));
  await assert.rejects(sm.open({ url: 'http://localhost:5173/', readonly: true }), (e: E2kError) => e.code === 'internal');
  assert.deepEqual(fake.openPages(), []); assert.equal(fake.launches, 0);
  assert.equal((await sm.open({ url: 'http://localhost:5173/' })).mode, 'default');
});

test('rules changed to default: the next main-page top-level navigation picks them up, writes are let through and the timeline gets an entry with the new hash', async () => {
  const { sm, fake, st } = setupRo(); const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  assert.equal((await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.com/api' })).action, 'fulfill');
  st.pending = () => { st.ro.clear(); st.hash = 'sha256:0000000000000002'; };
  const before = st.refreshes;
  assert.equal((await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.org/', isNavigation: true, topFrame: true, topUrl: 'http://example.org/' })).action, 'continue');
  assert.equal(st.refreshes, before + 1);
  assert.equal((await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.org/api', topUrl: 'http://example.org/' })).action, 'continue');
  assert.deepEqual(inner(sm, r.session).recorder.modes.map((m) => [m.mode, m.host, m.rulesHash]),
    [['readonly', 'example.com', 'sha256:0000000000000001'], ['default', 'example.com', 'sha256:0000000000000002']]);   // 规则变的时候页面还在 example.com（发起页地址为证）：变更记在它名下，之后落到 example.org 模式没变就不再记
});

test('an allowed navigation that never commits does not move the session off its read-only host: a later cross-host form POST is still blocked', async () => {
  const { sm, fake } = setupRo(); const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  const nav = { pageId, method: 'GET', url: 'http://example.org/file.zip', isNavigation: true, topFrame: true, topUrl: 'http://example.org/file.zip' };
  assert.equal((await fake.emitRequest(nav)).action, 'continue');          // 下载或 204：页面其实还在只读主机上
  assert.deepEqual([inner(sm, r.session).topHost, [...inner(sm, r.session).pendingHosts]], ['example.com', ['example.org']]);
  const form = await fake.emitRequest({ pageId, method: 'POST', url: 'http://localhost:5173/submit', isNavigation: true, topFrame: true, topUrl: 'http://localhost:5173/submit' });
  assert.equal(form.action, 'fulfill');
  assert.equal(inner(sm, r.session).recorder.modes.length, 1);
});

test('commit evidence from a main-page request converges the session onto the committed host and clears the pending ones', async () => {
  const { sm, fake } = setupRo(); const r = await sm.open({ url: RO }); const pageId = fake.openPages().at(-1)!;
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.org/', isNavigation: true, topFrame: true, topUrl: 'http://example.org/' });
  assert.equal((await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.org/app.js', topUrl: 'http://example.org/' })).action, 'continue');
  const s = inner(sm, r.session);
  assert.deepEqual([s.topHost, s.pendingHosts.size], ['example.org', 0]);
  assert.deepEqual(s.recorder.modes.map((m) => [m.mode, m.host]), [['readonly', 'example.com'], ['default', 'example.org']]);
  assert.equal((await fake.emitRequest({ pageId, method: 'POST', url: 'http://localhost:5173/api', topUrl: 'http://example.org/' })).action, 'continue');
});

test('reading the page address after a step converges the session; a non-http(s) address changes nothing', async () => {
  const { sm, fake } = setupRo(['example.com']); const r = await sm.open({ url: 'http://localhost:5173/' }); const pageId = fake.openPages().at(-1)!;
  await fake.emitRequest({ pageId, method: 'GET', url: RO, isNavigation: true, topFrame: true, topUrl: RO });
  assert.deepEqual([inner(sm, r.session).topHost, [...inner(sm, r.session).pendingHosts]], ['localhost', ['example.com']]);
  await sm.step({ session: r.session, ops: [{ op: 'goto', url: RO }] });   // 假驱动的页面地址变成只读主机
  assert.deepEqual([inner(sm, r.session).topHost, inner(sm, r.session).pendingHosts.size], ['example.com', 0]);
  await fake.emitRequest({ pageId, method: 'GET', url: 'http://example.org/', isNavigation: true, topFrame: true, topUrl: 'http://example.org/' });
  await sm.step({ session: r.session, ops: [{ op: 'goto', url: 'about:blank' }] });
  assert.deepEqual([inner(sm, r.session).topHost, [...inner(sm, r.session).pendingHosts]], ['example.com', ['example.org']]);
  assert.equal(inner(sm, r.session).recorder.modes.length, 2);
});

test('open reports the effective mode after the first screen: a start URL that lands on a read-only host is read-only', async () => {
  const { sm } = setupRo(['example.com']);
  const plain = await sm.open({ url: 'http://localhost:5173/' });
  assert.equal(plain.mode, 'default');
  const rules = mutableRules(['example.com']);
  const { sm: sm2 } = setup({ modes: rules.resolver, policy, extraPages: { 'http://localhost:5173/landing': { redirectTo: RO } } });
  const landed = await sm2.open({ url: 'http://localhost:5173/landing' });
  assert.equal(landed.mode, 'readonly');
  assert.equal(inner(sm2, landed.session).topHost, 'example.com');
});

test('an unattributed page on a read-only host is read-only even with no read-only session alive', async () => {
  const { sm, fake } = setupRo(); await opened(sm, fake);
  assert.equal((await fake.emitRequest({ id: 'u7', pageId: null, method: 'POST', url: 'http://localhost:5173/api', topUrl: RO })).action, 'fulfill');
  assert.equal((await fake.emitRequest({ pageId: null, method: 'POST', url: 'http://example.com/api', topUrl: null })).action, 'fulfill');
  assert.equal((await fake.emitRequest({ pageId: null, method: 'GET', url: 'http://localhost:5173/', topUrl: RO })).action, 'continue');
  assert.equal((await fake.emitRequest({ pageId: null, method: 'POST', url: 'http://example.com/api', topUrl: 'http://example.org/' })).action, 'continue');   // 页面在默认主机上
});

// ---- 登录窗口过写策略（loginHosts 之外） ----
// 请求形状照真驱动：顶层导航 isNavigation + topFrame，topUrl 是导航目标；其余请求的 topUrl 是所在页的地址。

const LOGIN_START = 'http://app.example.com/login';
const SSO_URL = 'http://sso.example.com/';
const APP_URL = 'http://app.example.com/';

async function loginSetup(readonlyHosts: string[] = ['*.example.com'], start: string = LOGIN_START, overrides: Partial<SessionDeps> = {}) {
  const ctx = setupRo(readonlyHosts, overrides, ['sso.example.com']);
  const { loginId } = await ctx.sm.loginBegin({ url: start });
  return { ...ctx, loginId, loginPageId: ctx.fake.openPages().at(-1)! };
}

type LoginCtx = Awaited<ReturnType<typeof loginSetup>>;

// 顶层导航（GET 或表单 POST）：topUrl 是导航目标，initiatorUrl 是发起页此刻已提交的地址。
function nav(c: Pick<LoginCtx, 'fake'>, pageId: string, method: string, url: string, initiatorUrl: string | null) {
  return c.fake.emitRequest({ id: `n${++navSeq}`, pageId, method, url, topUrl: url, initiatorUrl, isNavigation: true, topFrame: true,
    ...(method === 'POST' ? { contentType: 'application/x-www-form-urlencoded', body: 'SAMLResponse=x' } : {}) });
}
let navSeq = 0;

// 页面提交的证据：这个页自己发的子资源请求，topUrl 是页面地址。
async function commit(c: LoginCtx, pageId: string, topUrl: string): Promise<void> {
  assert.equal((await c.fake.emitRequest({ id: `e${++navSeq}`, pageId, method: 'GET', url: `${topUrl}app.js`, topUrl })).action, 'continue');
}

test('login: a form POST navigation from a login-host page (SAML/OIDC callback) goes through; a fetch from it to another host is judged by the rules', async () => {
  const c = await loginSetup(); const { sm, fake, loginId, loginPageId } = c;
  assert.deepEqual(await nav(c, loginPageId, 'GET', SSO_URL, LOGIN_START), { action: 'continue' });            // 去身份提供方：目标是 loginHost
  await commit(c, loginPageId, SSO_URL);
  const fetchPost = await fake.emitRequest({ id: 'b0', pageId: loginPageId, method: 'POST', url: 'http://app.example.com/api', topUrl: SSO_URL, contentType: 'application/json', body: '{}' });
  assert.equal(fetchPost.action, 'fulfill');                                                        // 登录主机页上的脚本写别的主机：不免拦
  assert.deepEqual(await nav(c, loginPageId, 'POST', 'http://app.example.com/acs', SSO_URL), { action: 'continue' });   // 回调：发起页在 loginHost，免拦且不加 followRedirects
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 1 });
});

test('login: a write to a login host goes through; other writes from a page on a read-only host are blocked, popups included; reads pass', async () => {
  const { sm, fake, loginId, loginPageId } = await loginSetup();
  assert.deepEqual(await fake.emitRequest({ id: 'a3', pageId: loginPageId, method: 'POST', url: 'http://sso.example.com/auth', topUrl: APP_URL }), { action: 'continue' });
  const blocked = await fake.emitRequest({ id: 'b1', pageId: loginPageId, method: 'POST', url: 'http://app.example.com/api/secret-path', topUrl: APP_URL, body: 'note=body-text', contentType: 'application/x-www-form-urlencoded' });
  assert.equal(blocked.action, 'fulfill'); assert.equal((blocked as { status: number }).status, 403);
  assert.equal((await fake.emitRequest({ id: 'b2', pageId: 'p-popup', openerPageId: loginPageId, method: 'DELETE', url: 'http://app.example.com/x', topUrl: APP_URL })).action, 'fulfill');
  assert.equal((await fake.emitRequest({ id: 'r1', pageId: loginPageId, method: 'GET', url: 'http://app.example.com/', topUrl: APP_URL })).action, 'continue');
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 2 });
});

test('login: a popup opened by a login-host page can form-POST the callback; one opened by a read-only page cannot', async () => {
  const c = await loginSetup(); const { sm, fake, loginId, loginPageId } = c;
  await nav(c, loginPageId, 'GET', SSO_URL, LOGIN_START); await commit(c, loginPageId, SSO_URL);
  const popup = fake.emitPopup(loginPageId, SSO_URL);
  assert.deepEqual(await nav(c, popup.id, 'POST', 'http://app.example.com/acs', SSO_URL), { action: 'continue' });
  // 另一条登录：弹窗的开启者停在只读的 app 上，表单 POST 被拦
  const other = await sm.loginBegin({ url: LOGIN_START }); const otherPage = fake.openPages().at(-1)!;
  const popup2 = fake.emitPopup(otherPage, APP_URL);
  assert.equal((await nav(c, popup2.id, 'POST', 'http://app.example.com/acs', APP_URL)).action, 'fulfill');
  await sm.loginEnd(other); await sm.loginEnd({ loginId });
});

test('login: starting on a default host, going to a read-only host and committing there, a form POST to a default host is blocked', async () => {
  const D = 'http://localhost:5173/login'; const R = 'http://app.example.com/';
  const c = await loginSetup(['app.example.com'], D); const { sm, fake, loginId, loginPageId } = c;
  assert.equal((await nav(c, loginPageId, 'GET', R, D)).action, 'continue');
  await commit(c, loginPageId, R);                                                                  // 提交了 R
  assert.equal((await nav(c, loginPageId, 'POST', 'http://example.org/post', R)).action, 'fulfill');
  assert.equal((await fake.emitRequest({ id: 'b9', pageId: loginPageId, method: 'POST', url: 'http://example.org/api', topUrl: R })).action, 'fulfill');
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 2 });
});

test('login: a blocked write is logged as one line without the path or the body, and an odd method is logged as OTHER', async () => {
  const { sm, fake, logs, loginId, loginPageId } = await loginSetup();
  await fake.emitRequest({ id: 'b1', pageId: loginPageId, method: 'POST', url: 'http://app.example.com/api/secret-path?x=1', topUrl: APP_URL, body: 'note=body-text', contentType: 'application/x-www-form-urlencoded' });
  await fake.emitRequest({ id: 'b2', pageId: loginPageId, method: 'tok-Zq7x91LkAb1', url: 'http://app.example.com/api', topUrl: APP_URL });
  assert.deepEqual(logs.filter((l) => l.includes(loginId)), [`登录 ${loginId}：拦下 POST app.example.com`, `登录 ${loginId}：拦下 OTHER app.example.com`]);
  assert.ok(!logs.join('\n').includes('secret-path') && !logs.join('\n').includes('body-text') && !logs.join('\n').includes('Zq7x91'));
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 2 });
});

test('login: login requests never enter any session record, even when a session is open while they are sent', async () => {
  const { sm, fake } = setupRo(['app.example.com'], {}, ['sso.example.com']);
  const s = await opened(sm, fake, 'other');                                                       // 先开会话，再发登录请求
  const { loginId } = await sm.loginBegin({ url: LOGIN_START }); const loginPageId = fake.openPages().at(-1)!;
  assert.equal((await fake.emitRequest({ id: 'b1', pageId: loginPageId, method: 'POST', url: 'http://localhost:5173/api', topUrl: APP_URL })).action, 'fulfill');
  assert.equal((await fake.emitRequest({ id: 'a1', pageId: loginPageId, method: 'POST', url: 'http://sso.example.com/auth', topUrl: APP_URL })).action, 'continue');
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 1 });
  const w = readResult((await sm.close({ session: s.session })).runDir).writes;
  assert.deepEqual([w.allowed.length, w.blocked.length, w.unattributed.length], [0, 0, 0]);
});

test('login: with no rules the login page can write anywhere (regression)', async () => {
  const { sm, fake, loginId, loginPageId } = await loginSetup([]);
  assert.deepEqual(await fake.emitRequest({ id: 'a1', pageId: loginPageId, method: 'POST', url: 'http://app.example.com/api', topUrl: APP_URL }), { action: 'continue' });
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 0 });
});

test('login: a rules file with an error refuses loginBegin and opens no page', async () => {
  const { sm, fake, st } = setupRo();
  st.error = 'rules.json: bad json';
  await assert.rejects(sm.loginBegin({ url: LOGIN_START }), (e: E2kError) => e.code === 'usage' && e.message.includes('规则文件有错') && e.next === 'e2k rule list 看错误');
  assert.equal(fake.openPages().length, 0);
});

test('login: loginBegin refreshes the rules first', async () => {
  const { sm, st } = setupRo();
  const before = st.refreshes;
  const { loginId } = await sm.loginBegin({ url: LOGIN_START });
  assert.ok(st.refreshes > before);
  await sm.loginEnd({ loginId });
});

test('login: a strict query let through without following redirects counts as blocked when the redirect is refused', async () => {
  const { sm, fake, logs, loginId, loginPageId } = await loginSetup(['*.example.com']);
  assert.deepEqual(await fake.emitRequest({ id: 'q1', pageId: loginPageId, ...GRAPHQL_QUERY, url: 'http://app.example.com/graphql', topUrl: APP_URL }), { action: 'continue', followRedirects: false });
  assert.deepEqual(await fake.emitRequest({ id: 'q2', pageId: loginPageId, ...GRAPHQL_QUERY, url: 'http://app.example.com/graphql', topUrl: APP_URL }), { action: 'continue', followRedirects: false });
  fake.emitRequestDone('q1', 307, { redirectRefused: true });
  fake.emitRequestDone('q2', 200);
  assert.deepEqual(logs.filter((l) => l.includes(loginId)), [`登录 ${loginId}：拦下 POST app.example.com`]);
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 1 });
});

test('login: the callback is allowed when the identity provider was entered by a redirect and its page sent no subresource (initiatorUrl on a login host)', async () => {
  const c = await loginSetup(); const { sm, loginId, loginPageId } = c;   // 从只读的 app 起登录
  assert.deepEqual(await nav(c, loginPageId, 'GET', 'http://app.example.com/saml/start', LOGIN_START), { action: 'continue' });
  // 路由只见重定向的首跳：页面其实停在身份提供方的自动提交页上，内核没见过它的任何请求；回调的发起页地址在 sso 上。
  assert.deepEqual(await nav(c, loginPageId, 'POST', 'http://app.example.com/acs', SSO_URL), { action: 'continue' });
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 0 });
});

test('login: the same form POST with an initiator that is not a login host is judged by the rules', async () => {
  const c = await loginSetup(); const { sm, loginId, loginPageId } = c;
  assert.deepEqual(await nav(c, loginPageId, 'GET', 'http://app.example.com/saml/start', LOGIN_START), { action: 'continue' });
  assert.equal((await nav(c, loginPageId, 'POST', 'http://app.example.com/acs', 'http://other.example.com/')).action, 'fulfill');
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 1 });
});

test('session: a top-level form POST converges the main page to its initiator host before the mode is computed', async () => {
  const { sm, fake } = setupRo(['example.com']); const { session, pageId } = await opened(sm, fake);   // 默认主机上的会话
  assert.equal((await nav({ fake }, pageId, 'GET', 'http://example.org/', 'http://localhost:5173/')).action, 'continue');   // 待定的 example.org
  assert.deepEqual(inner(sm, session).topHost, 'localhost');
  // 页面其实已经落在只读的 example.com（内核没见过它的请求）：这次提交的发起页是它
  const post = await nav({ fake }, pageId, 'POST', 'http://localhost:5173/api', 'http://example.com/');
  assert.equal(post.action, 'fulfill');
  assert.equal(inner(sm, session).topHost, 'example.com'); assert.equal(inner(sm, session).pendingHosts.size, 0);
});

// ---- initiatorUrl 为 null（主框架在 about:blank / 错误页，或归属判断失败）时的退路 ----

test('session: with no initiator address, an allowed navigation to a read-only host that never commits keeps a form POST back to the default host blocked (pending hosts)', async () => {
  // 起点和 POST 目标都是默认主机：能拦下它的只有待定的只读主机（pendingHosts）
  const { sm, fake } = setupRo(['example.com']); const r = await sm.open({ url: 'http://localhost:5173/' }); const pageId = fake.openPages().at(-1)!;
  assert.equal(r.mode, 'default');
  assert.equal((await nav({ fake }, pageId, 'GET', 'http://example.com/file.zip', null)).action, 'continue');
  assert.deepEqual([inner(sm, r.session).topHost, [...inner(sm, r.session).pendingHosts]], ['localhost', ['example.com']]);
  assert.equal((await nav({ fake }, pageId, 'POST', 'http://localhost:5173/submit', null)).action, 'fulfill');
  assert.equal(inner(sm, r.session).topHost, 'localhost');
});

test('login: with no initiator address, an allowed navigation to a read-only host that never commits keeps a form POST back to the default host blocked (pending hosts)', async () => {
  // 起点和 POST 目标都是默认主机：能拦下它的只有登录页待定的只读主机（place.pending）
  const D = 'http://localhost:5173/login'; const R = 'http://app.example.com/file.zip';
  const c = await loginSetup(['app.example.com'], D); const { sm, loginId, loginPageId } = c;
  assert.equal((await nav(c, loginPageId, 'GET', R, D)).action, 'continue');                     // 下载或 204：页面其实还在 D 上
  assert.equal((await nav(c, loginPageId, 'POST', 'http://localhost:5173/submit', null)).action, 'fulfill');
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 1 });
});

test('login: a popup of a login-host page with no initiator address starts from its opener host, so its callback form POST goes through', async () => {
  const c = await loginSetup(); const { sm, fake, loginId, loginPageId } = c;
  await nav(c, loginPageId, 'GET', SSO_URL, LOGIN_START); await commit(c, loginPageId, SSO_URL);
  const popup = fake.emitPopup(loginPageId, 'about:blank');
  assert.deepEqual(await nav(c, popup.id, 'POST', 'http://app.example.com/acs', null), { action: 'continue' });
  await sm.loginEnd({ loginId });
});

test('login: a popup of a read-only page with no initiator address starts from its opener host, so a form POST elsewhere is blocked', async () => {
  const D = 'http://localhost:5173/login'; const R = 'http://app.example.com/';
  const c = await loginSetup(['app.example.com'], D); const { sm, fake, loginId, loginPageId } = c;   // 起点是默认主机：靠开启者已提交的只读主机才拦得住
  await nav(c, loginPageId, 'GET', R, D); await commit(c, loginPageId, R);
  const popup = fake.emitPopup(loginPageId, 'about:blank');
  assert.equal((await nav(c, popup.id, 'POST', 'http://example.org/post', null)).action, 'fulfill');
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 1 });
});
