import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
import type { Mode, StepParams } from '../../src/shared/protocol.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';
import { makeTmpHome } from '../support/tmp-home.ts';
import { Approvals, noDialog } from '../../src/kernel/approval.ts';
import type { Dialog, DialogRequest, DialogResult } from '../../src/kernel/approval.ts';
import { ApprovalStore } from '../../src/kernel/approval-store.ts';
import { contentHash, createRulesResolver } from '../../src/kernel/rules.ts';
import { approving, choosingMode, denying, fakeDialog, holdingDialog } from '../support/fake-dialog.ts';
import { noFocus } from '../../src/kernel/focus.ts';
import type { FocusKeeper } from '../../src/kernel/focus.ts';
import { fakeFocus } from '../support/fake-focus.ts';

const CONTINUE: PolicyVerdict = { decision: { action: 'continue' }, reason: null, allowedBy: null };

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
    approvals: new Approvals(fakeDialog(), () => {}),
    store: ApprovalStore.open(tmp.home.approvalsFile, () => {}),
    focus: noFocus,   // 测试绝不真的切换用户的前台应用
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
  assert.equal(fake.launches, 1); assert.deepEqual(fake.launched, [{ name: 'default', userDataDir: join(home.profilesDir, 'default') }]);
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
  const deny: WritePolicy = { decide: () => CONTINUE, decideUnattributed: () => ({ decision: { action: 'abort' }, reason: 'unattributed', allowedBy: null }) };
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
    hostChoice: () => null,
    isListed: () => true,
    groupOf: defaultOnlyResolver.groupOf,
    group: defaultOnlyResolver.group,
    allLogout: () => [],
    isLoginHost: (h) => loginHosts.includes(h),
    refresh: () => { st.refreshes++; const p = st.pending; st.pending = null; p?.(); },
    state: () => ({ count: st.ro.size, hash: st.hash, error: st.error, pending: null, pendingHash: null, approvals: 'absent', approvalsChanged: false }),
    pending: () => null,
    approvePending: () => false,
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

test('a readonly rule in an unapproved rules.json is already in force: the timeline says rule and carries the pending hash, result.json.rules carries it too', async () => {
  const tmp = makeTmpHome();
  const modes = listedAll(createRulesResolver(tmp.home.rulesFile, ApprovalStore.open(tmp.home.approvalsFile, () => {})));
  const { sm, fake } = setup({ modes, policy, home: tmp.home });
  cleanups.push(async () => { tmp.cleanup(); });
  const a = await sm.open({ url: 'http://localhost:5173/' });   // 开的时候还没有规则文件
  const pageId = fake.openPages().at(-1)!;
  writeFileSync(tmp.home.rulesFile, JSON.stringify({ version: 1, rules: [{ match: 'example.com', mode: 'readonly' }] }));
  await assert.rejects(sm.open({ url: RO }), (e: E2kError) => e.code === 'wait-approval');   // 新的 open 要先过批准；这一下也让规则文件进了待批
  const pendingHash = modes.state().pendingHash;
  assert.match(pendingHash ?? '', /^sha256:[0-9a-f]{16}$/);
  // 已开的会话导航到 example.com：待批文件里的收紧已在生效
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'GET', url: RO, isNavigation: true, topFrame: true, topUrl: RO }), { action: 'continue' });
  assert.equal((await fake.emitRequest({ pageId, method: 'POST', url: 'http://example.com/api', topUrl: RO, body: '{}', contentType: 'application/json' })).action, 'fulfill');
  const timeline = inner(sm, a.session).recorder.modes as unknown as { mode: string; reason: string; rulesHash: string | null; pendingRulesHash: string | null }[];
  const change = timeline.at(-1);
  assert.deepEqual([change?.mode, change?.reason, change?.rulesHash, change?.pendingRulesHash], ['readonly', 'rule', null, pendingHash]);
  const result = readResult((await sm.close({ session: a.session })).runDir);
  assert.deepEqual(result.rules, { hash: null, count: 0, pendingHash });
  assert.equal(result.modes.at(-1)?.pendingRulesHash, pendingHash);
});

// ---- 规则改动的入口闸门（M2b 任务 4） ----

const GATE_RULES = { version: 1, rules: [{ match: 'example.com', mode: 'readonly' }], loginHosts: ['sso.example.com'] };
const LOGIN_URL = 'http://localhost:5173/login.html';

// 旧的登录测试不关心「没列明的主机登录前先问」：把 isListed 盖成 true（resolve 仍是真的）。测这条的用例要用真的 isListed。
const listedAll = (m: ModeResolver): ModeResolver => ({ ...m, isListed: () => true });

// 真的规则解析器和批准记录、假驱动、可编排的假对话框；规则文件由测试自己写。
// realListing 为 true 时登录前的「问模式」闸门是真的（默认关，免得别的测试被多问一个框）。
function setupGate(dialog: Dialog, rules: unknown = GATE_RULES, now?: () => number, realListing = false) {
  const tmp = makeTmpHome();
  if (rules !== null) writeFileSync(tmp.home.rulesFile, JSON.stringify(rules));
  const store = ApprovalStore.open(tmp.home.approvalsFile, () => {});
  const real = createRulesResolver(tmp.home.rulesFile, store);
  const modes = realListing ? real : listedAll(real);
  const s = setup({ modes, policy, home: tmp.home, store, approvals: new Approvals(dialog, () => {}, now === undefined ? {} : { now }) });
  cleanups.push(async () => { tmp.cleanup(); });
  return { ...s, modes, store, home: tmp.home };
}

const writeRules = (home: { rulesFile: string }, rules: unknown): void => { writeFileSync(home.rulesFile, JSON.stringify(rules)); };
const isCode = (code: string) => (e: unknown): boolean => e instanceof E2kError && e.code === code;
const settleDialog = (): Promise<void> => sleep(5);   // 假对话框在后台几个微任务里就答完了
const fullText = (rules: unknown): string => JSON.stringify(rules);


test('changed rules: the first open gets 21 and asks once; approving lets the retry through and the store holds the new hash; the next change asks again', async () => {
  const { dialog, release } = holdingDialog();
  const { sm, store, home } = setupGate(dialog);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));   // 框还开着时同一份改动再来：对上同一个框，不弹第二个
  assert.equal(dialog.requests.length, 1);
  const req = dialog.requests[0]!;
  assert.deepEqual([req.buttons, req.defaultButton, req.timeoutSec], [['拒绝', '批准'], '拒绝', 120]);
  assert.match(req.title, /^e2k：域名规则改了（请求 a-[0-9a-f]{6}）$/);
  assert.match(req.lines[0]!, /^规则文件有改动（sha256:[0-9a-f]{16}），批准后才生效：$/);
  assert.ok(req.lines.includes('+ 顶层登录主机：sso.example.com') && req.lines.includes('+ 规则 example.com（只读）'));
  assert.deepEqual(req.lines.slice(-2), ['', '拒绝：继续按上一次批准的规则（收紧的部分已经先生效）']);
  release();
  await settleDialog();
  const r = await sm.open({ url: RO });
  assert.equal(r.mode, 'readonly');
  assert.equal(store.get().rules?.text, fullText(GATE_RULES));
  assert.equal(store.get().rules?.hash, contentHash(fullText(GATE_RULES)));
  assert.equal(dialog.requests.length, 1, 'the retry does not ask again');
  const next = { version: 1, rules: [{ match: 'example.com', mode: 'default' }] };
  writeRules(home, next);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  assert.equal(dialog.requests.length, 2, 'a new change is a new request');
});

test('denied: the retry is a usage error, nothing is asked again, and every kind of open (also --readonly) and login stays refused', async () => {
  const dialog = fakeDialog(denying);
  const { sm, store, modes } = setupGate(dialog);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  for (const call of [() => sm.open({ url: RO }), () => sm.open({ url: 'http://localhost:5173/', readonly: true }), () => sm.loginBegin({ url: LOGIN_URL })]) {
    await assert.rejects(call(), (e: E2kError) => e.code === 'usage' && /人拒绝了这次规则改动/.test(e.message) && /内核重启前同一份改动不会再问/.test(e.next ?? ''));
  }
  assert.equal(dialog.requests.length, 1);
  assert.equal(store.get().rules, null, 'nothing was approved');
  assert.notEqual(modes.pending(), null);
});

test('denied for a different change within 60 seconds of the last refusal says it was refused just now', async () => {
  const { sm, home } = setupGate(fakeDialog(denying));
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  writeRules(home, { version: 1, rules: [{ match: 'example.org', mode: 'readonly' }] });
  await assert.rejects(sm.open({ url: RO }), (e: E2kError) => e.code === 'usage' && /刚被人拒过/.test(e.message));
});

test('a dialog that cannot be shown is needs-human (22) with the reason; a dialog nobody answers asks again on the retry', async () => {
  const { sm: sm1 } = setupGate(noDialog);
  await assert.rejects(sm1.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  await assert.rejects(sm1.open({ url: RO }), (e: E2kError) => e.code === 'needs-human' && e.message.includes('规则改了但弹不出批准框：内核以 --no-dialogs 启动') && e.next === '在有桌面的终端里起内核');
  await assert.rejects(sm1.loginBegin({ url: LOGIN_URL }), isCode('needs-human'));
  let shown = 0;
  const timeout = fakeDialog(() => (++shown === 1 ? { kind: 'timeout' } : approving({ buttons: ['拒绝', '批准'] } as never)));
  const { sm: sm2 } = setupGate(timeout);
  await assert.rejects(sm2.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  await assert.rejects(sm2.open({ url: RO }), isCode('wait-approval'));   // 超时：没人理，再问一次
  await settleDialog();
  assert.equal(shown, 2);
  assert.equal((await sm2.open({ url: RO })).mode, 'readonly');
});

test('login.begin goes through the same gate and shares the request with open', async () => {
  const { dialog, release } = holdingDialog();
  const { sm, fake } = setupGate(dialog);
  await assert.rejects(sm.loginBegin({ url: LOGIN_URL }), isCode('wait-approval'));
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));   // 同一份改动：一个框
  assert.equal(dialog.requests.length, 1);
  assert.equal(fake.openPages().length, 0, 'no page was opened while the change was pending');
  release();
  await settleDialog();
  const { loginId } = await sm.loginBegin({ url: LOGIN_URL });
  await sm.loginEnd({ loginId });
  assert.equal(dialog.requests.length, 1);
});

test('an open session keeps working while a change is pending: step carries the notice and the exit code is unaffected', async () => {
  const { sm, home } = setupGate(fakeDialog(approving), null);
  const a = await sm.open({ url: 'http://localhost:5173/' });
  writeRules(home, GATE_RULES);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  const r = await sm.step({ session: a.session, ops: [{ op: 'snapshot' }] });
  assert.equal(r.exit, 0);
  assert.ok(r.notices.includes('规则文件有未批准的改动（收紧的部分已生效）'), r.notices.join('|'));
  await settleDialog();
  await sm.open({ url: RO });   // 批准、重试：待批清掉了
  assert.ok(!(await sm.step({ session: a.session, ops: [{ op: 'snapshot' }] })).notices.some((n) => n.includes('未批准的改动')));
});

test('tightening is in force before approval (the next POST of an open session is blocked); relaxing waits for approval', async () => {
  const dialog = fakeDialog(approving);
  const { sm, fake, home } = setupGate(dialog, null);
  // 1) 没有规则：example.com 上的会话是默认模式，写放行；加一条只读规则（待批）后，下一个 POST 立刻被拦
  const a = await sm.open({ url: RO }); const pageA = fake.openPages().at(-1)!;
  assert.equal((await fake.emitRequest({ pageId: pageA, method: 'POST', url: 'http://example.com/api', topUrl: RO })).action, 'continue');
  writeRules(home, GATE_RULES);
  await assert.rejects(sm.open({ url: 'http://localhost:5173/' }), isCode('wait-approval'));   // 此刻批准还没落盘
  assert.equal((await fake.emitRequest({ pageId: pageA, method: 'POST', url: 'http://example.com/api', topUrl: RO })).action, 'fulfill');
  await settleDialog();
  await sm.open({ url: 'http://localhost:5173/' });   // 批准
  // 2) 已批准只读；改成默认（放宽，待批）：已开的只读会话照旧只读，直到批准
  const b = await sm.open({ url: RO }); const pageB = fake.openPages().at(-1)!;
  assert.equal(b.mode, 'readonly');
  writeRules(home, { version: 1, rules: [{ match: 'example.com', mode: 'default' }], loginHosts: ['sso.example.com'] });
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  assert.equal((await fake.emitRequest({ pageId: pageB, method: 'POST', url: 'http://example.com/api', topUrl: RO })).action, 'fulfill');
  await settleDialog();
  assert.equal((await sm.open({ url: RO })).mode, 'default');
  await sm.close({ session: a.session });
});

test('a file changed after the dialog was shown is a different request: the first change is never approved', async () => {
  const { dialog, release } = holdingDialog();
  const { sm, store, home } = setupGate(dialog);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  const second = { version: 1, rules: [{ match: 'example.org', mode: 'readonly' }] };
  writeRules(home, second);
  release();   // 人批准的是第一份
  await settleDialog();
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));   // 第二份是新的请求，要重新问
  assert.equal(dialog.requests.length, 2);
  assert.equal(store.get().rules, null, 'what was approved is not what is on disk now');
});

// 只管闸门本身的桩：待批的身份是完整哈希，批准比的就是它；写不进批准记录的 needs-human 原样往上。
function stubGate(approve: (hash: string | null) => boolean) {
  const hash = 'ab'.repeat(32);
  const calls: (string | null)[] = []; let refreshes = 0; let cleared = false;
  const pending = { hash, baseHash: null, text: '{}', summary: ['+ 规则 example.com（只读）'], tooLong: false };
  const modes: ModeResolver = { ...defaultOnlyResolver, refresh: () => { refreshes++; }, pending: () => (cleared ? null : pending),
    state: () => ({ ...defaultOnlyResolver.state(), pending: { hash: 'sha256:abababababababab', tooLong: false }, pendingHash: 'sha256:abababababababab' }),
    approvePending: (h) => { calls.push(h); const ok = approve(h); cleared ||= ok; return ok; } };
  const dialog = fakeDialog(approving);
  const s = setup({ modes, approvals: new Approvals(dialog, () => {}) });
  return { ...s, hash, calls, refreshes: () => refreshes, dialogRequests: () => dialog.requests.length };
}

test('the gate approves with the full 64-digit hash of the pending file, and forgets the answer once it is applied', async () => {
  let applied = false;
  const g = stubGate(() => { applied = true; return true; });
  await assert.rejects(g.sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  assert.equal((await g.sm.open({ url: RO })).mode, 'default');
  assert.deepEqual(g.calls, [g.hash]);
  assert.ok(applied);
});

test('when the pending file no longer matches the answer the gate does not open (internal error, the stale answer is dropped)', async () => {
  const g = stubGate(() => false);
  await assert.rejects(g.sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  await assert.rejects(g.sm.open({ url: RO }), isCode('internal'));
  assert.equal(g.calls.length, 1);
  await assert.rejects(g.sm.open({ url: RO }), isCode('wait-approval'));   // 旧答案已作废：重新问
  assert.equal(g.dialogRequests(), 2);
});

test('a failure to write the approval is passed up as it is (needs-human), not wrapped as internal', async () => {
  const g = stubGate(() => { throw new E2kError('needs-human', '批准记录写不进磁盘'); });
  await assert.rejects(g.sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  await assert.rejects(g.sm.open({ url: RO }), (e: E2kError) => e.code === 'needs-human' && e.message === '批准记录写不进磁盘');
  await assert.rejects(g.sm.loginBegin({ url: LOGIN_URL }), isCode('needs-human'));
});

// 复审者复现的两个场景：人批准了一份已经过时的改动，之后基线换了；那个没用掉的答案不能让后来的改回去不弹框就生效。
const STALE_H = { version: 1, rules: [{ match: 'example.com', mode: 'readonly' }] };
const STALE_H2 = { version: 1, rules: [{ match: 'example.com', mode: 'readonly' }, { match: 'example.org', mode: 'readonly' }] };

function holdingMany() {
  const releases: (() => void)[] = [];
  const dialog = fakeDialog((r) => new Promise((resolve) => { releases.push(() => { resolve(approving(r)); }); }));
  return { dialog, releases };
}

test('an approval that was never used does not apply on a new baseline: going back to an earlier text asks again and example.org stays read-only', async () => {
  const { dialog, releases } = holdingMany();
  const { sm, modes, home } = setupGate(dialog, null);
  writeRules(home, STALE_H);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));          // 框 1：H
  writeRules(home, STALE_H2);                                                      // 人点之前又改了
  releases[0]!(); await settleDialog();                                            // 人批准的是 H，已经过时
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));          // 框 2：H2
  releases[1]!(); await settleDialog();
  await sm.close({ session: (await sm.open({ url: RO })).session });               // H2 生效
  assert.equal(modes.resolve('example.org'), 'readonly');
  assert.equal(dialog.requests.length, 2);
  writeRules(home, STALE_H);                                                       // 改回 H：放宽 example.org
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));          // 必须再弹框
  assert.equal(dialog.requests.length, 3);
  assert.equal(modes.resolve('example.org'), 'readonly', 'the relaxing change is still pending, not in force');
  releases[2]!(); await settleDialog();
  await sm.close({ session: (await sm.open({ url: RO })).session });
  assert.equal(modes.resolve('example.org'), 'default');
});

test('an approved deletion that was never used does not apply later: deleting the file again asks again and the rules are not wiped', async () => {
  const { dialog, releases } = holdingMany();
  const { sm, modes, home } = setupGate(dialog, null);
  writeRules(home, STALE_H);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  releases[0]!(); await settleDialog();
  await sm.close({ session: (await sm.open({ url: RO })).session });               // H 生效
  rmSync(home.rulesFile);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));          // 框 2：删文件
  writeRules(home, STALE_H2);                                                      // 人点之前文件又回来了，换了内容
  releases[1]!(); await settleDialog();                                            // 人批准的是「删掉」，已经过时
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));          // 框 3：H（基线）→ H2
  releases[2]!(); await settleDialog();
  await sm.close({ session: (await sm.open({ url: RO })).session });               // H2 生效
  const shown = dialog.requests.length;
  rmSync(home.rulesFile);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  assert.equal(dialog.requests.length, shown + 1, 'a new dialog for the deletion');
  assert.equal(modes.state().count, 2, 'the approved rules are still there');
  assert.equal(modes.resolve('example.org'), 'readonly');
});

test('deleting rules.json is a pending change too: the dialog says so, and approving it removes the approved rules', async () => {
  const dialog = fakeDialog(approving);
  const { sm, store, home } = setupGate(dialog);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  await sm.open({ url: RO });
  rmSync(home.rulesFile);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  const req = dialog.requests[1]!;
  assert.equal(req.lines[0], '规则文件有改动（文件被删了），批准后才生效：');
  assert.ok(req.lines.includes('规则文件被删了：所有规则失效'));
  await settleDialog();
  assert.equal((await sm.open({ url: RO })).mode, 'default');
  assert.equal(store.get().rules, null);
});

test('too many changes: the dialog has only a deny button and the result is a usage error that points at rule diff', async () => {
  const dialog = fakeDialog(approving);   // 脚本想批准也没得批：框里没有「批准」
  const many = { version: 1, rules: Array.from({ length: 13 }, (_, i) => ({ match: `h${i}.example.com`, mode: 'readonly' })) };
  const { sm, store } = setupGate(dialog, many);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 1);
  const req = dialog.requests[0]!;
  assert.deepEqual([req.buttons, req.defaultButton], [['拒绝'], '拒绝']);
  assert.ok(req.lines.join('\n').includes('e2k rule diff') && /sha256:[0-9a-f]{16}/.test(req.lines[0]!));
  await assert.rejects(sm.open({ url: RO }), (e: E2kError) => e.code === 'usage' && /规则改动太多/.test(e.message) && /e2k rule diff/.test(e.next ?? '') && /拆成几次改/.test(e.next ?? ''));
  assert.equal(store.get().rules, null);
});

test('the same text that was too long against one approved baseline is an ordinary dialog against another', async () => {
  const dialog = fakeDialog(approving);
  const many = { version: 1, rules: Array.from({ length: 13 }, (_, i) => ({ match: `h${i}.example.com`, mode: 'readonly' })) };
  let clock = 1_000_000;
  const { sm, home, store } = setupGate(dialog, many, () => clock);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  assert.deepEqual(dialog.requests[0]!.buttons, ['拒绝']);   // 相对「没有批准过」太长：只有拒绝
  await assert.rejects(sm.open({ url: RO }), isCode('usage'));
  clock += 61_000;   // 过了拒绝后的冷却
  // 基线换成差不多的一份（人批准了另一次小改动）：同一份文本只差一条，不再算太长
  const nearly = { version: 1, rules: many.rules.slice(0, 12) };
  writeRules(home, nearly);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.at(-1)!.buttons.length, 2);
  await sm.open({ url: RO });   // nearly 批准成了新基线
  writeRules(home, many);
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'), 'the key has changed with the baseline, so the earlier refusal does not apply');
  await settleDialog();
  assert.deepEqual(dialog.requests.at(-1)!.buttons, ['拒绝', '批准'], 'one added rule is a short list now');
  assert.equal(dialog.requests.at(-1)!.lines.filter((l) => l.startsWith('+ 规则')).length, 1);
  await sm.open({ url: RO });
  assert.equal(store.get().rules?.text, fullText(many));
});

test('a dialog text that is too long is a usage error and nothing is shown', async () => {
  const dialog = fakeDialog(approving);
  const { sm } = setupGate(dialog, { version: 1, rules: [{ match: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.example.com`, mode: 'readonly' }] });
  await assert.rejects(sm.open({ url: RO }), (e: E2kError) => e.code === 'usage' && /内容太长/.test(e.message));
  assert.equal(dialog.requests.length, 0);
});

test('approvals.json deleted while the kernel runs: a readonly session stays readonly, step says the record was changed from outside', async () => {
  const { sm, fake, home } = setupGate(fakeDialog(approving));
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  const a = await sm.open({ url: RO }); const pageA = fake.openPages().at(-1)!;
  assert.equal(a.mode, 'readonly');
  rmSync(home.approvalsFile);
  const other = await sm.open({ url: 'http://localhost:5173/' });   // open 先重读规则，也就看见了批准记录没了
  const r = await sm.step({ session: a.session, ops: [{ op: 'snapshot' }] });
  assert.ok(r.notices.includes('批准记录被内核以外的进程改过，已忽略'), r.notices.join('|'));
  assert.equal((await fake.emitRequest({ pageId: pageA, method: 'POST', url: 'http://example.com/api', topUrl: RO })).action, 'fulfill');
  assert.equal((await sm.open({ url: RO })).mode, 'readonly', 'the in-memory approval is still in force');
  assert.ok(other.session);
});

test('an approvals record that cannot be read at start puts the existing rules.json up for approval again; a record that cannot be written is needs-human and changes nothing', async () => {
  const tmp = makeTmpHome();
  writeRules(tmp.home, GATE_RULES);
  mkdirSync(tmp.home.approvalsFile);   // 读不了（不是普通文件），也写不进去（rename 不能盖掉目录）；不是在伪造批准
  const store = ApprovalStore.open(tmp.home.approvalsFile, () => {});
  const modes = listedAll(createRulesResolver(tmp.home.rulesFile, store));
  const dialog = fakeDialog(approving);
  const { sm } = setup({ modes, policy, home: tmp.home, store, approvals: new Approvals(dialog, () => {}) });
  cleanups.push(async () => { tmp.cleanup(); });
  assert.equal(modes.state().approvals, 'unreadable');
  assert.notEqual(modes.pending(), null, 'with an empty snapshot the existing file is a pending change');
  await assert.rejects(sm.open({ url: RO }), isCode('wait-approval'));
  await settleDialog();
  await assert.rejects(sm.open({ url: RO }), (e: E2kError) => e.code === 'needs-human' && e.message === '批准记录写不进磁盘');   // 原样往上，不被包成 internal
  assert.equal(modes.state().count, 0);
  assert.notEqual(modes.pending(), null);
  assert.equal(modes.state().approvals, 'unreadable');
});

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
  assert.deepEqual(res.rules, { hash: 'sha256:0000000000000002', count: 1, pendingHash: null });   // 收尾时生效的那份
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
  const noRedirect: WritePolicy = { decide: policy.decide, decideUnattributed: () => ({ decision: { action: 'continue', followRedirects: false }, reason: null, allowedBy: null }) };
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
  const sm = new SessionManager({ driver: fake, home: tmp.home, modes: rules.resolver, policy, idleMs: 60_000, keepRuns: 20, now: () => new Date(), kernelVersion: '0.1.0', log: () => {}, approvals: new Approvals(fakeDialog(), () => {}), store: ApprovalStore.open(tmp.home.approvalsFile, () => {}), focus: noFocus });
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

// ---- 每个 profile 一个浏览器实例（M2b 任务 5） ----
// 协议里还不能选 profile（Task 6）：这里用内部入口在指定 key 的实例上开会话、开登录页。

interface OnProfile {
  open(key: string, p?: { name?: string }): Promise<{ session: string; runDir: string }>;
  loginBegin(key: string): Promise<{ loginId: string }>;
}

// 假的域名组：<名字>.example.com 属于组「名字」；group() 只认 names 里列的组（其余没有这个组）。
function groupedRules(names: string[]): ModeResolver {
  const make = (name: string, hosts: string[]) => ({ ...defaultOnlyResolver.group('default')!, name, hosts });
  return {
    ...defaultOnlyResolver,
    groupOf: (h) => { const m = /^([a-z0-9_-]+)\.example\.com$/.exec(h)?.[1]; return m !== undefined && names.includes(m) ? make(m, [h]) : defaultOnlyResolver.groupOf(h); },
    group: (n) => (n === 'default' || names.includes(n) ? make(n, []) : null),
  };
}

const PROFILE_GROUPS = ['admin', 'other', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'linked', 'dangling', 'afile'];
const setupP = (overrides: Parameters<typeof setup>[0] = {}) => setup({ modes: groupedRules(PROFILE_GROUPS), ...overrides });

// 经协议公开入口选 profile：key 是 `组` 或 `组@槽`（命令行写法是 `组/槽`），域名是 <组>.example.com（本组的域名，槽才用得上）。
function onProfile(sm: SessionManager): OnProfile {
  const argOf = (key: string): string => key.replace('@', '/');
  const urlOf = (key: string): string => `http://${key.split('@')[0]}.example.com/`;
  return {
    open: (key, p = {}) => sm.open({ ...p, url: urlOf(key), profile: argOf(key) }),
    loginBegin: (key) => sm.loginBegin({ url: `${urlOf(key)}login.html`, profile: argOf(key) }),
  };
}

const HOME_URL = 'http://localhost:5173/';
const isBusyProfiles = (e: unknown): boolean => e instanceof E2kError && e.code === 'busy' && e.message === '同时开着的 profile 太多，先关掉一些会话';

// 记下驱动启动过的每个实例，测试里好直接问它们的状态。
function trackLaunched(fake: FakeDriver): { health(i: number): Promise<boolean>; count(): number } {
  const insts: Awaited<ReturnType<FakeDriver['launch']>>[] = [];
  const orig = fake.launch.bind(fake);
  fake.launch = async (p) => { const inst = await orig(p); insts.push(inst); return inst; };
  return { health: async (i) => (await insts[i]!.health()).ok, count: () => insts.length };
}

test('each profile key gets its own instance, launched lazily and once even for concurrent opens, in profiles/<key>', async () => {
  const { sm, fake, home } = setupP({ launchDelayMs: 30 });
  const p = onProfile(sm);
  const [a1, a2, t1] = await Promise.all([p.open('admin'), p.open('admin'), p.open('admin@t1')]);
  assert.deepEqual(fake.launched, [
    { name: 'admin', userDataDir: join(home.profilesDir, 'admin') },
    { name: 'admin@t1', userDataDir: join(home.profilesDir, 'admin@t1') },
  ]);
  assert.equal(sm.instanceState(), 'running'); assert.equal(sm.list().length, 3);
  assert.equal(statSync(join(home.profilesDir, 'admin@t1')).mode & 0o777, 0o700);
  await sm.open({ url: HOME_URL });                                                       // 协议入口仍用 default：第三个实例
  assert.equal(fake.launches, 3); assert.equal(fake.launched[2]?.name, 'default');
  for (const s of [a1, a2, t1]) await sm.close({ session: s.session });
  assert.deepEqual([a1, a2, t1].map((s) => readResult(s.runDir).start.profile), ['admin', 'admin', 'admin@t1']);
  await p.open('admin');                                               // 实例还在，复用
  assert.equal(fake.launches, 3);
});

test('one instance going away ends only its own sessions and login pages; the others keep working and loginEnd records to its own profile', async () => {
  const { sm, fake, home } = setupP();
  const p = onProfile(sm);
  const a = await p.open('admin', { name: 'on-a' });
  const b = await p.open('admin@t1', { name: 'on-b' });
  const pageA = fake.openPages().at(-2)!; const pageB = fake.openPages().at(-1)!;
  const loginA = await p.loginBegin('admin');
  const loginB = await p.loginBegin('admin@t1');
  fake.closeInstance(0);
  await until(() => existsSync(join(a.runDir, 'result.json')));
  await sleep(30);
  assert.equal(readResult(a.runDir).closedBy, 'browser-gone');
  assert.equal(readdirSync(join(home.runsDir, 'on-a')).length, 1);                        // 只出一份
  assert.deepEqual(sm.list().map((s) => s.session), [b.session]);                         // B 的会话还在
  assert.ok(!existsSync(join(b.runDir, 'result.json')));
  assert.equal((await sm.step({ session: b.session, ops: [{ op: 'snapshot' }] })).results[0]?.outcome, 'ok');
  assert.ok(fake.openPages().includes(pageB) && !fake.openPages().includes(pageA));
  await assert.rejects(sm.loginEnd({ loginId: loginA.loginId }), (e: E2kError) => e.code === 'not-found');   // A 的登录页没了
  assert.deepEqual(await sm.loginEnd({ loginId: loginB.loginId }), { writesBlocked: 0 });                     // B 的登录页还在
  assert.equal(profileInfo(home, 'admin@t1').lastLogin?.host, 'admin.example.com');
  assert.equal(profileInfo(home, 'admin').lastLogin, null); assert.equal(profileInfo(home, 'default').lastLogin, null);
  assert.ok(existsSync(join(home.profilesDir, 'admin@t1' + '.login.json')));
  assert.equal((await sm.close({ session: b.session })).exit, 0);
  await p.open('admin');                                               // A 的 key 可以重新启动
  assert.equal(fake.launches, 3);
});

test('a page closing on one instance whose browser is healthy ends only that session (page-gone); a dead browser is told apart per instance', async () => {
  const { sm, fake } = setupP();
  const p = onProfile(sm);
  const a = await p.open('admin'); const b = await p.open('other');
  const pageA = fake.openPages().at(-2)!;
  fake.closePage(pageA);
  await until(() => existsSync(join(a.runDir, 'result.json')));
  assert.equal(readResult(a.runDir).closedBy, 'page-gone');
  assert.deepEqual(sm.list().map((s) => s.session), [b.session]);
});

test('the fifth profile is busy; reusing a running profile and failed starts do not count; closing a browser frees a slot', async () => {
  const { sm, fake } = setupP();
  const p = onProfile(sm);
  for (const k of ['k1', 'k2', 'k3', 'k4']) await p.open(k);
  await assert.rejects(p.open('k5'), isBusyProfiles);
  await assert.rejects(p.loginBegin('k5'), isBusyProfiles);
  await assert.rejects(sm.open({ url: HOME_URL }), isBusyProfiles);                       // default 也算一个
  assert.equal(fake.launches, 4);
  assert.equal(sm.list().length, 4);
  await p.open('k1');                                                  // 已经在跑的 profile 不占新名额
  assert.equal(fake.launches, 4); assert.equal(sm.list().length, 5);
  fake.closeInstance(1);                                                                  // k2 的浏览器没了，它的一个会话跟着没了
  await until(() => sm.list().length === 4);
  await p.open('k5');
  assert.equal(fake.launches, 5);
});

test('concurrent starts of different new profiles cannot both pass the limit', async () => {
  const { sm, fake } = setupP({ launchDelayMs: 30 });
  const p = onProfile(sm);
  const r = await Promise.allSettled(['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map((k) => p.open(k)));
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'rejected']);
  for (const x of r.slice(4)) assert.ok(isBusyProfiles((x as PromiseRejectedResult).reason));
  assert.equal(fake.launches, 4);
});

test('a profile directory that is a symbolic link or a file is needs-human: nothing is launched, no page, no run dir, and it does not use up a slot', async () => {
  const { sm, fake, home } = setupP();
  const p = onProfile(sm);
  mkdirSync(home.profilesDir, { mode: 0o700 });
  const outside = join(home.root, 'outside');
  mkdirSync(outside);
  const isWrongDir = (e: unknown): boolean => e instanceof E2kError && e.code === 'needs-human' && e.message === 'profile 目录不对';
  symlinkSync(outside, join(home.profilesDir, 'linked'));
  symlinkSync(join(home.profilesDir, 'missing-target'), join(home.profilesDir, 'dangling'));
  writeFileSync(join(home.profilesDir, 'afile'), 'x');
  for (const k of ['linked', 'dangling', 'afile', 'linked', 'dangling', 'afile']) {                 // 失败的启动多于上限也不占名额
    await assert.rejects(p.open(k, { name: 'refused' }), isWrongDir, k);
  }
  await assert.rejects(p.loginBegin('linked'), isWrongDir);
  assert.equal(fake.launches, 0); assert.deepEqual(fake.openPages(), []); assert.equal(sm.instanceState(), 'stopped'); assert.deepEqual(sm.list(), []);
  assert.deepEqual(readdirSync(outside), []);
  assert.ok(!existsSync(join(home.runsDir, 'refused')));
  for (const k of ['k1', 'k2', 'k3', 'k4']) await p.open(k);
  assert.equal(fake.launches, 4);
  // 目录换成符号链接后：已经在跑的实例不受影响，但它没了以后再启动就被拒绝。
  fake.closeInstance(0);
  await until(() => sm.list().length === 3);
  rmSync(join(home.profilesDir, 'k1'), { recursive: true });
  symlinkSync(outside, join(home.profilesDir, 'k1'));
  await assert.rejects(p.open('k1'), isWrongDir);
  assert.equal(fake.launches, 4); assert.deepEqual(readdirSync(outside), []);
});

test('a profile argument that is not a plain name never reaches the driver (a/b is a valid shape here, but there is no group a)', async () => {
  const { sm, fake, home } = setupP();
  for (const k of ['../x', 'a/b', 'Admin', '', 'a@b@c', 'a'.repeat(33), '..', '/etc', 'admin/t1/x', 'admin/', '/t1']) {
    await assert.rejects(sm.open({ url: HOME_URL, profile: k }), (e: E2kError) => e.code === 'usage', JSON.stringify(k));
    await assert.rejects(sm.loginBegin({ url: HOME_URL, profile: k }), (e: E2kError) => e.code === 'usage', JSON.stringify(k));
  }
  assert.equal(fake.launches, 0); assert.equal(sm.instanceState(), 'stopped');
  assert.ok(!existsSync(join(dirname(home.profilesDir), 'x')));
});

test('shutdown stops every instance, and waits for ones that are still starting', async () => {
  const { sm, fake } = setupP({ launchDelayMs: 40 });
  const seen = trackLaunched(fake);
  const p = onProfile(sm);
  await Promise.all([p.open('k1'), p.open('k2')]);
  const starting = [p.open('k3'), p.loginBegin('k4')];
  const settled = Promise.allSettled(starting);
  await sleep(10);                                                                        // k3、k4 还在启动
  await sm.shutdown();
  for (const r of await settled) assert.ok(r.status === 'rejected' && (r.reason as E2kError).message === '内核正在关停');
  assert.equal(seen.count(), 4);
  for (let i = 0; i < 4; i++) assert.equal(await seen.health(i), false, `instance ${i}`);
  assert.equal(sm.instanceState(), 'stopped'); assert.deepEqual(fake.openPages(), []);
  await assert.rejects(p.open('k5'), (e: E2kError) => e.message === '内核正在关停');
  assert.equal(fake.launches, 4);
});

test('the rules gate comes before any instance start or page for any profile', async () => {
  const { dialog } = holdingDialog();
  const { sm, fake } = setupGate(dialog);
  await assert.rejects(sm.open({ url: RO, profile: 'admin' }), isCode('wait-approval'));
  await assert.rejects(sm.loginBegin({ url: LOGIN_URL, profile: 'admin/t1' }), isCode('wait-approval'));
  assert.equal(fake.launches, 0); assert.deepEqual(fake.openPages(), []); assert.equal(sm.instanceState(), 'stopped');
});

test('requests from each instance land in their own session record, and a popup joins its opener\'s session', async () => {
  const { sm, fake } = setupP({ policy });
  const p = onProfile(sm);
  const a = await p.open('admin', { name: 'ra' }); const b = await p.open('admin@t1', { name: 'rb' });
  const [pageA, pageB] = fake.openPages().slice(-2) as [string, string];
  const post = (id: string, pageId: string) => fake.emitRequest({ id, pageId, method: 'POST', url: 'http://localhost:5173/api', body: '{}', contentType: 'application/json' });
  assert.equal((await post('qa', pageA)).action, 'continue');
  assert.equal((await post('qb1', pageB)).action, 'continue');
  const popB = fake.emitPopup(pageB, HOME_URL);
  assert.equal((await post('qpop', popB.id)).action, 'continue');
  assert.equal((await post('qb2', pageB)).action, 'continue');
  fake.emitRequestDone('qb1', 200);
  fake.emitRequestDone('qa', 201);
  const ra = readResult((await sm.close({ session: a.session })).runDir); const rb = readResult((await sm.close({ session: b.session })).runDir);
  assert.deepEqual([ra.start.profile, rb.start.profile], ['admin', 'admin@t1']);
  assert.deepEqual(ra.writes.allowed.map((w) => [w.id, w.status]), [['qa', 201]]);
  assert.deepEqual(rb.writes.allowed.map((w) => [w.id, w.status]), [['qb1', 200], ['qpop', null], ['qb2', null]]);
  assert.deepEqual([ra.writes.unattributed, rb.writes.unattributed], [[], []]);
  assert.deepEqual(fake.openPages(), []);
});

// ---- 到上限时回收空闲实例（M2b 任务 5 修复轮 1） ----

// 给假驱动的每个实例装上：停止要多花 stopMs；同时「活着」的实例数峰值（启动完成算活，停完才算死）。
function trackLive(fake: FakeDriver, stopMs = 0): { health(i: number): Promise<boolean>; peak(): number } {
  const insts: Awaited<ReturnType<FakeDriver['launch']>>[] = [];
  let live = 0; let peak = 0;
  const orig = fake.launch.bind(fake);
  fake.launch = async (p) => {
    const inst = await orig(p);
    insts.push(inst); live++; peak = Math.max(peak, live);
    const stop = inst.stop.bind(inst);
    inst.stop = async () => { await sleep(stopMs); await stop(); live--; };
    return inst;
  };
  return { health: async (i) => (await insts[i]!.health()).ok, peak: () => peak };
}

async function closeAllOn(sm: SessionManager, sessions: { session: string }[]): Promise<void> {
  for (const s of sessions) await sm.close({ session: s.session });
}

test('at the limit the instance with no sessions is reclaimed for a new profile; the others are untouched; with none idle it is busy', async () => {
  const { sm, fake, logs } = setupP();
  const seen = trackLive(fake); const p = onProfile(sm);
  const s: Record<string, { session: string; runDir: string }[]> = {};
  for (const k of ['k1', 'k2', 'k3', 'k4']) s[k] = [await p.open(k)];
  s.k2!.push(await p.open('k2'));
  await assert.rejects(p.open('k5'), isBusyProfiles);                  // 四个都有会话：busy，没停任何一个
  for (let i = 0; i < 4; i++) assert.equal(await seen.health(i), true);
  await sm.close({ session: s.k2![0]!.session });                                         // k2 还剩一个会话：不算空闲
  await assert.rejects(p.open('k5'), isBusyProfiles);
  await sm.close({ session: s.k2![1]!.session });                                         // k2 上没有会话了，但浏览器还开着
  assert.equal(await seen.health(1), true); assert.equal(sm.instanceState(), 'running');  // 不在关最后一个会话时立刻停
  const five = await p.open('k5');
  assert.equal(fake.launches, 5); assert.equal(fake.launched[4]?.name, 'k5');
  assert.deepEqual(await Promise.all([0, 1, 2, 3].map((i) => seen.health(i))), [true, false, true, true]);   // 被停的是 k2
  assert.ok(logs.some((l) => l.includes('profile k2') && l.includes('回收')));
  for (const k of ['k1', 'k3', 'k4']) assert.equal((await sm.step({ session: s[k]![0]!.session, ops: [{ op: 'snapshot' }] })).results[0]?.outcome, 'ok');
  assert.equal((await sm.step({ session: five.session, ops: [{ op: 'snapshot' }] })).results[0]?.outcome, 'ok');
  assert.deepEqual(sm.list().length, 4);
  await assert.rejects(p.open('k6'), isBusyProfiles);                  // 又满了、都有会话
  assert.equal(seen.peak(), 4);                                                           // 回收在启动之前，同时活着的从没超过 4 个
});

test('with several idle instances the one that was last used longest ago is reclaimed', async () => {
  const { sm, fake } = setupP();
  const seen = trackLive(fake); const p = onProfile(sm);
  const s: Record<string, { session: string }> = {};
  for (const k of ['k1', 'k2', 'k3', 'k4']) s[k] = await p.open(k);
  await closeAllOn(sm, [s.k3!, s.k1!, s.k4!]);                                            // 结束顺序：k3、k1、k4；k2 还有会话
  const k5 = await p.open('k5');
  assert.deepEqual(await Promise.all([0, 1, 2, 3].map((i) => seen.health(i))), [true, true, false, true]);   // 停的是 k3
  await sm.close({ session: s.k2!.session });                                             // 现在 k1、k4、k2 空闲，k1 最久
  await p.open('k6');
  assert.deepEqual(await Promise.all([0, 1, 2, 3, 4, 5].map((i) => seen.health(i))), [false, true, false, true, true, true]);
  assert.ok(k5.session);
  assert.equal(seen.peak(), 4);
});

test('an instance with a login page open is not idle; a login page that was closed makes it idle again', async () => {
  const { sm, fake } = setupP();
  const seen = trackLive(fake); const p = onProfile(sm);
  const s: { session: string }[] = [];
  for (const k of ['k1', 'k2', 'k3', 'k4']) s.push(await p.open(k));
  await closeAllOn(sm, s);                                                                // 四个都没有会话了
  const logins = [await p.loginBegin('k1'), await p.loginBegin('k2'), await p.loginBegin('k3')];
  await p.open('k5');                                                  // 只有 k4 空闲
  assert.deepEqual(await Promise.all([0, 1, 2, 3].map((i) => seen.health(i))), [true, true, true, false]);
  const l5 = await p.loginBegin('k5');
  assert.ok(l5.loginId);                                                                  // k5 有会话也有登录页
  await assert.rejects(p.open('k6'), isBusyProfiles);                  // k1 到 k3 有登录页、k5 有会话：没有空闲的
  await sm.loginEnd({ loginId: logins[1]!.loginId });                                     // k2 的登录页关了：它空闲
  await p.open('k6');
  assert.deepEqual(await Promise.all([0, 1, 2, 3, 4, 5].map((i) => seen.health(i))), [true, false, true, false, true, true]);
});

test('reclaiming waits for the stop: the limit is never exceeded, a third new profile cannot slip past, and the reclaimed key itself can be reopened', async () => {
  const { sm, fake } = setupP();
  const seen = trackLive(fake, 60); const p = onProfile(sm);
  const s: { session: string }[] = [];
  for (const k of ['k1', 'k2', 'k3', 'k4']) s.push(await p.open(k));
  await closeAllOn(sm, s);
  // k5、k6 各回收一个空闲实例，k7 回收第三个；k1 在被回收时又来了自己的 key。同时活着的实例始终不超过 4 个。
  const r = await Promise.allSettled([p.open('k5'), p.open('k6'), p.open('k1'), p.open('k7')]);
  const ok = r.filter((x) => x.status === 'fulfilled').length;
  assert.ok(seen.peak() <= 4, `peak ${seen.peak()}`);
  assert.equal(ok + r.filter((x) => x.status === 'rejected' && isBusyProfiles(x.reason)).length, 4);   // 成功或 busy，没有别的错
  assert.equal(r[0]?.status, 'fulfilled');
  assert.ok(sm.list().length === ok && ok >= 2);
  for (const x of sm.list()) assert.equal((await sm.step({ session: x.session, ops: [{ op: 'snapshot' }] })).results[0]?.outcome, 'ok');
});

test('an invalid profile key is a usage error even when four profiles are running, and it takes no slot', async () => {
  const { sm, fake } = setupP();
  const p = onProfile(sm);
  for (const k of ['k1', 'k2', 'k3', 'k4']) await p.open(k);
  for (const bad of ['../x', 'Admin', 'a/b', '', 'a@b@c']) {
    await assert.rejects(sm.open({ url: HOME_URL, profile: bad }), (e: E2kError) => e.code === 'usage', JSON.stringify(bad));
    await assert.rejects(sm.loginBegin({ url: HOME_URL, profile: bad }), (e: E2kError) => e.code === 'usage', JSON.stringify(bad));
  }
  assert.equal(fake.launches, 4);
  assert.equal(sm.list().length, 4);
  await p.open('k1');                                                  // 已在跑的 key 照常
});

// ---- 按域名组选 profile、借用、跨组导航（M2b 任务 6） ----

const GROUP_RULES = {
  version: 1, rules: [{ match: 'a.example.com', mode: 'readonly' }], loginHosts: [],
  groups: [{ name: 'a', hosts: ['a.example.com'], loginHosts: ['sso.example.org'] }, { name: 'b', hosts: ['b.example.com'] }],
};
const A_URL = 'http://a.example.com/';
const B_URL = 'http://b.example.com/';
const OTHER_GROUP_SENTENCE = '这个域名属于组 b，当前 profile 是组 a 的。请用 --profile b 另开会话。';

// 真的规则解析器、批准记录和假驱动；规则经假对话框批准（和线上同一条路径：第一次 21，人点了以后重试）。
async function setupGroups(rules: unknown = GROUP_RULES) {
  const dialog = fakeDialog(approving);
  const g = setupGate(dialog, rules);
  await assert.rejects(g.sm.loginBegin({ url: LOGIN_URL }), isCode('wait-approval'));
  await settleDialog();
  const { loginId } = await g.sm.loginBegin({ url: LOGIN_URL });   // 重试：批准落盘，规则生效
  await g.sm.loginEnd({ loginId });
  assert.equal(g.modes.state().pending, null);
  return { ...g, dialog };
}

const topNav = (fake: FakeDriver, pageId: string, url: string, method = 'GET', initiatorUrl?: string | null) =>
  fake.emitRequest({ id: `g${++navSeq}`, pageId, method, url, topUrl: url, isNavigation: true, topFrame: true,
    ...(initiatorUrl === undefined ? {} : { initiatorUrl }), ...(method === 'POST' ? { contentType: 'application/x-www-form-urlencoded', body: 'x=1' } : {}) });

const sessionGroup = (sm: SessionManager, id: string): unknown => (inner(sm, id) as unknown as { group: unknown }).group;

test('open without --profile uses the group of the domain (default for an unlisted host); a slot is fine on the group\'s own domain', async () => {
  const { sm, fake } = await setupGroups();
  const plain = await sm.open({ url: A_URL });
  assert.deepEqual([plain.profile, plain.borrowed], ['a', false]);
  const slot = await sm.open({ url: A_URL, profile: 'a/t1' });
  assert.deepEqual([slot.profile, slot.borrowed], ['a@t1', false]);
  assert.deepEqual([(await sm.open({ url: A_URL, profile: 'a' })).profile], ['a']);
  const local = await sm.open({ url: HOME_URL });
  assert.deepEqual([local.profile, local.borrowed], ['default', false]);
  const own = await sm.open({ url: HOME_URL, profile: 'default' });
  assert.deepEqual([own.profile, own.borrowed], ['default', false]);
  assert.deepEqual(fake.launched.map((l) => l.name), ['default', 'a', 'a@t1']);   // default 在登录批准时已经启动
  const result = readResult((await sm.close({ session: slot.session })).runDir);
  assert.deepEqual([result.start.profile, result.start.borrowed], ['a@t1', false]);
});

test('a profile that does not fit the domain is a usage error and starts nothing: another group, a group that does not exist, a slot on an unlisted host, default on a group domain', async () => {
  const { sm, fake } = await setupGroups();
  const launches = fake.launches;
  const usage = (m: RegExp) => (e: unknown): boolean => e instanceof E2kError && e.code === 'usage' && m.test(e.message);
  await assert.rejects(sm.open({ url: A_URL, profile: 'b' }), usage(/属于组 a，不能用组 b 的 profile/));
  await assert.rejects(sm.open({ url: A_URL, profile: 'b/t1' }), usage(/属于组 a，不能用组 b/));
  await assert.rejects(sm.open({ url: A_URL, profile: 'nope' }), usage(/没有这个组/));
  await assert.rejects(sm.open({ url: HOME_URL, profile: 'nope' }), usage(/没有这个组/));
  await assert.rejects(sm.open({ url: HOME_URL, profile: 'a/t1' }), usage(/槽只能用在本组的域名上/));
  await assert.rejects(sm.open({ url: A_URL, profile: 'default' }), usage(/属于组 a，不能用组 default/));
  await assert.rejects(sm.loginBegin({ url: A_URL, profile: 'b' }), usage(/属于组 a，不能用组 b/));
  await assert.rejects(sm.loginBegin({ url: HOME_URL, profile: 'a/t1' }), usage(/槽只能用在本组的域名上/));
  assert.equal(fake.launches, launches); assert.deepEqual(sm.list(), []); assert.deepEqual(fake.openPages(), []);
});

test('an unlisted host can borrow a group\'s login: borrowed is reported and recorded, the profile is the group\'s, and a login window borrows the same way', async () => {
  const { sm, fake, home } = await setupGroups();
  const r = await sm.open({ url: HOME_URL, profile: 'a' });
  assert.deepEqual([r.profile, r.borrowed], ['a', true]);
  assert.equal(fake.launched.at(-1)?.name, 'a');
  const out = readResult((await sm.close({ session: r.session })).runDir);
  assert.deepEqual([out.start.profile, out.start.borrowed], ['a', true]);
  const { loginId } = await sm.loginBegin({ url: LOGIN_URL, profile: 'a' });
  assert.equal(fake.launched.length, 2);                                      // 借用的登录也在 a 的实例里（default、a）
  await sm.loginEnd({ loginId });
  assert.equal(profileInfo(home, 'a').lastLogin?.host, 'localhost');
});

test('a borrowed session judges a write sent to the borrowed group by the stricter mode; an ordinary default session and other hosts are not affected', async () => {
  const { sm, fake } = await setupGroups();
  const borrowed = await sm.open({ url: HOME_URL, profile: 'a', name: 'bor' }); const borrowedPage = fake.openPages().at(-1)!;
  const post = (pageId: string, url: string) => fake.emitRequest({ id: `w${++navSeq}`, pageId, method: 'POST', url, topUrl: HOME_URL, body: '{}', contentType: 'application/json' });
  const blocked = await post(borrowedPage, 'http://a.example.com/api');
  assert.equal(blocked.action, 'fulfill'); assert.equal((blocked as { status: number }).status, 403);
  assert.equal((await post(borrowedPage, 'http://localhost:5173/api')).action, 'continue');       // 本地页面自己的写：默认模式
  assert.equal((await post(borrowedPage, 'http://b.example.com/api')).action, 'continue');        // 不是被借组的主机
  assert.equal((await fake.emitRequest({ pageId: borrowedPage, method: 'GET', url: 'http://a.example.com/data', topUrl: HOME_URL })).action, 'continue');   // 读照常
  const w = readResult((await sm.close({ session: borrowed.session })).runDir).writes;
  assert.deepEqual(w.blocked.map((x) => [x.host, x.reason, x.mode, x.targetMode]), [['a.example.com', 'method', 'readonly', 'readonly']]);
  const plain = await sm.open({ url: HOME_URL, name: 'plain' }); const plainPage = fake.openPages().at(-1)!;
  assert.equal((await post(plainPage, 'http://a.example.com/api')).action, 'continue');           // 没借用：照旧放行，只记录 targetMode
  await sm.close({ session: plain.session });
});

test('a group session cannot navigate to another group: main page and popup get a 403 page, it is recorded as other-group, and the next step says so; unlisted hosts pass', async () => {
  const { sm, fake } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  const during = sm.step({ session: a.session, ops: [{ op: 'wait', for: { ms: 100 } }] });
  await sleep(10);
  const main = await topNav(fake, pageId, B_URL);
  assert.deepEqual([main.action, (main as { status: number }).status, (main as { contentType: string }).contentType], ['fulfill', 403, 'text/html; charset=utf-8']);
  assert.ok((main as { body: string }).body.includes(OTHER_GROUP_SENTENCE) && (main as { body: string }).body.includes('b.example.com'));
  const popup = fake.emitPopup(pageId, 'about:blank');
  assert.equal((await topNav(fake, popup.id, 'http://b.example.com/x', 'POST')).action, 'fulfill');   // 弹窗里的导航也拦（含表单 POST）
  const st = await during;
  assert.deepEqual(st.notices, [OTHER_GROUP_SENTENCE]);                                          // 去重；不是只读模式拦的，不报「只读模式」
  assert.equal(st.writesBlocked, 2);
  assert.deepEqual(await topNav(fake, pageId, 'http://sso.example.org/'), { action: 'continue' });   // 没编组的主机放行
  assert.deepEqual(await topNav(fake, pageId, A_URL + 'next'), { action: 'continue' });             // 本组自己的
  assert.deepEqual([inner(sm, a.session).topHost, inner(sm, a.session).pendingHosts.size > 0], ['a.example.com', true]);   // 被拦的导航没改主机，放行的 sso 是待定
  const again = await sm.step({ session: a.session, ops: [{ op: 'snapshot' }] });
  assert.deepEqual(again.notices, []);                                                           // 提示过就不重复
  const closed = await sm.close({ session: a.session });
  const res = readResult(closed.runDir);
  assert.deepEqual(res.writes.blocked.map((w) => [w.method, w.host, w.reason, w.decision]), [['GET', 'b.example.com', 'other-group', 'blocked'], ['POST', 'b.example.com', 'other-group', 'blocked']]);
  assert.deepEqual(res.writes.blockedSummary.map((r) => [r.host, r.method, r.reason, r.count]), [['b.example.com', 'GET', 'other-group', 1], ['b.example.com', 'POST', 'other-group', 1]]);
  assert.ok(!res.hosts.some((h) => h.host === 'b.example.com'));                                  // 没到过
  assert.ok(readFileSync(closed.reportPath, 'utf8').includes('跨组导航'));
});

test('a default-group session cannot navigate into a group either; subresources, iframes and non-navigation requests are not judged by group', async () => {
  const { sm, fake } = await setupGroups();
  const d = await sm.open({ url: HOME_URL }); const pageId = fake.openPages().at(-1)!;
  assert.equal((await topNav(fake, pageId, A_URL)).action, 'fulfill');
  assert.equal((await topNav(fake, pageId, B_URL, 'POST')).action, 'fulfill');
  assert.deepEqual(await topNav(fake, pageId, 'http://sso.example.org/'), { action: 'continue' });
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'GET', url: B_URL + 'app.js', topUrl: HOME_URL }), { action: 'continue' });   // 子资源
  assert.deepEqual(await fake.emitRequest({ pageId, method: 'GET', url: B_URL + 'frame', topUrl: HOME_URL, isNavigation: true, topFrame: false }), { action: 'continue' });   // iframe
  const res = readResult((await sm.close({ session: d.session })).runDir);
  assert.deepEqual(res.writes.blocked.map((w) => [w.host, w.reason]), [['a.example.com', 'other-group'], ['b.example.com', 'other-group']]);
});

test('a login window: navigation to another group is refused even from a login host page (the exemption does not apply), and counts in writesBlocked and the log', async () => {
  const { sm, fake, logs, home } = await setupGroups();
  const { loginId } = await sm.loginBegin({ url: A_URL + 'login' }); const loginPageId = fake.openPages().at(-1)!;
  assert.deepEqual(await topNav(fake, loginPageId, 'http://sso.example.org/', 'GET', A_URL + 'login'), { action: 'continue' });   // a 的 loginHost
  assert.equal((await fake.emitRequest({ id: `e${++navSeq}`, pageId: loginPageId, method: 'GET', url: 'http://sso.example.org/app.js', topUrl: 'http://sso.example.org/' })).action, 'continue');   // 页面提交在 sso 上
  assert.deepEqual(await topNav(fake, loginPageId, A_URL + 'acs', 'POST', 'http://sso.example.org/'), { action: 'continue' });   // 回调回本组：照常
  const blocked = await topNav(fake, loginPageId, B_URL + 'acs', 'POST', 'http://sso.example.org/');
  assert.deepEqual([blocked.action, (blocked as { status: number }).status], ['fulfill', 403]);
  assert.ok((blocked as { body: string }).body.includes(OTHER_GROUP_SENTENCE));
  const popup = fake.emitPopup(loginPageId, 'about:blank');
  assert.equal((await topNav(fake, popup.id, B_URL, 'GET', null)).action, 'fulfill');            // 弹窗一样
  assert.deepEqual(logs.filter((l) => l.includes(loginId)), [`登录 ${loginId}：拦下跨组导航 b.example.com`, `登录 ${loginId}：拦下跨组导航 b.example.com`]);
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 2, crossGroupBlocked: 2 });   // writesBlocked 含跨组的；crossGroupBlocked 是其中的次数
  assert.equal(profileInfo(home, 'a').lastLogin?.host, 'a.example.com');
});

test('a default-group login window cannot enter a group either, and a borrowed login window uses the borrowed group\'s loginHosts and mode', async () => {
  const { sm, fake } = await setupGroups();
  const plain = await sm.loginBegin({ url: LOGIN_URL }); const plainPage = fake.openPages().at(-1)!;
  assert.equal((await topNav(fake, plainPage, A_URL, 'GET', LOGIN_URL)).action, 'fulfill');
  assert.deepEqual(await sm.loginEnd({ loginId: plain.loginId }), { writesBlocked: 1, crossGroupBlocked: 1 });
  const borrowed = await sm.loginBegin({ url: LOGIN_URL, profile: 'a' }); const page = fake.openPages().at(-1)!;
  assert.deepEqual(await topNav(fake, page, 'http://sso.example.org/', 'GET', LOGIN_URL), { action: 'continue' });   // a 的 loginHost：借用的登录按 a 查
  assert.equal((await fake.emitRequest({ id: `e${++navSeq}`, pageId: page, method: 'POST', url: 'http://a.example.com/api', topUrl: LOGIN_URL, body: '{}', contentType: 'application/json' })).action, 'fulfill');   // 发往 a 的写按 a 的只读
  assert.equal((await fake.emitRequest({ id: `e${++navSeq}`, pageId: page, method: 'POST', url: 'http://localhost:5173/api', topUrl: LOGIN_URL, body: '{}', contentType: 'application/json' })).action, 'continue');
  assert.deepEqual(await sm.loginEnd({ loginId: borrowed.loginId }), { writesBlocked: 1 });
});

test('a bad profile argument is refused before the rules dialog: no approval box for it, nothing started', async () => {
  const dialog = fakeDialog(approving);
  const { sm, fake } = setupGate(dialog);                                                        // rules.json 有未批准的改动
  for (const bad of ['Admin', 'a/b/c', '', '../x', 'a@b', 'a'.repeat(33)]) {
    await assert.rejects(sm.open({ url: RO, profile: bad }), isCode('usage'), JSON.stringify(bad));
    await assert.rejects(sm.loginBegin({ url: LOGIN_URL, profile: bad }), isCode('usage'), JSON.stringify(bad));
  }
  await settleDialog();
  assert.equal(dialog.requests.length, 0); assert.equal(fake.launches, 0); assert.deepEqual(fake.openPages(), []);
  // 写法对的，闸门照常先问：组存不存在要等批准之后才看（待批的组不算数）。
  await assert.rejects(sm.open({ url: RO, profile: 'nope' }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 1);
  await assert.rejects(sm.open({ url: RO, profile: 'nope' }), (e: unknown) => e instanceof E2kError && e.code === 'usage' && e.message === '没有这个组');
  assert.equal(fake.launches, 0);
});

test('the session keeps its group by name: rules that move the group\'s hosts (approved later) do not change what an open session is bound to', async () => {
  const { sm, fake, home, modes, dialog } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  assert.equal(sessionGroup(sm, a.session), 'a');
  const moved = { ...GROUP_RULES, groups: [{ name: 'a', hosts: ['a2.example.com'], loginHosts: ['sso.example.org'] }, { name: 'b', hosts: ['b.example.com'] }] };
  writeRules(home, moved);
  await assert.rejects(sm.open({ url: HOME_URL }), isCode('wait-approval'));
  await settleDialog();
  assert.equal((await sm.open({ url: HOME_URL })).profile, 'default');                          // 批准了：快照换成新的
  assert.deepEqual(modes.group('a')?.hosts, ['a2.example.com']); assert.equal(dialog.requests.length, 2);
  assert.equal(sessionGroup(sm, a.session), 'a');                                                // 会话存的是名字，不是组对象
  assert.deepEqual(await topNav(fake, pageId, 'http://a2.example.com/'), { action: 'continue' });   // 现在属于 a 的主机
  assert.deepEqual(await topNav(fake, pageId, A_URL), { action: 'continue' });                   // 不再编组
  const blocked = await topNav(fake, pageId, B_URL);
  assert.equal(blocked.action, 'fulfill');
  assert.ok((blocked as { body: string }).body.includes(OTHER_GROUP_SENTENCE));
  // 调用方改写 modes.group() / groupOf() 拿到的对象：快照是冻住的，改不动（严格模式下抛错），之后跳到 b 仍被拦。
  const group = modes.group('b')!;
  assert.throws(() => { group.hosts.length = 0; }, TypeError);
  assert.throws(() => { group.hosts.push('c.example.com'); }, TypeError);
  assert.throws(() => { (group as { name: string }).name = 'a'; }, TypeError);
  assert.throws(() => { modes.groupOf('b.example.com').loginHosts.push('x.example.org'); }, TypeError);
  assert.throws(() => { modes.group('default')!.loginHosts.push('x.example.org'); }, TypeError);
  assert.deepEqual([modes.group('b')?.hosts, modes.isLoginHost('x.example.org', 'b')], [['b.example.com'], false]);
  assert.equal(sessionGroup(sm, a.session), 'a');
  assert.equal((await topNav(fake, pageId, B_URL + 'again')).action, 'fulfill');
});

// 本组登录态下、顶层不在本组的页面发往本组的写，按目标主机的模式判：不论 open 时是不是借用（M2b 任务 6 修复轮 1）。
const BYPASS_RULES = { ...GROUP_RULES, groups: [{ name: 'a', hosts: ['a.example.com', 'w.example.com'], loginHosts: ['sso.example.org'] }, { name: 'b', hosts: ['b.example.com'] }] };
const W_URL = 'http://w.example.com/';
const apiPost = (fake: FakeDriver, pageId: string, url: string, topUrl: string) =>
  fake.emitRequest({ id: `w${++navSeq}`, pageId, method: 'POST', url, topUrl, body: '{}', contentType: 'application/json' });

test('a group session that left the group for an unlisted host cannot write to the read-only group host from there; on a group host it is judged as before', async () => {
  const { sm, fake } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  assert.equal(a.borrowed, false);
  assert.equal((await apiPost(fake, pageId, A_URL + 'api', A_URL)).action, 'fulfill');            // 在本组的只读主机上：组 a 自己的模式
  assert.deepEqual(await topNav(fake, pageId, HOME_URL), { action: 'continue' });                 // 跳到没编组的主机
  await fake.emitRequest({ id: `c${++navSeq}`, pageId, method: 'GET', url: HOME_URL + 'app.js', topUrl: HOME_URL });   // 页面提交在那里
  assert.equal(inner(sm, a.session).topHost, 'localhost');
  const bypass = await apiPost(fake, pageId, 'http://a.example.com/api', HOME_URL);
  assert.deepEqual([bypass.action, (bypass as { status: number }).status], ['fulfill', 403]);     // 绕过路径被拦
  assert.equal((await apiPost(fake, pageId, HOME_URL + 'api', HOME_URL)).action, 'continue');     // 本地主机自己的写：默认模式，不受影响
  const w = readResult((await sm.close({ session: a.session })).runDir).writes;
  assert.ok(w.blocked.some((x) => x.host === 'a.example.com' && x.reason === 'method' && x.mode === 'readonly' && x.targetMode === 'readonly'));
});

test('a group session on a default-mode group host still writes to the read-only host of its own group (as before); after leaving the group it cannot, and an unrelated host or group is unaffected', async () => {
  const { sm, fake } = await setupGroups(BYPASS_RULES);
  const s = await sm.open({ url: W_URL }); const pageId = fake.openPages().at(-1)!;
  assert.equal((await apiPost(fake, pageId, 'http://a.example.com/api', W_URL)).action, 'continue');   // 页面在本组的默认模式主机上：不被误伤
  await topNav(fake, pageId, HOME_URL);
  await fake.emitRequest({ id: `c${++navSeq}`, pageId, method: 'GET', url: HOME_URL + 'app.js', topUrl: HOME_URL });
  assert.equal((await apiPost(fake, pageId, 'http://a.example.com/api', HOME_URL)).action, 'fulfill');   // 离开本组之后：按 a.example.com 的只读判
  assert.equal((await apiPost(fake, pageId, 'http://w.example.com/api', HOME_URL)).action, 'continue');   // 本组但默认模式的主机
  assert.equal((await apiPost(fake, pageId, 'http://b.example.com/api', HOME_URL)).action, 'continue');   // 别的组的主机：不归这个 profile 管
  await sm.close({ session: s.session });
});

test('a login window of a group is bound the same way: from a default-mode group page a write to the read-only group host passes, from a page outside the group it does not', async () => {
  const { sm, fake } = await setupGroups(BYPASS_RULES);
  const { loginId } = await sm.loginBegin({ url: W_URL + 'login' }); const pageId = fake.openPages().at(-1)!;
  assert.equal((await apiPost(fake, pageId, 'http://a.example.com/api', W_URL)).action, 'continue');
  await topNav(fake, pageId, HOME_URL + 'login', 'GET', W_URL);
  await fake.emitRequest({ id: `c${++navSeq}`, pageId, method: 'GET', url: HOME_URL + 'app.js', topUrl: HOME_URL + 'login' });
  assert.equal((await apiPost(fake, pageId, 'http://a.example.com/api', HOME_URL + 'login')).action, 'fulfill');
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 1 });
});

// ---- 重定向进了别的组的域名：冻结（M2b 任务 7） ----

const FROZEN_STEP_ERROR = (e: unknown): boolean => e instanceof E2kError && e.code === 'needs-human'
  && e.message === '页面经重定向进了组 b 的域名，会话已冻结' && e.next === '关掉这个会话，用 --profile b 另开';
const instanceOf = (fake: FakeDriver, name: string): number => fake.launched.findIndex((l) => l.name === name);
const pageCalls = (fake: FakeDriver, pageId: string): number => fake.calls.filter((c) => c.pageId === pageId).length;

test('a hop of the session page into another group freezes it: every page and every request (GET too) gets 403, step does nothing and says needs-human, cookies of that hop host are cleared on that instance only', async () => {
  const { sm, fake } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  const other = await sm.open({ url: A_URL, name: 'same-instance' }); const otherPage = fake.openPages().at(-1)!;   // 同一个实例（组 a）上的另一个会话
  const plain = await sm.open({ url: HOME_URL, name: 'plain' }); const plainPage = fake.openPages().at(-1)!;      // 另一个实例（default）
  const popup = fake.emitPopup(pageId, 'about:blank');
  assert.equal((await fake.emitRequest({ pageId, method: 'GET', url: A_URL + 'app.js', topUrl: A_URL })).action, 'continue');   // 冻结之前照常
  const calls = pageCalls(fake, pageId);
  fake.emitHop(pageId, B_URL + 'landing');
  const blocked = [
    await fake.emitRequest({ pageId, method: 'GET', url: A_URL + 'app.js', topUrl: A_URL }),                              // 子资源
    await topNav(fake, pageId, A_URL + 'next'),                                                                           // 本组自己的导航也不行
    await topNav(fake, pageId, 'http://sso.example.org/'),                                                                // 没编组的主机也不行
    await fake.emitRequest({ pageId: popup.id, method: 'GET', url: A_URL + 'x', topUrl: A_URL }),                         // 弹窗
    await fake.emitRequest({ pageId, method: 'POST', url: A_URL + 'api', topUrl: A_URL, body: '{}', contentType: 'application/json' }),
  ];
  for (const d of blocked) assert.deepEqual([d.action, (d as { status: number }).status], ['fulfill', 403]);
  assert.equal((blocked[1] as { contentType: string }).contentType, 'text/html; charset=utf-8');
  assert.ok((blocked[1] as { body: string }).body.includes('会话已冻结：页面经重定向进了组 b 的域名'));
  assert.equal((blocked[0] as { contentType: string }).contentType, 'application/json');
  await assert.rejects(sm.step({ session: a.session, ops: [{ op: 'snapshot' }, { op: 'click', target: 'e2' }] }), FROZEN_STEP_ERROR);
  assert.equal(pageCalls(fake, pageId), calls);                                                                           // 一个操作都没执行，连读数都没有
  // 别的会话不受影响：同实例的、别的实例的
  assert.equal((await fake.emitRequest({ pageId: otherPage, method: 'GET', url: A_URL + 'app.js', topUrl: A_URL })).action, 'continue');
  assert.equal((await sm.step({ session: other.session, ops: [{ op: 'snapshot' }] })).exit, 0);
  assert.equal((await fake.emitRequest({ pageId: plainPage, method: 'GET', url: HOME_URL + 'app.js', topUrl: HOME_URL })).action, 'continue');
  assert.equal((await sm.step({ session: plain.session, ops: [{ op: 'snapshot' }] })).exit, 0);
  // clearCookies 只对 b 这一跳的主机、只在 a 的实例上调
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), ['b.example.com']);
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'default')), []);
  // 收尾：会话可以关；页都关了以后再清一遍；记录里有 other-group（跳那一下和冻结后被拦的请求）
  const closed = await sm.close({ session: a.session });
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), ['b.example.com', 'b.example.com']);
  const res = readResult(closed.runDir);
  assert.ok(res.writes.blocked.length >= 1 && res.writes.blocked.every((w) => w.reason === 'other-group' && w.decision === 'blocked'));
  assert.ok(res.writes.blocked.some((w) => w.host === 'b.example.com' && w.method === 'GET'));                              // 那一跳
  assert.ok(res.writes.blocked.some((w) => w.host === 'a.example.com' && w.method === 'POST'));                             // 冻结后的写
  assert.ok(res.writes.blockedSummary.every((r) => r.reason === 'other-group'));
  assert.deepEqual(res.frozen, { group: 'b', host: 'b.example.com' });   // 冻结写进报告：组和第一跳的主机
  assert.ok(readFileSync(closed.reportPath, 'utf8').includes('<h3>冻结</h3>'));
  assert.ok(!res.hosts.some((h) => h.host === 'b.example.com'));                                                            // 没算「到过」
  for (const s2 of [other, plain]) assert.equal(readResult((await sm.close({ session: s2.session })).runDir).frozen, null);   // 没冻结的会话是 null
});

test('every hop of the chain is checked: unlisted hosts and the own group pass, a later hop into another group freezes; a default-group session is frozen by a hop into a group', async () => {
  const { sm, fake } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  fake.emitHop(pageId, 'http://sso.example.org/'); fake.emitHop(pageId, A_URL + 'back'); fake.emitHop(pageId, 'about:blank');   // 没编组、本组、不是 http(s)
  assert.equal((await fake.emitRequest({ pageId, method: 'GET', url: A_URL + 'app.js', topUrl: A_URL })).action, 'continue');
  assert.equal((await sm.step({ session: a.session, ops: [{ op: 'snapshot' }] })).exit, 0);
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), []);
  fake.emitHop(pageId, B_URL + 'hop2');                                                                                       // 链上的第三跳进了 b
  await assert.rejects(sm.step({ session: a.session, ops: [{ op: 'snapshot' }] }), FROZEN_STEP_ERROR);
  fake.emitHop(pageId, 'http://b.example.com:8080/other');                                                                   // 冻结之后的跳：不换组，主机相同（带端口不影响 cookie 的主机）
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), ['b.example.com', 'b.example.com']);
  await sm.close({ session: a.session });
  const d = await sm.open({ url: HOME_URL, name: 'dflt' }); const dPage = fake.openPages().at(-1)!;
  fake.emitHop(dPage, A_URL + 'x');                                                                                           // default 组的会话被带进组 a
  await assert.rejects(sm.step({ session: d.session, ops: [{ op: 'snapshot' }] }),
    (e: unknown) => e instanceof E2kError && e.code === 'needs-human' && e.message === '页面经重定向进了组 a 的域名，会话已冻结' && e.next === '关掉这个会话，用 --profile a 另开');
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'default')), ['a.example.com']);
  await sm.close({ session: d.session });
});

test('a hop that arrives while step is running stops the rest of the batch (not-run), step answers needs-human, and the report keeps what ran', async () => {
  const { sm, fake } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  const during = sm.step({ session: a.session, ops: [{ op: 'wait', for: { ms: 80 } }, { op: 'snapshot' }, { op: 'snapshot' }] });
  await sleep(10);
  fake.emitHop(pageId, B_URL);
  await assert.rejects(during, FROZEN_STEP_ERROR);
  const res = readResult((await sm.close({ session: a.session })).runDir);
  assert.deepEqual(res.actions.map((x) => [x.op.op, x.outcome]), [['wait', 'ok'], ['snapshot', 'not-run'], ['snapshot', 'not-run']]);
  assert.ok(res.writes.blocked.some((w) => w.reason === 'other-group' && w.host === 'b.example.com'));
});

test('fallback: page evidence in another group freezes too (followTopHost after open and after step, and a request of the main page whose top page is there); a refused first-hop navigation does not', async () => {
  const { sm, fake } = await setupGroups();
  fake.definePage(A_URL + 'bounce', { redirectTo: B_URL + 'landed' });
  fake.definePage(A_URL + 'bounce2', { redirectTo: B_URL });                                                                  // 和下面被拦的地址一样
  // open 时页面落在 b：不交出快照，会话撤销、页关掉，报和 step 同一个错；页关了以后再清一遍 cookie
  await assert.rejects(sm.open({ url: A_URL + 'bounce', name: 'on-open' }), FROZEN_STEP_ERROR);
  assert.deepEqual(sm.list(), []); assert.deepEqual(fake.openPages(), []);
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), ['b.example.com', 'b.example.com']);
  // step 里的 goto 落在 b：这一批的操作做完了，step 报 needs-human
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  await assert.rejects(sm.step({ session: a.session, ops: [{ op: 'goto', url: A_URL + 'bounce' }] }), FROZEN_STEP_ERROR);
  assert.equal((await fake.emitRequest({ pageId, method: 'GET', url: A_URL + 'app.js', topUrl: A_URL })).action, 'fulfill');
  const res = readResult((await sm.close({ session: a.session })).runDir);
  assert.deepEqual(res.actions.map((x) => [x.op.op, x.outcome]), [['goto', 'ok']]);
  // 主页面的非导航请求带着的顶层地址在 b：冻结，这个请求也不放行
  const c = await sm.open({ url: A_URL, name: 'by-request' }); const cPage = fake.openPages().at(-1)!;
  const r = await fake.emitRequest({ pageId: cPage, method: 'GET', url: B_URL + 'app.js', topUrl: B_URL });
  assert.deepEqual([r.action, (r as { status: number }).status], ['fulfill', 403]);
  await assert.rejects(sm.step({ session: c.session, ops: [{ op: 'snapshot' }] }), FROZEN_STEP_ERROR);
  await sm.close({ session: c.session });
  // 弹窗里的重定向驱动认不出归属（没有跳事件）：弹窗之后的请求带着的顶层地址在 b，同样冻结
  const p = await sm.open({ url: A_URL, name: 'by-popup' }); const pPage = fake.openPages().at(-1)!;
  const pop = fake.emitPopup(pPage, 'about:blank');
  const popReq = await fake.emitRequest({ pageId: pop.id, method: 'GET', url: B_URL + 'app.js', topUrl: B_URL });
  assert.deepEqual([popReq.action, (popReq as { status: number }).status], ['fulfill', 403]);
  await assert.rejects(sm.step({ session: p.session, ops: [{ op: 'snapshot' }] }), FROZEN_STEP_ERROR);
  await sm.close({ session: p.session });
  // 发起页（已提交的页面）的地址在 b 的主页面导航：冻结
  const d = await sm.open({ url: A_URL, name: 'by-initiator' }); const dPage = fake.openPages().at(-1)!;
  assert.equal((await topNav(fake, dPage, A_URL + 'x', 'GET', B_URL + 'was-here')).action, 'fulfill');
  await assert.rejects(sm.step({ session: d.session, ops: [{ op: 'snapshot' }] }), FROZEN_STEP_ERROR);
  await sm.close({ session: d.session });
  // 对照：内核自己拦下的跨组导航，页面停在那张 403 页上（地址在 b）：不算被重定向带进去的，不冻结，会话照常（# 不影响比较）
  const e = await sm.open({ url: A_URL, name: 'refused' }); const ePage = fake.openPages().at(-1)!;
  assert.equal((await topNav(fake, ePage, B_URL)).action, 'fulfill');
  assert.equal((await topNav(fake, ePage, A_URL + 'x', 'GET', B_URL + '#frag')).action, 'continue');                          // 发起页停在被拦的 b 页上
  assert.equal((await sm.step({ session: e.session, ops: [{ op: 'goto', url: A_URL + 'bounce2' }] })).exit, 0);               // 页面地址落在被拦过的 b 地址
  assert.equal((await fake.emitRequest({ pageId: ePage, method: 'GET', url: A_URL + 'app.js', topUrl: A_URL })).action, 'continue');
  await assert.rejects(sm.step({ session: e.session, ops: [{ op: 'goto', url: A_URL + 'bounce' }] }), FROZEN_STEP_ERROR);     // 没被拦过的 b 地址：冻结
  await sm.close({ session: e.session });
});

test('a hop whose group cannot be judged freezes the session too (fail closed): step says needs-human, nothing is cleared', async () => {
  const { sm, fake, modes } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  const real = modes.groupOf.bind(modes);
  modes.groupOf = () => { throw new Error('boom'); };
  fake.emitHop(pageId, B_URL);
  modes.groupOf = real;
  await assert.rejects(sm.step({ session: a.session, ops: [{ op: 'snapshot' }] }),
    (e: unknown) => e instanceof E2kError && e.code === 'needs-human' && e.message.includes('判断不出归属') && e.next === '关掉这个会话，重新开');
  const d = await fake.emitRequest({ pageId, method: 'GET', url: A_URL + 'app.js', topUrl: A_URL });
  assert.equal((d as { status: number }).status, 403);
  assert.ok(((await topNav(fake, pageId, A_URL)) as { body: string }).body.includes('判断不出归属'));
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), ['b.example.com']);                                              // 主机认得出，只是组判断不出
  await sm.close({ session: a.session });
});

test('a hop of an unknown page is ignored; a failing clearCookies is logged and does not stop the freeze', async () => {
  const { sm, fake, logs } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  fake.emitHop('p-unknown', B_URL);                                                                                           // 没有会话认领这一页
  assert.equal((await sm.step({ session: a.session, ops: [{ op: 'snapshot' }] })).exit, 0);
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), []);
  const inst = (fake as unknown as { instances: { clearCookies(h: string): Promise<void> }[] }).instances[instanceOf(fake, 'a')]!;
  inst.clearCookies = () => Promise.reject(new DriverError('other', 'cookie store is gone'));
  fake.emitHop(pageId, B_URL);
  await assert.rejects(sm.step({ session: a.session, ops: [{ op: 'snapshot' }] }), FROZEN_STEP_ERROR);
  assert.ok(logs.some((l) => l.includes(`会话 ${a.session}：清 b.example.com 的 cookie失败：other: cookie store is gone`)));
  await sm.close({ session: a.session });
});

test('a login window frozen by a hop into another group: all its requests are refused and counted in writesBlocked and crossGroupBlocked, cookies are cleared on its instance', async () => {
  const { sm, fake, logs } = await setupGroups();
  const { loginId } = await sm.loginBegin({ url: A_URL + 'login' }); const pageId = fake.openPages().at(-1)!;
  fake.emitHop(pageId, 'http://sso.example.org/');                                                                            // a 的 loginHost：不冻结
  assert.equal((await fake.emitRequest({ id: `e${++navSeq}`, pageId, method: 'GET', url: 'http://sso.example.org/app.js', topUrl: 'http://sso.example.org/' })).action, 'continue');
  fake.emitHop(pageId, B_URL + 'acs');
  const popup = fake.emitPopup(pageId, 'about:blank');
  const refused = [
    await fake.emitRequest({ id: `e${++navSeq}`, pageId, method: 'GET', url: 'http://sso.example.org/app.js', topUrl: 'http://sso.example.org/' }),   // loginHost 的豁免也不管用
    await fake.emitRequest({ id: `e${++navSeq}`, pageId: popup.id, method: 'GET', url: A_URL + 'x', topUrl: A_URL }),
    await topNav(fake, pageId, A_URL + 'acs', 'POST', 'http://sso.example.org/'),
  ];
  for (const d of refused) assert.deepEqual([d.action, (d as { status: number }).status], ['fulfill', 403]);
  assert.deepEqual(logs.filter((l) => l.includes(loginId)), [`登录 ${loginId}：页面经重定向进了组 b 的域名 b.example.com，已冻结`]);
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 4, crossGroupBlocked: 4 });                                // 跳 1 + 被拦的 3
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), ['b.example.com', 'b.example.com']);                              // 跳的时候一次，结束时一次
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'default')), []);
});

test('a login window that only hops through unlisted hosts or its own group is not frozen', async () => {
  const { sm, fake } = await setupGroups();
  const { loginId } = await sm.loginBegin({ url: A_URL + 'login' }); const pageId = fake.openPages().at(-1)!;
  fake.emitHop(pageId, 'http://sso.example.org/'); fake.emitHop(pageId, A_URL + 'acs');
  assert.equal((await topNav(fake, pageId, A_URL + 'acs', 'POST', 'http://sso.example.org/')).action, 'continue');
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 0 });
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), []);
});

// ---- 修复轮 1 ----

test('after a freeze, requests that no session or login owns (a popup\'s unattributed first navigation) get 403 on that instance only; before it, and on other instances, nothing changes', async () => {
  const { sm, fake } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  const plain = await sm.open({ url: HOME_URL, name: 'plain' });
  const ia = instanceOf(fake, 'a'); const idefault = instanceOf(fake, 'default');
  const orphan = (inst: number, url = 'http://sso.example.org/popup') => fake.emitRequest({ pageId: null, method: 'GET', url, topUrl: url, isNavigation: true, topFrame: true }, inst);
  assert.deepEqual(await orphan(ia), { action: 'continue' });                                                    // 没冻结：未归属分支不变
  assert.deepEqual(await orphan(idefault), { action: 'continue' });
  fake.emitHop(pageId, B_URL);
  const frozen = await orphan(ia);
  assert.deepEqual([frozen.action, (frozen as { status: number }).status, (frozen as { contentType: string }).contentType], ['fulfill', 403, 'text/html; charset=utf-8']);
  assert.ok((frozen as { body: string }).body.includes('会话已冻结：页面经重定向进了组 b 的域名'));
  const sub = await fake.emitRequest({ pageId: null, method: 'GET', url: 'http://sso.example.org/x.js', topUrl: null }, ia);
  assert.deepEqual([sub.action, (sub as { contentType: string }).contentType], ['fulfill', 'application/json']);
  assert.deepEqual(await orphan(idefault), { action: 'continue' });                                              // 别的实例照旧
  const res = readResult((await sm.close({ session: a.session })).runDir);
  assert.ok(res.writes.unattributed.some((w) => w.reason === 'other-group' && w.decision === 'blocked'));
  assert.deepEqual(await orphan(ia), { action: 'continue' });                                                    // 会话收尾以后不再冻结这个实例
  await sm.close({ session: plain.session });
});

test('a frozen login window freezes the unattributed requests of its instance too', async () => {
  const { sm, fake } = await setupGroups();
  const { loginId } = await sm.loginBegin({ url: A_URL + 'login' }); const pageId = fake.openPages().at(-1)!;
  fake.emitHop(pageId, B_URL);
  const d = await fake.emitRequest({ pageId: null, method: 'GET', url: 'http://sso.example.org/popup', topUrl: null, isNavigation: true, topFrame: true }, instanceOf(fake, 'a'));
  assert.equal((d as { status: number }).status, 403);
  await sm.loginEnd({ loginId });
});

test('login fallback: a popup whose first navigation could not be attributed and landed in another group freezes the login window at its next request; a refused first hop does not', async () => {
  const { sm, fake, logs } = await setupGroups();
  const { loginId } = await sm.loginBegin({ url: A_URL + 'login' }); const pageId = fake.openPages().at(-1)!;
  const popup = fake.emitPopup(pageId, 'about:blank');
  // 对照：内核自己拦下的跨组首跳，页面停在那张 403 页上，之后的请求带着 b 的地址：不冻结
  assert.equal((await topNav(fake, pageId, B_URL, 'GET', A_URL + 'login')).action, 'fulfill');
  assert.equal((await fake.emitRequest({ id: `e${++navSeq}`, pageId, method: 'GET', url: A_URL + 'x', topUrl: B_URL + '#frag' })).action, 'continue');
  assert.equal((await topNav(fake, pageId, A_URL + 'y', 'GET', B_URL + '#again')).action, 'continue');
  // 弹窗里的重定向落到 b（没有跳事件）：下一个请求带着 b 的顶层地址
  const hit = await fake.emitRequest({ id: `e${++navSeq}`, pageId: popup.id, method: 'GET', url: B_URL + 'app.js', topUrl: B_URL + 'landed' });
  assert.deepEqual([hit.action, (hit as { status: number }).status], ['fulfill', 403]);
  assert.equal((await fake.emitRequest({ id: `e${++navSeq}`, pageId, method: 'GET', url: A_URL + 'z', topUrl: A_URL + 'login' })).action, 'fulfill');
  assert.deepEqual(logs.filter((l) => l.includes('已冻结')), [`登录 ${loginId}：页面经重定向进了组 b 的域名 b.example.com，已冻结`]);
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 4, crossGroupBlocked: 4 });                    // 被拦的首跳 1 + 冻结这一下 1 + 触发冻结的请求 1 + 冻结后的请求 1
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), ['b.example.com', 'b.example.com']);              // 冻结时一次，结束时一次
});

test('login fallback by the initiator address of a top-level navigation', async () => {
  const { sm, fake } = await setupGroups();
  const { loginId } = await sm.loginBegin({ url: A_URL + 'login' }); const pageId = fake.openPages().at(-1)!;
  const d = await topNav(fake, pageId, A_URL + 'next', 'GET', B_URL + 'was-here');
  assert.equal((d as { status: number }).status, 403);
  assert.deepEqual(fake.clearedHosts(instanceOf(fake, 'a')), ['b.example.com']);
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 2, crossGroupBlocked: 2 });                    // 冻结这一下 1 + 触发冻结的请求 1
});

test('a login fallback that cannot judge the page address freezes too (fail closed)', async () => {
  const { sm, fake, modes } = await setupGroups();
  const { loginId } = await sm.loginBegin({ url: A_URL + 'login' }); const pageId = fake.openPages().at(-1)!;
  const real = modes.groupOf.bind(modes);
  modes.groupOf = () => { throw new Error('boom'); };
  const d = await fake.emitRequest({ id: `e${++navSeq}`, pageId, method: 'GET', url: A_URL + 'x', topUrl: B_URL });
  modes.groupOf = real;
  assert.equal((d as { status: number }).status, 403);
  assert.equal((await fake.emitRequest({ id: `e${++navSeq}`, pageId, method: 'GET', url: A_URL + 'y', topUrl: A_URL })).action, 'fulfill');
  await sm.loginEnd({ loginId });
});

test('step on a frozen session waits for the pending cookie clearing before it answers needs-human', async () => {
  const { sm, fake } = await setupGroups();
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  const inst = (fake as unknown as { instances: { clearCookies(h: string): Promise<void> }[] }).instances[instanceOf(fake, 'a')]!;
  let release!: () => void;
  inst.clearCookies = () => new Promise<void>((resolve) => { release = resolve; });
  fake.emitHop(pageId, B_URL);
  let settled = false;
  const step = sm.step({ session: a.session, ops: [{ op: 'snapshot' }] }).then(() => 'resolved', (e: unknown) => { settled = true; return e; });
  await sleep(30);
  assert.equal(settled, false);                                                                                  // 清理没完成：还在等
  release();
  assert.ok(FROZEN_STEP_ERROR(await step));
  inst.clearCookies = () => Promise.resolve();
  await sm.close({ session: a.session });
});

// ---- 组级白名单：读型 POST、持久化查询、登出（M2b 任务 8） ----
// 四条请求路径：会话页、会话弹窗（含首个导航）、登录页（含弹窗）、未归属请求。读型 POST 和持久化查询只在前三条里放行（未归属请求不放行任何白名单里的写）；
// 登出在四条里都拦（登录窗口是例外：允许登出，好换账号）。

const WL_HASH = 'c'.repeat(64);
const WL_OTHER_HASH = 'd'.repeat(64);
const WL_RULES = {
  version: 1, rules: [{ match: '*.example.com', mode: 'readonly' }], loginHosts: [],
  groups: [
    { name: 'a', hosts: ['a.example.com', 'api.example.com'], loginHosts: ['sso.example.org'],
      readPosts: [{ method: 'POST', url: 'http://api.example.com/v1/*/search' }],
      persistedQueries: [{ url: 'http://api.example.com/graphql', hashes: [WL_HASH] }],
      logout: [{ url: 'http://a.example.com/logout' }, { url: 'http://sso.example.org/logout' }] },
    { name: 'b', hosts: ['b.example.com'], logout: [{ url: 'http://b.example.com/logout' }] },   // 规则改动不能超过 12 行（框放不下）：b 不带读型 POST
  ],
};
const API_SEARCH = 'http://api.example.com/v1/t1/search';
const API_GRAPHQL = 'http://api.example.com/graphql';
const wlPq = (hash: string): string => JSON.stringify({ operationName: 'Q', variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } });
const wlReq = (fake: FakeDriver, pageId: string | null, method: string, url: string, topUrl: string | null, body: string | null = null, contentType: string | null = body === null ? null : 'application/json') =>
  fake.emitRequest({ id: `wl${++navSeq}`, pageId, method, url, topUrl, body, contentType });
const isFulfill403 = (d: { action: string }): boolean => d.action === 'fulfill' && (d as unknown as { status: number }).status === 403;
const NO_REDIRECT = { action: 'continue', followRedirects: false };

test('whitelist, session page: a read-POST and a persisted query go through without following redirects and are recorded with allowedBy; a mutation on the same url, a wrong hash and a query string are blocked', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  assert.equal(a.mode, 'readonly');
  const send = (method: string, url: string, body: string | null) => wlReq(fake, pageId, method, url, A_URL, body);
  assert.deepEqual(await send('POST', API_SEARCH, '{"term":"x"}'), NO_REDIRECT);
  assert.deepEqual(await send('POST', API_GRAPHQL, wlPq(WL_HASH)), NO_REDIRECT);
  assert.ok(isFulfill403(await send('POST', API_SEARCH, '{"query":"mutation{a}"}')));
  assert.ok(isFulfill403(await send('POST', API_SEARCH + '?x=1', '{"term":"x"}')));
  assert.ok(isFulfill403(await send('POST', API_GRAPHQL, wlPq(WL_OTHER_HASH))));
  assert.ok(isFulfill403(await send('POST', API_GRAPHQL, wlPq(WL_HASH).replace('"variables":{},', '"variables":{},"extra":1,'))));
  assert.ok(isFulfill403(await send('PUT', API_SEARCH, '{"term":"x"}')));
  assert.ok(isFulfill403(await send('POST', 'http://api.example.com/v1/t1/other', '{"term":"x"}')));
  assert.ok(isFulfill403(await send('POST', 'http://a.example.com/v1/t1/search', '{"term":"x"}')));          // 路径对、主机不在白名单里
  const res = readResult((await sm.close({ session: a.session })).runDir);
  assert.deepEqual(res.writes.allowed.map((w) => [w.url, w.allowedBy]), [[API_SEARCH, 'read-post'], [API_GRAPHQL, 'persisted-query']]);
  assert.deepEqual(res.writes.blocked.map((w) => w.reason), ['graphql-mutation', 'method', 'persisted-query', 'persisted-query', 'method', 'method', 'method']);
  assert.ok(res.writes.blocked.every((w) => w.allowedBy === undefined));
});

test('whitelist, session popup (also its first navigation): the popup is the session\'s page, so the same lists apply', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  const popup = fake.emitPopup(pageId, 'about:blank');
  assert.deepEqual(await wlReq(fake, popup.id, 'POST', API_SEARCH, A_URL, '{"term":"x"}'), NO_REDIRECT);
  assert.ok(isFulfill403(await wlReq(fake, popup.id, 'GET', 'http://a.example.com/logout', A_URL)));
  // 弹窗的第一个导航还认不出页面（pageId 为 null）：走未归属分支，同样拦登出（写不放行，见下面未归属的测试）
  const first = await fake.emitRequest({ id: `wl${++navSeq}`, pageId: null, openerPageId: pageId, method: 'GET', url: 'http://a.example.com/logout', topUrl: 'http://a.example.com/logout', isNavigation: true, topFrame: true });
  assert.ok(isFulfill403(first));
  const res = readResult((await sm.close({ session: a.session })).runDir);
  assert.deepEqual(res.writes.allowed.map((w) => w.allowedBy), ['read-post']);
  assert.deepEqual(res.writes.blocked.map((w) => w.reason), ['logout']);
  assert.deepEqual(res.writes.unattributed.map((w) => w.reason), ['logout']);
});

test('whitelist, group choice: only the target host\'s group counts for read-POSTs and persisted queries; logout is the session group\'s and the target group\'s together', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  const send = (method: string, url: string, body: string | null = null) => wlReq(fake, pageId, method, url, A_URL, body);
  assert.ok(isFulfill403(await send('POST', 'http://b.example.com/search', '{"term":"x"}')));                    // 目标主机在组 b：组 b 没有这条白名单
  assert.ok(isFulfill403(await send('POST', 'http://b.example.com/v1/t1/search', '{"term":"x"}')));              // a 的接口路径套不到 b 的主机上
  assert.ok(isFulfill403(await send('POST', 'http://sso.example.org/v1/t1/search', '{"term":"x"}')));            // 没编组的主机没有白名单
  assert.ok(isFulfill403(await send('GET', 'http://sso.example.org/logout')));                                   // 会话组 a 的登出（主机是它的 loginHost，不在 hosts 里）
  assert.ok(isFulfill403(await send('GET', 'http://b.example.com/logout')));                                     // 目标组 b 的登出
  assert.ok(isFulfill403(await send('GET', 'http://sso.example.org/logout?next=1')));                           // 登出按路径匹配：带查询串、结尾斜杠也拦
  assert.ok(isFulfill403(await send('GET', 'http://sso.example.org/logout/')));
  assert.equal((await send('GET', 'http://b.example.com/other')).action, 'continue');
  await sm.close({ session: a.session });
  // 组 b 的会话往组 a 的接口发读型 POST：用目标主机所在的组 a 的白名单（会话组 b 没有）；b 自己的登出照拦，a 的登出主机（没编组）不归 b 管
  const b = await sm.open({ url: B_URL }); const pageB = fake.openPages().at(-1)!;
  assert.deepEqual(await wlReq(fake, pageB, 'POST', API_SEARCH, B_URL, '{"term":"x"}'), NO_REDIRECT);
  assert.ok(isFulfill403(await wlReq(fake, pageB, 'GET', 'http://b.example.com/logout', B_URL)));
  assert.equal((await wlReq(fake, pageB, 'GET', 'http://sso.example.org/logout', B_URL)).action, 'continue');
  await sm.close({ session: b.session });
});

test('whitelist, logout navigation in a session: blocked with the 403 page and recorded with reason logout, ahead of everything', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  const nav = await topNav(fake, pageId, A_URL + 'logout');
  assert.deepEqual([isFulfill403(nav), (nav as { contentType: string }).contentType], [true, 'text/html; charset=utf-8']);
  assert.ok(isFulfill403(await wlReq(fake, pageId, 'POST', A_URL + 'logout', A_URL, '{}')));
  assert.equal((await topNav(fake, pageId, A_URL + 'profile')).action, 'continue');
  const res = readResult((await sm.close({ session: a.session })).runDir);
  assert.deepEqual(res.writes.blocked.map((w) => [w.method, w.reason]), [['GET', 'logout'], ['POST', 'logout']]);
  assert.deepEqual(res.writes.blockedSummary.map((r) => [r.method, r.reason, r.count]), [['GET', 'logout', 1], ['POST', 'logout', 1]]);
});

test('whitelist, borrowed session: a local page that borrowed group a is judged by group a\'s lists for what it sends to a host of that group', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const r = await sm.open({ url: HOME_URL, profile: 'a' }); const pageId = fake.openPages().at(-1)!;
  assert.equal(r.borrowed, true);
  assert.deepEqual(await wlReq(fake, pageId, 'POST', API_SEARCH, HOME_URL, '{"term":"x"}'), NO_REDIRECT);          // 目标主机只读、白名单放行
  assert.ok(isFulfill403(await wlReq(fake, pageId, 'POST', API_SEARCH, HOME_URL, '{"query":"mutation{a}"}')));
  assert.ok(isFulfill403(await wlReq(fake, pageId, 'GET', 'http://a.example.com/logout', HOME_URL)));
  assert.equal((await wlReq(fake, pageId, 'POST', HOME_URL + 'api', HOME_URL, '{}')).action, 'continue');           // 本地主机默认模式：照旧
  await sm.close({ session: r.session });
});

test('whitelist, default-mode session: nothing changes (all writes pass, logout included)', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const r = await sm.open({ url: HOME_URL }); const pageId = fake.openPages().at(-1)!;
  assert.deepEqual(await wlReq(fake, pageId, 'POST', HOME_URL + 'api', HOME_URL, '{}'), { action: 'continue' });
  assert.deepEqual(await wlReq(fake, pageId, 'GET', 'http://sso.example.org/logout', HOME_URL), { action: 'continue' });
  const res = readResult((await sm.close({ session: r.session })).runDir);
  assert.ok(res.writes.allowed.every((w) => w.allowedBy === undefined));
});

test('whitelist, frozen session: the freeze check comes first, so a whitelisted write is refused too', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  fake.emitHop(pageId, B_URL + 'landing');
  const d = await wlReq(fake, pageId, 'POST', API_SEARCH, A_URL, '{"term":"x"}');
  assert.ok(isFulfill403(d)); assert.ok((d as { body: string }).body.includes('session frozen'));
  const res = readResult((await sm.close({ session: a.session })).runDir);
  assert.ok(res.writes.blocked.every((w) => w.reason === 'other-group') && res.writes.allowed.length === 0);
});

test('whitelist, login window: logout is allowed (to switch accounts); read-POSTs and persisted queries follow the target group; a mutation is still blocked', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const { loginId } = await sm.loginBegin({ url: A_URL + 'login', profile: 'a' }); const pageId = fake.openPages().at(-1)!;
  const top = A_URL + 'login';
  assert.deepEqual(await wlReq(fake, pageId, 'GET', 'http://a.example.com/logout', top), { action: 'continue' });
  assert.deepEqual(await wlReq(fake, pageId, 'POST', 'http://a.example.com/logout', top, '{}'), { action: 'fulfill', status: 403, contentType: 'application/json', body: '{"error":"blocked by e2k read-only mode"}' });   // 登出以外的写照只读规则：POST 不在白名单
  assert.deepEqual(await wlReq(fake, pageId, 'POST', API_SEARCH, top, '{"term":"x"}'), NO_REDIRECT);
  assert.deepEqual(await wlReq(fake, pageId, 'POST', API_GRAPHQL, top, wlPq(WL_HASH)), NO_REDIRECT);
  assert.ok(isFulfill403(await wlReq(fake, pageId, 'POST', API_GRAPHQL, top, wlPq(WL_OTHER_HASH))));
  assert.ok(isFulfill403(await wlReq(fake, pageId, 'POST', API_SEARCH, top, '{"query":"mutation{a}"}')));
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 3 });
});

test('whitelist, login popup: a popup of the login window is judged like the window', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const { loginId } = await sm.loginBegin({ url: A_URL + 'login', profile: 'a' }); const pageId = fake.openPages().at(-1)!;
  const popup = fake.emitPopup(pageId, 'about:blank');
  assert.deepEqual(await wlReq(fake, popup.id, 'POST', API_SEARCH, A_URL + 'login', '{"term":"x"}'), NO_REDIRECT);
  assert.deepEqual(await wlReq(fake, popup.id, 'GET', 'http://a.example.com/logout', A_URL + 'login'), { action: 'continue' });
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 0 });
});

test('whitelist, unattributed requests: a logout of the target host\'s group is blocked while something is read-only; no whitelisted write is let through', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const a = await sm.open({ url: A_URL });
  const ia = instanceOf(fake, 'a');
  const orphan = (method: string, url: string, body: string | null = null) =>
    fake.emitRequest({ id: `wl${++navSeq}`, pageId: null, method, url, topUrl: null, body, contentType: body === null ? null : 'application/json' }, ia);
  assert.ok(isFulfill403(await orphan('GET', 'http://a.example.com/logout')));
  assert.ok(isFulfill403(await orphan('GET', 'http://b.example.com/logout')));
  assert.ok(isFulfill403(await orphan('GET', 'http://sso.example.org/logout')));                                 // 组 a 的登出写在它的 loginHost 上：groupOf 看不到，要用所有组的并集
  assert.ok(isFulfill403(await orphan('GET', 'http://sso.example.org/logout?returnTo=%2F')));
  assert.equal((await orphan('GET', 'http://a.example.com/profile')).action, 'continue');
  assert.ok(isFulfill403(await orphan('POST', API_SEARCH, '{"term":"x"}')));                                    // 读型 POST 白名单不管未归属请求
  assert.ok(isFulfill403(await orphan('POST', API_GRAPHQL, wlPq(WL_HASH))));
  const res = readResult((await sm.close({ session: a.session })).runDir);
  assert.deepEqual(res.writes.unattributed.map((w) => [w.method, w.reason]), [['GET', 'logout'], ['GET', 'logout'], ['GET', 'logout'], ['GET', 'logout'], ['POST', 'unattributed'], ['POST', 'unattributed']]);
});

test('whitelist: every whitelisted allow is sent without following redirects (the driver is told), and a refused 3xx first hop turns the record into a blocked redirected-write without allowedBy', async () => {
  const { sm, fake } = await setupGroups(WL_RULES);
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  fake.noRedirectIds.length = 0;
  await fake.emitRequest({ id: 'rp', pageId, method: 'POST', url: API_SEARCH, topUrl: A_URL, body: '{"term":"x"}', contentType: 'application/json' });
  await fake.emitRequest({ id: 'pq', pageId, method: 'POST', url: API_GRAPHQL, topUrl: A_URL, body: wlPq(WL_HASH), contentType: 'application/json' });
  assert.deepEqual(fake.noRedirectIds, ['rp', 'pq']);
  fake.emitRequestDone('rp', 307, { redirectRefused: true });
  fake.emitRequestDone('pq', 200);
  const res = readResult((await sm.close({ session: a.session })).runDir);
  assert.deepEqual(res.writes.allowed.map((w) => [w.url, w.allowedBy, w.status]), [[API_GRAPHQL, 'persisted-query', 200]]);
  assert.deepEqual(res.writes.blocked.map((w) => [w.url, w.reason, w.allowedBy]), [[API_SEARCH, 'redirected-write', undefined]]);
});

// ---- 放行声明（M2b 任务 9） ----
// 四条请求路径：会话页和会话弹窗（认得出归属的）认「会话的声明 ∩ 批准记录」；弹窗的第一个导航和未归属的请求认不出归属，不享受声明；
// 登录页（含弹窗）declared 传空。

type AllowItem = NonNullable<StepParams['allow']>[number];
const D_URL = 'http://example.com/api/items';           // 只读页面所在主机上的接口
const D_API = 'http://api.example.com/v1/items';        // 默认模式主机上的接口
const D_GQL = 'http://api.example.com/graphql';
const D_A: AllowItem = { method: 'POST', url: D_URL };
const D_B: AllowItem = { method: 'PUT', url: D_API };
const D_C: AllowItem = { method: 'DELETE', url: D_API };
const D_SAVE: AllowItem = { method: 'POST', url: D_GQL, operation: 'Save' };
const SNAP: Op[] = [{ op: 'snapshot' }];
const allowing = (r: DialogRequest): DialogResult => ({ kind: 'button', button: r.buttons.includes('放行') ? '放行' : '拒绝' });
const gqlMutation = (op: string): string => JSON.stringify({ operationName: op, query: `mutation ${op} { a }` });
const lineOf = (a: AllowItem): string => `${a.method} ${a.url}${a.operation === undefined ? '（这个地址上的所有写；GraphQL mutation 不在内，要放行 mutation 得写 operation）' : `（只放行 operation ${a.operation}）`}`;

function setupDecl(dialog: Dialog, readonlyHosts: string[] = ['example.com'], now?: () => number) {
  const rules = mutableRules(readonlyHosts);
  const s = setup({ modes: rules.resolver, policy, approvals: new Approvals(dialog, () => {}, now === undefined ? {} : { now }),
    extraPages: { [RO]: HOME_PAGE, 'http://example.org/': HOME_PAGE } });
  const store = (s.sm as unknown as { deps: SessionDeps }).deps.store;
  return { ...s, ...rules, store, dialog };
}
type DeclCtx = ReturnType<typeof setupDecl>;

async function openAt(c: DeclCtx, name: string, url: string = RO) {
  const r = await c.sm.open({ url, name });
  return { session: r.session, pageId: c.fake.openPages().at(-1)!, runDir: r.runDir };
}
const dPost = (c: DeclCtx, pageId: string | null, url: string, body: string | null = '{"a":1}', topUrl: string | null = RO, more: Partial<Parameters<FakeDriver['emitRequest']>[0]> = {}) =>
  c.fake.emitRequest({ id: `d${++navSeq}`, pageId, method: 'POST', url, topUrl, body, contentType: body === null ? null : 'application/json', ...more });
// 页面真的搬到了另一个主机（主页面的请求带着新的顶层地址 = 已提交的证据）
const moveTo = (c: DeclCtx, pageId: string, top: string) => c.fake.emitRequest({ id: `d${++navSeq}`, pageId, method: 'GET', url: `${top}app.js`, topUrl: top });
// 第一次 21，人点了以后原样重试
async function declare(c: DeclCtx, session: string, allow: AllowItem[]): Promise<void> {
  await assert.rejects(c.sm.step({ session, ops: SNAP, allow }), isCode('wait-approval'));
  await settleDialog();
  await c.sm.step({ session, ops: SNAP, allow });
}
const usageWith = (re: RegExp) => (e: unknown): boolean => isCode('usage')(e) && re.test((e as Error).message);
const storedCount = (c: DeclCtx): number => Object.values(c.store.get().writes).flat().length;

test('declared writes: step --allow on a read-only session answers 21 and runs nothing; after 放行 the same call goes through and the declared writes pass with allowedBy declared', async () => {
  const dialog = fakeDialog(allowing);
  const c = setupDecl(dialog);
  const { session, pageId } = await openAt(c, 'decl');
  const allow = [D_A, D_SAVE];
  assert.ok(isFulfill403(await dPost(c, pageId, D_URL)));
  const snaps = methodCount(c.fake, 'snapshot');
  await assert.rejects(c.sm.step({ session, ops: SNAP, allow }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(methodCount(c.fake, 'snapshot'), snaps, 'nothing ran');
  assert.equal(dialog.requests.length, 1);
  const req = dialog.requests[0]!;
  assert.match(req.title, /^e2k：放行写请求（请求 a-[0-9a-f]{6}）$/);
  assert.deepEqual([req.buttons, req.defaultButton], [['拒绝', '放行'], '拒绝']);
  assert.deepEqual(req.lines.slice(0, 2), ['会话：decl（组 default）', '页面所在主机：example.com']);
  assert.ok(req.lines.includes(lineOf(D_A)) && req.lines.includes(lineOf(D_SAVE)), req.lines.join('\n'));
  // 人点了「放行」、还没重试：声明还没生效
  assert.ok(isFulfill403(await dPost(c, pageId, D_URL)));
  assert.deepEqual(c.store.get().writes, {});
  await c.sm.step({ session, ops: SNAP, allow });
  assert.equal(methodCount(c.fake, 'snapshot'), snaps + 1);
  assert.deepEqual(await dPost(c, pageId, D_URL), NO_REDIRECT);
  assert.deepEqual(await dPost(c, pageId, D_GQL, gqlMutation('Save')), NO_REDIRECT);
  assert.ok(isFulfill403(await dPost(c, pageId, D_URL, gqlMutation('Save'))), 'no operation declared for this address: a mutation is not covered');
  assert.ok(isFulfill403(await dPost(c, pageId, D_GQL, gqlMutation('Other'))));
  assert.ok(isFulfill403(await dPost(c, pageId, 'http://example.com/api/other')));
  assert.ok(isFulfill403(await c.fake.emitRequest({ id: `d${++navSeq}`, pageId, method: 'PUT', url: D_URL, topUrl: RO, body: '{}', contentType: 'application/json' })), 'method must agree');
  await c.sm.step({ session, ops: SNAP });   // 之后的 step 不带 allow：本会话已批准的声明还在
  assert.deepEqual(await dPost(c, pageId, D_URL), NO_REDIRECT);
  const res = readResult((await c.sm.close({ session })).runDir);
  assert.deepEqual(res.writes.allowed.map((w) => [w.url, w.allowedBy]), [[D_URL, 'declared'], [D_GQL, 'declared'], [D_URL, 'declared']]);
  assert.deepEqual(res.declarations, [{ method: 'POST', url: D_GQL, operation: 'Save', approved: 'dialog' }, { method: 'POST', url: D_URL, operation: null, approved: 'dialog' }]);
  assert.equal(dialog.requests.length, 1);
});

test('declared writes: a new session with the same declaration is not asked again (remembered); a subset is not asked; a new entry asks for the new one only', async () => {
  const dialog = fakeDialog(allowing);
  const c = setupDecl(dialog);
  const one = await openAt(c, 'one');
  await declare(c, one.session, [D_A, D_B]);
  assert.equal(dialog.requests.length, 1);
  assert.ok(dialog.requests[0]!.lines.includes(lineOf(D_A)) && dialog.requests[0]!.lines.includes(lineOf(D_B)));
  const two = await openAt(c, 'two');
  assert.ok(isFulfill403(await dPost(c, two.pageId, D_URL)), 'a new session starts with nothing declared');
  await c.sm.step({ session: two.session, ops: SNAP, allow: [D_A] });   // 子集
  assert.equal(dialog.requests.length, 1, 'a subset of what was approved does not ask');
  assert.deepEqual(await dPost(c, two.pageId, D_URL), NO_REDIRECT);
  assert.ok(isFulfill403(await dPost(c, two.pageId, D_API.replace('/v1/items', '/x'))));
  await assert.rejects(c.sm.step({ session: two.session, ops: SNAP, allow: [D_A, D_C] }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 2);
  const lines = dialog.requests[1]!.lines;
  assert.ok(lines.includes(lineOf(D_C)) && !lines.includes(lineOf(D_A)) && !lines.includes(lineOf(D_B)), lines.join('\n'));
  await c.sm.step({ session: two.session, ops: SNAP, allow: [D_A, D_C] });
  assert.equal(storedCount(c), 3);
  const r1 = readResult((await c.sm.close({ session: one.session })).runDir);
  const r2 = readResult((await c.sm.close({ session: two.session })).runDir);
  assert.deepEqual(r1.declarations.map((d) => d.approved), ['dialog', 'dialog']);
  assert.deepEqual(r2.declarations.map((d) => [d.method, d.approved]).sort(), [['DELETE', 'dialog'], ['POST', 'remembered']]);
});

test('declared writes: a read-only page declaring a write to a default-mode host is asked too, and until the person approves that POST is still blocked', async () => {
  const dialog = fakeDialog(allowing);
  const c = setupDecl(dialog);
  const { session, pageId } = await openAt(c, 'cross');
  const toApi: AllowItem = { method: 'POST', url: D_API };
  assert.ok(isFulfill403(await dPost(c, pageId, D_API)));   // 页面只读：发往默认主机的写也拦
  await assert.rejects(c.sm.step({ session, ops: SNAP, allow: [toApi] }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 1);
  assert.ok(isFulfill403(await dPost(c, pageId, D_API)), 'asked but not yet in force');
  await c.sm.step({ session, ops: SNAP, allow: [toApi] });
  assert.deepEqual(await dPost(c, pageId, D_API), NO_REDIRECT);
});

test('declared writes: a default-mode session is asked as well (any target mode), and the dialog names its page host', async () => {
  const dialog = fakeDialog(allowing);
  const c = setupDecl(dialog);
  const { session } = await openAt(c, 'plain', HOME_URL);
  await declare(c, session, [D_A]);
  assert.equal(dialog.requests.length, 1);
  assert.deepEqual(dialog.requests[0]!.lines.slice(0, 2), ['会话：plain（组 default）', '页面所在主机：localhost']);
});

test('declared writes: 拒绝 makes the retry a usage error, the same set is not asked again (also from another session); another set right after is cooling; the POST stays blocked', async () => {
  let t = 1_000_000;
  const dialog = fakeDialog(() => ({ kind: 'button', button: '拒绝' }));
  const c = setupDecl(dialog, ['example.com'], () => t);
  const one = await openAt(c, 'one');
  const two = await openAt(c, 'two');
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await settleDialog();
  const denied = usageWith(/人拒绝了这些放行声明/);
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), denied);
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), denied);
  await assert.rejects(c.sm.step({ session: two.session, ops: SNAP, allow: [D_A] }), denied, 'a refusal is not forgotten because the session changed');
  assert.equal(dialog.requests.length, 1);
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_B] }), usageWith(/刚被人拒过/));
  assert.equal(dialog.requests.length, 1);
  t += 61_000;
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_B] }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 2);
  assert.ok(isFulfill403(await dPost(c, one.pageId, D_URL)));
  assert.deepEqual(c.store.get().writes, {});
});

test('declared writes: a dialog that cannot be shown is needs-human; nothing is declared and nothing runs', async () => {
  const c = setupDecl(fakeDialog());
  const { session, pageId } = await openAt(c, 'nodlg');
  await assert.rejects(c.sm.step({ session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await settleDialog();
  const snaps = methodCount(c.fake, 'snapshot');
  await assert.rejects(c.sm.step({ session, ops: SNAP, allow: [D_A] }), isCode('needs-human'));
  assert.equal(methodCount(c.fake, 'snapshot'), snaps);
  assert.ok(isFulfill403(await dPost(c, pageId, D_URL)));
  assert.deepEqual(c.store.get().writes, {});
});

test('declared writes: no operation → a mutation is blocked; with an operation, a batch that mixes another operation, a duplicated key and a hash-only persisted query are blocked', async () => {
  const c = setupDecl(fakeDialog(allowing));
  const { session, pageId } = await openAt(c, 'ops');
  await declare(c, session, [D_A, { method: 'POST', url: D_GQL, operation: 'A' }]);
  const hashOnly = (op: string, query?: string) => JSON.stringify({ operationName: op, ...(query === undefined ? {} : { query }), extensions: { persistedQuery: { version: 1, sha256Hash: 'e'.repeat(64) } } });
  assert.deepEqual(await dPost(c, pageId, D_URL, '{"plain":1}'), NO_REDIRECT);
  assert.ok(isFulfill403(await dPost(c, pageId, D_URL, gqlMutation('A'))));
  assert.deepEqual(await dPost(c, pageId, D_GQL, gqlMutation('A')), NO_REDIRECT);
  assert.deepEqual(await dPost(c, pageId, D_GQL, `[${gqlMutation('A')},${gqlMutation('A')}]`), NO_REDIRECT);
  assert.ok(isFulfill403(await dPost(c, pageId, D_GQL, `[${gqlMutation('A')},${gqlMutation('B')}]`)));
  assert.ok(isFulfill403(await dPost(c, pageId, D_GQL, gqlMutation('B'))));
  assert.ok(isFulfill403(await dPost(c, pageId, D_GQL, '{"operationName":"A","operationName":"B","query":"mutation A { a }"}')));
  assert.ok(isFulfill403(await dPost(c, pageId, D_GQL, hashOnly('A'))), 'a hash-only persisted query is never covered by a declaration');
  assert.ok(isFulfill403(await dPost(c, pageId, D_GQL, hashOnly('A', ''))), 'nor one with an empty query');
  assert.ok(isFulfill403(await dPost(c, pageId, D_URL, hashOnly('A'))));
  const res = readResult((await c.sm.close({ session })).runDir);
  assert.deepEqual(res.writes.blocked.map((w) => w.reason), ['graphql-mutation', 'graphql-mutation', 'graphql-mutation', 'graphql-mutation', 'persisted-query', 'persisted-query', 'persisted-query']);
});

test('declared writes: the answer is bound to what the box showed: the page host moved after the dialog came up, so the old answer does not apply and a new box asks', async () => {
  let release = (): void => {};
  const dialog = fakeDialog((r) => new Promise((resolve) => { release = () => { resolve(allowing(r)); }; }));
  const c = setupDecl(dialog, ['example.com', 'example.org']);
  const { session, pageId } = await openAt(c, 'moved');
  await assert.rejects(c.sm.step({ session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await moveTo(c, pageId, 'http://example.org/');
  assert.equal(inner(c.sm, session).topHost, 'example.org');
  release();
  await settleDialog();
  await assert.rejects(c.sm.step({ session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));   // 房间换了：不用上一个框的答复
  await settleDialog();
  assert.equal(dialog.requests.length, 2);
  assert.equal(dialog.requests[1]!.lines[1], '页面所在主机：example.org');
  assert.deepEqual(c.store.get().writes, {});
  assert.ok(isFulfill403(await dPost(c, pageId, D_URL, '{"a":1}', 'http://example.org/')));
});

test('declared writes: an answer covers exactly the set the box listed: a bigger set asks again, a smaller one that was approved elsewhere asks only for the rest', async () => {
  const dialog = fakeDialog(allowing);
  const c = setupDecl(dialog);
  const one = await openAt(c, 'one');
  const two = await openAt(c, 'two');
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await settleDialog();                                                                                       // 人对 {A} 点了放行，还没用掉
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A, D_B] }), isCode('wait-approval'));   // 比框里列的多一条
  await settleDialog();
  assert.equal(dialog.requests.length, 2);
  assert.ok(dialog.requests[1]!.lines.includes(lineOf(D_A)) && dialog.requests[1]!.lines.includes(lineOf(D_B)));
  assert.deepEqual(c.store.get().writes, {}, 'nothing was used yet');
  await declare(c, two.session, [D_C]);                                                                       // 别的会话批准并用掉了 {C}：之前没用掉的 writes 答复一并作废
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 4, 'the unused answer for {A} was voided when another approval was used');
  assert.ok(isFulfill403(await dPost(c, one.pageId, D_URL)), 'a step that waited for approval declared nothing');
});

test('declared writes: the answer is also bound to the session: another session with the same set gets its own box, naming itself', async () => {
  const dialog = fakeDialog(allowing);
  const c = setupDecl(dialog);
  const one = await openAt(c, 'one');
  const two = await openAt(c, 'two');
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await settleDialog();
  await assert.rejects(c.sm.step({ session: two.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 2);
  assert.equal(dialog.requests[1]!.lines[0], '会话：two（组 default）');
});

test('declared writes: a declaration only works where it was approved: the page moving to another host, or the record losing the entry, switches it off', async () => {
  const c = setupDecl(fakeDialog(allowing), ['example.com', 'example.org']);
  const { session, pageId } = await openAt(c, 'bound');
  await declare(c, session, [D_A]);
  assert.deepEqual(await dPost(c, pageId, D_URL), NO_REDIRECT);
  await moveTo(c, pageId, 'http://example.org/');
  assert.ok(isFulfill403(await dPost(c, pageId, D_URL, '{"a":1}', 'http://example.org/')), 'approved for another page host');
  await moveTo(c, pageId, RO);
  assert.deepEqual(await dPost(c, pageId, D_URL), NO_REDIRECT);
  c.store.update((r) => ({ ...r, writes: {} }));                  // 批准记录里没有了：判定时再核对
  assert.ok(isFulfill403(await dPost(c, pageId, D_URL)));
});

test('declared writes, four paths: session page and attributed popup use them; the popup\'s first navigation, a login window and unattributed requests do not', async () => {
  const c = setupDecl(fakeDialog(allowing));
  const { session, pageId } = await openAt(c, 'paths');
  await declare(c, session, [D_A]);
  assert.deepEqual(await dPost(c, pageId, D_URL), NO_REDIRECT);                                                    // 会话页
  const popup = c.fake.emitPopup(pageId, 'about:blank');
  assert.deepEqual(await dPost(c, popup.id, D_URL), NO_REDIRECT);                                                  // 认得出归属的弹窗
  const first = await dPost(c, null, D_URL, 'x=1', D_URL, { openerPageId: pageId, isNavigation: true, topFrame: true, contentType: 'application/x-www-form-urlencoded' });
  assert.ok(isFulfill403(first), 'the first navigation of a popup cannot be attributed: fail closed');
  assert.ok(isFulfill403(await dPost(c, null, D_URL, '{"a":1}', null)), 'unattributed');
  const { loginId } = await c.sm.loginBegin({ url: `${RO}login` });
  const loginPage = c.fake.openPages().at(-1)!;
  assert.ok(isFulfill403(await dPost(c, loginPage, D_URL, '{"a":1}', `${RO}login`)), 'a login window has no declarations');
  assert.deepEqual(await c.sm.loginEnd({ loginId }), { writesBlocked: 1 });
  const res = readResult((await c.sm.close({ session })).runDir);
  assert.deepEqual(res.writes.allowed.map((w) => w.allowedBy), ['declared', 'declared']);
  assert.deepEqual(res.writes.unattributed.map((w) => w.reason), ['unattributed', 'unattributed']);
});

test('declared writes: a box that would be too long is refused before it is shown; bad declarations are usage errors and never reach the dialog', async () => {
  const dialog = fakeDialog(allowing);
  const c = setupDecl(dialog);
  const { session } = await openAt(c, 'bad');
  const long = `http://example.com/${'a'.repeat(160)}`;
  await assert.rejects(c.sm.step({ session, ops: SNAP, allow: [{ method: 'POST', url: long }] }), usageWith(/内容太长/));
  for (const allow of [[{ method: 'GET', url: D_URL }], [{ method: 'POST', url: `${D_URL}?x=1` }], [{ method: 'POST', url: D_URL, operation: 'a-b' }],
    Array.from({ length: 13 }, (_, i) => ({ method: 'POST', url: `${D_URL}/${i}` }))]) {
    await assert.rejects(c.sm.step({ session, ops: SNAP, allow }), isCode('usage'), JSON.stringify(allow).slice(0, 80));
  }
  assert.equal(dialog.requests.length, 0);
  await c.sm.step({ session, ops: SNAP, allow: [] });   // 空的声明就是没有声明
  assert.equal(dialog.requests.length, 0);
});

test('declared writes: a refusal is remembered when it is given, even if the session that asked never retries: another session asking the same set later gets no dialog', async () => {
  let t = 1_000_000;
  const dialog = fakeDialog(() => ({ kind: 'button', button: '拒绝' }));
  const c = setupDecl(dialog, ['example.com'], () => t);
  const one = await openAt(c, 'one');
  const two = await openAt(c, 'two');
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await settleDialog();                       // 人拒绝了；one 不再重试
  t += 61_000;                                // 冷却过去
  await assert.rejects(c.sm.step({ session: two.session, ops: SNAP, allow: [D_A] }), usageWith(/人拒绝了这些放行声明/));
  assert.equal(dialog.requests.length, 1);
  await assert.rejects(c.sm.step({ session: two.session, ops: SNAP, allow: [D_B] }), isCode('wait-approval'), 'a different set is still asked');
  await settleDialog();
  assert.equal(dialog.requests.length, 2);
});

test('declared writes: a refusal is tied to the page host: the same set on another page host is asked again', async () => {
  let t = 1_000_000;
  const dialog = fakeDialog(() => ({ kind: 'button', button: '拒绝' }));
  const c = setupDecl(dialog, ['example.com', 'example.org'], () => t);
  const one = await openAt(c, 'one');
  const two = await openAt(c, 'two', 'http://example.org/');
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await settleDialog();
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), usageWith(/人拒绝了这些放行声明/));
  t += 61_000;
  await assert.rejects(c.sm.step({ session: two.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 2);
  assert.equal(dialog.requests[1]!.lines[1], '页面所在主机：example.org');
});

test('declared writes: the operation is part of a declaration\'s identity: approving one with operation Save does not cover the same address without an operation or with another one', async () => {
  const dialog = fakeDialog(allowing);
  const c = setupDecl(dialog);
  const one = await openAt(c, 'one');
  await declare(c, one.session, [D_SAVE]);
  assert.equal(dialog.requests.length, 1);
  const two = await openAt(c, 'two');
  await c.sm.step({ session: two.session, ops: SNAP, allow: [D_SAVE] });   // 全等：不问
  assert.equal(dialog.requests.length, 1);
  const noOp: AllowItem = { method: 'POST', url: D_GQL };
  const other: AllowItem = { method: 'POST', url: D_GQL, operation: 'Other' };
  await assert.rejects(c.sm.step({ session: two.session, ops: SNAP, allow: [noOp] }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 2);
  assert.ok(dialog.requests[1]!.lines.includes(lineOf(noOp)));
  await assert.rejects(c.sm.step({ session: two.session, ops: SNAP, allow: [other] }), isCode('wait-approval'));
  await settleDialog();
  assert.equal(dialog.requests.length, 3);
  assert.ok(dialog.requests[2]!.lines.includes(lineOf(other)));
});

const askedSizes = (sm: SessionManager): number[] => [...(sm as unknown as { askedWrites: Map<string, Set<string>> }).askedWrites.values()].map((x) => x.size);

test('declared writes: the record of asked sets stays bounded: a dialog that cannot be shown leaves nothing behind, however many different sets are tried', async () => {
  const c = setupDecl(noDialog);
  const { session } = await openAt(c, 'many');
  const attempt = (i: number) => c.sm.step({ session, ops: SNAP, allow: [{ method: 'POST', url: `${D_URL}/${i}` }] });
  await assert.rejects(attempt(0), isCode('wait-approval'));    // 第一次有框在排队（真的 pending）
  await settleDialog();                                          // 框弹不出：待批表删了它
  for (let i = 1; i <= 50; i++) await assert.rejects(attempt(i), isCode('needs-human'));
  assert.deepEqual(askedSizes(c.sm), []);
});

test('declared writes: an asked box whose dialog timed out is a dead entry and is dropped; the live one stays', async () => {
  const dialog = fakeDialog(() => ({ kind: 'timeout' }));
  const c = setupDecl(dialog);
  const one = await openAt(c, 'one');
  const two = await openAt(c, 'two');
  await assert.rejects(c.sm.step({ session: one.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  assert.deepEqual(askedSizes(c.sm), [1]);
  await settleDialog();                                           // 没人理：待批表删了这个键
  await assert.rejects(c.sm.step({ session: two.session, ops: SNAP, allow: [D_A] }), isCode('wait-approval'));
  assert.deepEqual(askedSizes(c.sm), [1], 'the dead key of the first session was dropped');
});

// ---- 身份探针（M2b 任务 10） ----

const ID_RULES = {
  version: 1, rules: [{ match: 'a.example.com', mode: 'readonly' }], loginHosts: [],
  groups: [{ name: 'a', hosts: ['a.example.com'], loginHosts: ['sso.example.org'], identity: { selector: '#acct', expect: 'Test Tenant' } },
    { name: 'b', hosts: ['b.example.com'] }],
};
const ID_A = 'http://a.example.com/';
const ID_EL = 'css=#acct';
const TENANT = { [ID_EL]: { text: '  Test Tenant \n', count: 1 } };
const OTHER_TEXT = 'Zeta Corp 8841';   // 页面上的别人的账号名：不许出现在任何输出里

// 真的规则解析器（规则经假对话框批准，同线上一条路径）、假驱动；页面规格由测试给。
async function setupIdent(pages: Record<string, FakePageSpec>, extra: Partial<SessionDeps> = {}, rules: unknown = ID_RULES) {
  const tmp = makeTmpHome();
  writeFileSync(tmp.home.rulesFile, JSON.stringify(rules));
  const store = ApprovalStore.open(tmp.home.approvalsFile, () => {});
  const modes = listedAll(createRulesResolver(tmp.home.rulesFile, store));
  const dialog = fakeDialog(approving);
  const s = setup({ modes, policy, home: tmp.home, store, approvals: new Approvals(dialog, () => {}), ...extra });
  cleanups.push(async () => { tmp.cleanup(); });
  for (const [url, spec] of Object.entries(pages)) s.fake.definePage(url, spec);
  await assert.rejects(s.sm.loginBegin({ url: LOGIN_URL }), isCode('wait-approval'));
  await settleDialog();
  const { loginId } = await s.sm.loginBegin({ url: LOGIN_URL });
  await s.sm.loginEnd({ loginId });
  assert.equal(modes.state().pending, null);
  return { ...s, modes, dialog };
}

const snapshots = (fake: FakeDriver): number => methodCount(fake, 'snapshot');

test('identity probe: the expected text (trimmed) is ok at open and before each step; result.json counts the comparisons and carries no page text', async () => {
  const { sm, fake } = await setupIdent({ [ID_A]: { elements: TENANT } });
  const r = await sm.open({ url: ID_A });
  assert.equal(r.identity, 'ok');
  assert.equal((await sm.step({ session: r.session, ops: SNAP })).results[0]?.outcome, 'ok');
  assert.equal((await sm.step({ session: r.session, ops: SNAP })).exit, 0);
  assert.deepEqual(readResult((await sm.close({ session: r.session })).runDir).identity, { group: 'a', checks: 3, skipped: 0, mismatch: false });
  assert.equal(methodCount(fake, 'text'), 3);
});

test('identity probe: another name is a mismatch at open (the session is still returned), the next step is needs-human and runs nothing, and the page text appears nowhere', async () => {
  const { sm, fake, logs } = await setupIdent({ [ID_A]: { elements: { [ID_EL]: { text: OTHER_TEXT, count: 1 } } } });
  const r = await sm.open({ url: ID_A });
  assert.equal(r.identity, 'mismatch');
  assert.equal(r.next, '账号或租户可能被别的会话切走了；请人确认后关掉这个会话重开');   // --json 里也能看到下一步
  assert.ok(!(r.next ?? '').includes(OTHER_TEXT));
  const before = snapshots(fake);
  const reads = methodCount(fake, 'read');
  const bad = (e: unknown): boolean => {
    assert.ok(e instanceof E2kError); assert.equal(e.code, 'needs-human');
    assert.equal(e.message, '身份探针不符：组 a 期望「Test Tenant」，页面上不是');
    assert.equal(e.next, '账号或租户可能被别的会话切走了；请人确认后关掉这个会话重开');
    assert.ok(!JSON.stringify(e).includes(OTHER_TEXT));
    return true;
  };
  await assert.rejects(sm.step({ session: r.session, ops: SNAP }), bad);
  await assert.rejects(sm.step({ session: r.session, ops: SNAP }), bad);
  assert.equal(snapshots(fake), before, 'no operation reached the page');
  assert.equal(methodCount(fake, 'read'), reads, 'a remembered mismatch is not probed again');
  const closed = await sm.close({ session: r.session });   // 会话没被锁死：可以关
  assert.deepEqual(readResult(closed.runDir).identity, { group: 'a', checks: 1, skipped: 0, mismatch: true });
  for (const f of ['result.json', 'report.html']) assert.ok(!readFileSync(join(closed.runDir, f), 'utf8').includes(OTHER_TEXT), f);
  assert.ok(logs.every((l) => !l.includes(OTHER_TEXT)));
});

test('identity probe: a tenant switched inside one step by goto is only seen by the next step, which stops before running anything', async () => {
  const swapped = 'http://a.example.com/switched';
  const { sm, fake } = await setupIdent({ [ID_A]: { elements: TENANT }, [swapped]: { elements: { [ID_EL]: { text: OTHER_TEXT, count: 1 } } } });
  const r = await sm.open({ url: ID_A });
  assert.equal((await sm.step({ session: r.session, ops: [{ op: 'goto', url: swapped }, { op: 'snapshot' }] })).exit, 0);   // 这一批开始前探的是旧页面
  const before = snapshots(fake);
  await assert.rejects(sm.step({ session: r.session, ops: SNAP }), isCode('needs-human'));
  assert.equal(snapshots(fake), before);
  assert.deepEqual(readResult((await sm.close({ session: r.session })).runDir).identity, { group: 'a', checks: 3, skipped: 0, mismatch: true });
});

test('identity probe: not exactly one match is a mismatch (two, none, no element at all), and so is a different text', async () => {
  for (const el of [{ count: 2, text: 'Test Tenant' }, { count: 0, text: 'Test Tenant' }, undefined, { count: 1, text: 'Test Tenant 2' }, { count: 1, text: '' }]) {
    const { sm } = await setupIdent({ [ID_A]: { elements: el === undefined ? {} : { [ID_EL]: el } } });
    const r = await sm.open({ url: ID_A });
    assert.equal(r.identity, 'mismatch', JSON.stringify(el));
    await assert.rejects(sm.step({ session: r.session, ops: SNAP }), isCode('needs-human'), JSON.stringify(el));
  }
});

test('identity probe: the count is read before the text, and the text is not read when the count is not 1', async () => {
  const { sm, fake } = await setupIdent({ [ID_A]: { elements: { [ID_EL]: { text: 'Test Tenant', count: 2 } } } });
  await sm.open({ url: ID_A });
  assert.equal(methodCount(fake, 'text'), 0);
  assert.deepEqual(fake.calls.filter((c) => c.method === 'read').map((c) => c.args[0]), [{ kind: 'count', target: ID_EL }]);
});

test('identity probe: a driver error while reading is a mismatch (fail closed); an unrelated error is not swallowed', async () => {
  const { sm } = await setupIdent({ [ID_A]: { elements: { [ID_EL]: { text: 'Test Tenant', count: 1, readFails: true } } } });
  assert.equal((await sm.open({ url: ID_A })).identity, 'mismatch');
  const crash = await setupIdent({ [ID_A]: { elements: { [ID_EL]: { text: 'Test Tenant', count: 1, readCrash: true } } } });
  await assert.rejects(crash.sm.open({ url: ID_A }), TypeError);   // 不是 DriverError：原样抛，不变成不符，也不留会话
  assert.deepEqual(crash.sm.list(), []);
});

test('identity probe: a failure that is not a driver error at a step is thrown as it is, the session is back to idle and nothing is remembered as a mismatch', async () => {
  const { sm, fake } = await setupIdent({ [ID_A]: { elements: TENANT } });
  const r = await sm.open({ url: ID_A });
  fake.setElement(fake.openPages().at(-1)!, ID_EL, { text: 'Test Tenant', count: 1, readCrash: true });
  await assert.rejects(sm.step({ session: r.session, ops: SNAP }), TypeError);
  fake.setElement(fake.openPages().at(-1)!, ID_EL, TENANT[ID_EL]);
  assert.equal((await sm.step({ session: r.session, ops: SNAP })).exit, 0);
  assert.equal(readResult((await sm.close({ session: r.session })).runDir).identity?.mismatch, false);
});

test('identity probe: a probe that never settles is cut off after the configured time and counts as a mismatch', async () => {
  const { sm } = await setupIdent({ [ID_A]: { elements: { [ID_EL]: { text: 'Test Tenant', count: 1, readHangs: true } } } }, { identityProbeMs: 30 });
  const t0 = Date.now();
  const r = await sm.open({ url: ID_A });
  assert.equal(r.identity, 'mismatch');
  assert.ok(Date.now() - t0 < 1500);
});

test('identity probe: a password field on the page does not switch the probe off: the match is counted first, one match is compared (ok or mismatch), two are a mismatch, none is skipped', async () => {
  const wall = (el: FakePageSpec['elements']): FakePageSpec => ({ passwordField: true, elements: el });
  const { sm } = await setupIdent({
    'http://a.example.com/ok': wall(TENANT), 'http://a.example.com/other': wall({ [ID_EL]: { text: OTHER_TEXT, count: 1 } }),
    'http://a.example.com/two': wall({ [ID_EL]: { text: 'Test Tenant', count: 2 } }), 'http://a.example.com/none': wall({}),
  });
  const probe = async (path: string) => { const r = await sm.open({ url: `http://a.example.com/${path}`, name: path }); return { r, id: r.identity }; };
  assert.equal((await probe('ok')).id, 'ok');
  assert.equal((await probe('other')).id, 'mismatch');
  assert.equal((await probe('two')).id, 'mismatch');
  const none = await probe('none');
  assert.equal(none.id, 'skipped');
  assert.equal(none.r.blocked, 'login');
  assert.equal((await sm.step({ session: none.r.session, ops: SNAP })).results[0]?.outcome, 'ok');   // 跳过时 step 照常
  // 密码框 + 租户被切走：step 停下，不执行
  const sw = await sm.open({ url: 'http://a.example.com/ok', name: 'sw' });
  const { fake } = { fake: (sm as unknown as { deps: { driver: FakeDriver } }).deps.driver };
  fake.setElement(fake.openPages().at(-1)!, ID_EL, { text: OTHER_TEXT, count: 1 });
  const before = snapshots(fake);
  await assert.rejects(sm.step({ session: sw.session, ops: SNAP }), isCode('needs-human'));
  assert.equal(snapshots(fake), before);
});

test('identity probe: on an identity provider host and on a borrowed page it is skipped: no element is read, the session carries on', async () => {
  const idp = 'http://sso.example.org/';
  const { sm, fake } = await setupIdent({
    'http://a.example.com/to-sso': { redirectTo: idp }, [idp]: { elements: { [ID_EL]: { text: OTHER_TEXT, count: 1 } } },
    'http://localhost:5173/': { elements: { [ID_EL]: { text: OTHER_TEXT, count: 1 } } },
  });
  const viaIdp = await sm.open({ url: 'http://a.example.com/to-sso', name: 'idp' });
  assert.equal(viaIdp.identity, 'skipped');
  const borrowed = await sm.open({ url: 'http://localhost:5173/', profile: 'a', name: 'bor' });
  assert.deepEqual([borrowed.borrowed, borrowed.identity], [true, 'skipped']);
  assert.equal((await sm.step({ session: borrowed.session, ops: SNAP })).results[0]?.outcome, 'ok');
  assert.equal(methodCount(fake, 'read'), 0);
  assert.equal(methodCount(fake, 'text'), 0);
  for (const s of [viaIdp, borrowed]) {
    const id = readResult((await sm.close({ session: s.session })).runDir).identity;
    assert.equal(id?.mismatch, false); assert.equal(id?.checks, 0); assert.ok((id?.skipped ?? 0) >= 1);
  }
});

test('identity probe: a group without identity (and the default group) is not probed: identity is null in the open result and in result.json', async () => {
  const { sm, fake } = await setupIdent({ 'http://b.example.com/': { elements: { [ID_EL]: { text: OTHER_TEXT, count: 1 } } } });
  for (const url of ['http://b.example.com/', 'http://localhost:5173/']) {
    const r = await sm.open({ url });
    assert.equal(r.identity, null);
    await sm.step({ session: r.session, ops: SNAP });
    assert.equal(readResult((await sm.close({ session: r.session })).runDir).identity, null);
  }
  assert.equal(methodCount(fake, 'read'), 0);
});

test('identity probe: the identity is taken from the approved snapshot at each probe, not cached at open', async () => {
  const { sm, modes } = await setupIdent({ [ID_A]: { elements: TENANT } });
  const r = await sm.open({ url: ID_A });
  assert.equal(r.identity, 'ok');
  const real = modes.group.bind(modes);
  mock.method(modes, 'group', (name: string) => { const g = real(name); return g === null ? null : { ...g, identity: g.identity === null ? null : { ...g.identity, expect: 'Changed Tenant' } }; });
  await assert.rejects(sm.step({ session: r.session, ops: SNAP }), (e: unknown) => isCode('needs-human')(e) && (e as E2kError).message.includes('「Changed Tenant」'));
  mock.restoreAll();
});

test('identity probe: it runs before the declared-writes gate: the tenant is switched after open, the step with declarations stops with the identity error and no approval box is shown', async () => {
  const { sm, fake, dialog } = await setupIdent({ [ID_A]: { elements: TENANT } });
  const r = await sm.open({ url: ID_A });
  assert.equal(r.identity, 'ok');
  fake.setElement(fake.openPages().at(-1)!, ID_EL, { text: OTHER_TEXT, count: 1 });
  const boxes = dialog.requests.length;
  await assert.rejects(sm.step({ session: r.session, ops: SNAP, allow: [{ method: 'POST', url: 'http://a.example.com/api/save' }] }),
    (e: unknown) => isCode('needs-human')(e) && /身份探针不符/.test((e as Error).message));
  await settleDialog();
  assert.equal(dialog.requests.length, boxes);
});

test('identity probe: while it is awaiting the page, another step and a close are busy; a failing probe and a failing gate both put the session back to idle', async () => {
  const { sm, fake, dialog } = await setupIdent({ [ID_A]: { elements: TENANT } }, { identityProbeMs: 300 });
  const r = await sm.open({ url: ID_A });
  const page = fake.openPages().at(-1)!;
  // 门闸失败（没人批）也要复位：之后的 step 不是 busy。
  await assert.rejects(sm.step({ session: r.session, ops: SNAP, allow: [{ method: 'POST', url: 'http://a.example.com/api/one' }] }), isCode('wait-approval'));
  await settleDialog();
  assert.ok(dialog.requests.length >= 1);
  assert.equal((await sm.step({ session: r.session, ops: SNAP })).exit, 0);
  // 探针悬着：并发的 step、close 被挡。
  fake.setElement(page, ID_EL, { text: 'Test Tenant', count: 1, readHangs: true });
  const first = sm.step({ session: r.session, ops: SNAP });
  const settled = first.then(() => null, (e: unknown) => e);
  await assert.rejects(sm.step({ session: r.session, ops: SNAP }), isCode('busy'));
  await assert.rejects(sm.close({ session: r.session }), isCode('busy'));
  assert.equal(sm.list()[0]?.idleSec, 0);
  assert.ok(isCode('needs-human')(await settled));
  // 探针失败后会话回到 idle：能关。
  await sm.close({ session: r.session });
});

test('identity probe: only the main page is probed, not a popup and not a login window', async () => {
  const pop = 'http://a.example.com/pop';
  const { sm, fake } = await setupIdent({ [ID_A]: { elements: TENANT }, [pop]: { elements: { [ID_EL]: { text: OTHER_TEXT, count: 1 } } } });
  const r = await sm.open({ url: ID_A });
  const popup = fake.emitPopup(fake.openPages().at(-1)!, pop);
  assert.equal((await sm.step({ session: r.session, ops: SNAP })).exit, 0);
  const { loginId } = await sm.loginBegin({ url: ID_A, profile: 'a' });
  const loginPage = fake.openPages().at(-1)!;
  await sm.loginEnd({ loginId });
  const touched = (id: string): string[] => fake.calls.filter((c) => c.pageId === id).map((c) => c.method);
  assert.ok(!touched(popup.id).some((m) => m === 'read' || m === 'text' || m === 'location'));
  assert.ok(!touched(loginPage).some((m) => m === 'read' || m === 'text'));
  await sm.close({ session: r.session });
});

test('identity probe: a session frozen while the probe is awaiting the page gets the frozen error, no approval box and no operation', async () => {
  const { sm, fake, dialog } = await setupIdent({ [ID_A]: { elements: TENANT }, 'http://b.example.com/landing': {} });
  const r = await sm.open({ url: ID_A });
  const page = fake.openPages().at(-1)!;
  fake.setElement(page, ID_EL, { text: 'Test Tenant', count: 1, readDelayMs: 150 });
  const boxes = dialog.requests.length;
  const before = snapshots(fake);
  const step = sm.step({ session: r.session, ops: SNAP, allow: [{ method: 'POST', url: 'http://a.example.com/api/save' }] });
  const settled = step.then(() => null, (e: unknown) => e);
  await sleep(30);
  fake.emitHop(page, 'http://b.example.com/landing');   // 探针在等页面时被重定向进了组 b：冻结
  const e = await settled;
  assert.ok(isCode('needs-human')(e) && /会话已冻结/.test((e as Error).message), String(e));
  await settleDialog();
  assert.equal(dialog.requests.length, boxes);
  assert.equal(snapshots(fake), before);
  await sm.close({ session: r.session });
});

test('identity probe: a main page that closes while the probe is awaiting it is skipped, not a mismatch', async () => {
  const { sm, fake } = await setupIdent({ [ID_A]: { elements: TENANT } });
  const r = await sm.open({ url: ID_A });
  const page = fake.openPages().at(-1)!;
  fake.setElement(page, ID_EL, { text: 'Test Tenant', count: 1, readDelayMs: 100 });
  const settled = sm.step({ session: r.session, ops: SNAP }).then(() => null, (e: unknown) => e);
  await sleep(30);
  fake.closePage(page);
  const e = await settled;
  assert.ok(!(e instanceof E2kError && /身份探针不符/.test(e.message)), String(e));
  await until(() => sm.list().length === 0);
  const out = readResult(r.runDir);   // 报告在探针落定之前就收尾了，所以这里只看没有记不符；不符的话上面的 step 会抛身份错误
  assert.deepEqual([out.identity?.mismatch, out.closedBy], [false, 'page-gone']);
});

// ---- 登录前的弹框确认和「问一句模式」（M2b 任务 11） ----

const NEW_URL = 'http://app.example.com/login.html';
const NEW_API = 'http://app.example.com/api/login';
const isLoginBox = (r: DialogRequest): boolean => r.buttons.includes('只读');
const loginBoxes = (d: { requests: DialogRequest[] }): DialogRequest[] => d.requests.filter(isLoginBox);
const usageMatch = (re: RegExp) => (e: unknown): boolean => e instanceof E2kError && e.code === 'usage' && re.test(e.message);
const openedPages = (fake: FakeDriver): number => methodCount(fake, 'openPage');

// 登录前弹框：真的规则解析器、批准记录、真的写策略，假对话框按 script 答；没有规则文件。
function setupChoice(script: (r: DialogRequest) => DialogResult | Promise<DialogResult>) {
  const dialog = fakeDialog(script);
  return { dialog, ...setupGate(dialog, null, undefined, true) };
}

test('login on a host nobody listed: 21, one three-button box that shows the host and the options, and no page is opened', async () => {
  const { sm, fake, dialog, store } = setupChoice(() => new Promise<DialogResult>(() => {}));   // 人一直没点
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('wait-approval'));
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), (e: E2kError) => e.code === 'wait-approval' && /等人在弹框里批准：在新域名上登录/.test(e.message));
  assert.equal(dialog.requests.length, 1, 'the retry meets the same box');
  const req = dialog.requests[0]!;
  assert.match(req.title, /^e2k：在新域名上登录（请求 a-[0-9a-f]{6}）$/);
  assert.deepEqual(req.lines, ['要在 app.example.com 上打开登录窗口。', '这个域名还没配模式，请选：', '默认：写请求照常放行（仍记录）', '只读：写请求会被拦下', '取消：不打开']);
  assert.deepEqual([req.buttons, req.defaultButton, req.timeoutSec], [['取消', '默认', '只读'], '取消', 120]);
  assert.equal(openedPages(fake), 0);
  assert.deepEqual(store.get().hostModes, {});
});

test('login answered "只读": the retry opens the window, the choice is stored, the login window\'s own POST is blocked, and later opens of that host are read-only', async () => {
  const { sm, fake, dialog, store } = setupChoice(choosingMode('只读'));
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('wait-approval'));
  await settleDialog();
  const { loginId } = await sm.loginBegin({ url: NEW_URL });
  const loginPage = fake.openPages().at(-1)!;
  assert.deepEqual(store.get().hostModes, { 'app.example.com': 'readonly' });
  assert.equal((await fake.emitRequest({ pageId: loginPage, method: 'POST', url: NEW_API, topUrl: NEW_URL })).action, 'fulfill', 'the login window itself is read-only');
  assert.equal((await fake.emitRequest({ pageId: loginPage, method: 'GET', url: NEW_URL, topUrl: NEW_URL })).action, 'continue');
  assert.deepEqual(await sm.loginEnd({ loginId }), { writesBlocked: 1 });
  const o = await sm.open({ url: 'http://app.example.com/' });
  assert.equal(o.mode, 'readonly');
  const page = fake.openPages().at(-1)!;
  assert.equal((await fake.emitRequest({ pageId: page, method: 'POST', url: NEW_API, topUrl: 'http://app.example.com/' })).action, 'fulfill');
  assert.equal(readResult((await sm.close({ session: o.session })).runDir).modes[0]?.reason, 'host-choice');
  assert.equal(loginBoxes(dialog).length, 1, 'asked once');
});

test('login answered "默认": the window opens, the choice is stored, writes pass as before, and the host is not asked about again', async () => {
  const { sm, fake, dialog, store } = setupChoice(choosingMode('默认'));
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('wait-approval'));
  await settleDialog();
  const { loginId } = await sm.loginBegin({ url: NEW_URL });
  assert.deepEqual(store.get().hostModes, { 'app.example.com': 'default' });
  assert.equal((await fake.emitRequest({ pageId: fake.openPages().at(-1)!, method: 'POST', url: NEW_API, topUrl: NEW_URL })).action, 'continue');
  await sm.loginEnd({ loginId });
  const again = await sm.loginBegin({ url: NEW_URL });   // 已经问过：不再弹框
  await sm.loginEnd({ loginId: again.loginId });
  assert.equal(loginBoxes(dialog).length, 1);
  const o = await sm.open({ url: 'http://app.example.com/' });
  assert.equal(o.mode, 'default');
  await sm.close({ session: o.session });
});

test('login cancelled: usage with nothing stored and no window; the same host stays refused without asking again; another host within a minute says it was refused just now', async () => {
  const { sm, fake, dialog, store } = setupChoice(choosingMode('取消'));
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('wait-approval'));
  await settleDialog();
  for (let i = 0; i < 2; i++) await assert.rejects(sm.loginBegin({ url: NEW_URL }), usageMatch(/人取消了这次登录/));
  await assert.rejects(sm.loginBegin({ url: 'http://other.example.org/login' }), usageMatch(/刚被人拒过/));
  assert.equal(openedPages(fake), 0);
  assert.deepEqual(store.get().hostModes, {});
  assert.equal(dialog.requests.length, 1);
});

test('login on a host the approved rules list (rule, loginHosts, group host, group loginHosts) does not ask; a host listed by a changed rules file only after that file is approved', async () => {
  const rules = { version: 1, rules: [{ match: 'app.example.com', mode: 'default' }], loginHosts: ['sso.example.com'],
    groups: [{ name: 'g', hosts: ['g.example.com'], loginHosts: ['gsso.example.com'] }] };
  const dialog = fakeDialog(choosingMode('只读'));
  const { sm, home } = setupGate(dialog, rules, undefined, true);
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('wait-approval'));   // 规则文件是新的：先批准规则
  await settleDialog();
  for (const url of [NEW_URL, 'http://sso.example.com/login', 'http://g.example.com/login', 'http://gsso.example.com/login']) {
    const { loginId } = await sm.loginBegin({ url, ...(url.includes('gsso') ? { profile: 'g' } : {}) });
    await sm.loginEnd({ loginId });
  }
  assert.equal(loginBoxes(dialog).length, 0, 'none of them asked');
  writeRules(home, { ...rules, loginHosts: ['sso.example.com', 'new.example.com'] });   // 待批的改动里新列了一个主机：先要批准规则
  await assert.rejects(sm.loginBegin({ url: 'http://new.example.com/login' }), isCode('wait-approval'));
  await settleDialog();
  await sm.loginEnd(await sm.loginBegin({ url: 'http://new.example.com/login' }));   // 规则批准后它就列明了：不再问模式
  assert.equal(loginBoxes(dialog).length, 0);
});

test('a login on an unlisted host with no dialog available is needs-human (22): the window is never opened and nothing is stored', async () => {
  const { sm, fake, store } = setupGate(noDialog, null, undefined, true);
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('wait-approval'));
  await settleDialog();
  for (let i = 0; i < 2; i++) await assert.rejects(sm.loginBegin({ url: NEW_URL }), (e: E2kError) => e.code === 'needs-human' && /弹不出确认框：内核以 --no-dialogs 启动/.test(e.message) && e.next === '在有桌面的终端里起内核');
  assert.equal(openedPages(fake), 0);
  assert.deepEqual(store.get().hostModes, {});
});

test('the answer is bound to the host: answering for one host does not let another one in, and each box shows only its own host', async () => {
  const asked: string[] = [];
  const { sm, dialog, store } = setupChoice((r) => { asked.push(r.lines[0]!); return { kind: 'button', button: r.lines[0]!.includes('a.example.com') ? '只读' : '默认' }; });
  await assert.rejects(sm.loginBegin({ url: 'http://a.example.com/login' }), isCode('wait-approval'));
  await settleDialog();
  await assert.rejects(sm.loginBegin({ url: 'http://b.example.com/login' }), isCode('wait-approval'));   // a 的答复不算 b 的
  await settleDialog();
  await sm.loginEnd(await sm.loginBegin({ url: 'http://a.example.com/login' }));
  await sm.loginEnd(await sm.loginBegin({ url: 'http://b.example.com/login' }));
  assert.deepEqual(asked, ['要在 a.example.com 上打开登录窗口。', '要在 b.example.com 上打开登录窗口。']);
  assert.deepEqual(store.get().hostModes, { 'a.example.com': 'readonly', 'b.example.com': 'default' });
  assert.equal(dialog.requests.length, 2);
});

test('the box and the stored key use the normalized host (lower case, no port, no trailing dot, IPv6 in brackets)', async () => {
  const { sm, dialog, store } = setupChoice(choosingMode('只读'));
  for (const url of ['http://App.Example.COM.:8080/login.html', 'http://[::1]:5173/login.html']) {
    await assert.rejects(sm.loginBegin({ url }), isCode('wait-approval'));
    await settleDialog();
    await sm.loginEnd(await sm.loginBegin({ url }));
  }
  assert.deepEqual(dialog.requests.map((r) => r.lines[0]), ['要在 app.example.com 上打开登录窗口。', '要在 [::1] 上打开登录窗口。']);
  assert.deepEqual(store.get().hostModes, { 'app.example.com': 'readonly', '[::1]': 'readonly' });
  assert.equal((await sm.open({ url: 'http://app.example.com/' })).mode, 'readonly');
  assert.equal((await sm.open({ url: 'http://[::1]:5173/' })).mode, 'readonly');
});

test('a host that cannot be normalized, is __proto__, or is too long for the box is a usage error: no box, no window', async () => {
  const { sm, fake, dialog } = setupChoice(choosingMode('默认'));
  for (const url of ['not a url', 'http://__proto__/login.html']) await assert.rejects(sm.loginBegin({ url }), usageMatch(/./), url);
  await assert.rejects(sm.loginBegin({ url: `http://${'a'.repeat(210)}.example.com/login` }), usageMatch(/内容太长，框里显示不全/));
  await settleDialog();
  assert.equal(dialog.requests.length, 0);
  assert.equal(openedPages(fake), 0);
});

test('a login that cannot be recorded (the approval file does not take it) is needs-human, the answer is kept, and the retry writes it without a second box', async () => {
  const { sm, dialog, store } = setupChoice(choosingMode('只读'));
  const update = store.update.bind(store);
  store.update = () => { throw new E2kError('needs-human', '批准记录写不进磁盘'); };
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('wait-approval'));
  await settleDialog();
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('needs-human'));
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('needs-human'));
  assert.deepEqual(store.get().hostModes, {});
  store.update = update;
  await sm.loginEnd(await sm.loginBegin({ url: NEW_URL }));
  assert.deepEqual(store.get().hostModes, { 'app.example.com': 'readonly' });
  assert.equal(dialog.requests.length, 1);
});

test('changed rules come first: the rules box is answered before the login box, and both are needed', async () => {
  const { sm, dialog } = (() => { const d = fakeDialog(choosingMode('默认')); return { dialog: d, ...setupGate(d, GATE_RULES, undefined, true) }; })();
  await assert.rejects(sm.loginBegin({ url: LOGIN_URL }), isCode('wait-approval'));
  await settleDialog();
  assert.match(dialog.requests[0]!.title, /域名规则改了/);
  await assert.rejects(sm.loginBegin({ url: LOGIN_URL }), isCode('wait-approval'));   // 规则批准了，轮到登录框
  await settleDialog();
  assert.match(dialog.requests[1]!.title, /在新域名上登录/);
  await sm.loginEnd(await sm.loginBegin({ url: LOGIN_URL }));
  assert.equal(dialog.requests.length, 2);
});

test('an answer that was never used is dropped once the host is listed, so a later unlisting asks again', async () => {
  const dialog = fakeDialog(choosingMode('只读'));
  const { sm, home, store } = setupGate(dialog, null, undefined, true);
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('wait-approval'));
  await settleDialog();   // 答复是「只读」，但没有重试
  writeRules(home, { version: 1, rules: [{ match: 'app.example.com', mode: 'default' }] });
  await assert.rejects(sm.loginBegin({ url: NEW_URL }), isCode('wait-approval'));   // 规则要批准
  await settleDialog();
  await sm.loginEnd(await sm.loginBegin({ url: NEW_URL }));   // 规则批准后主机已列明：不用旧答复，也不弹框
  assert.deepEqual(store.get().hostModes, {}, 'the unused "只读" was not applied');
  const approvals = (sm as unknown as { deps: { approvals: Approvals } }).deps.approvals;
  assert.equal(approvals.stateOf('login:app.example.com'), undefined, 'the unused answer was dropped, so it cannot apply if the host is ever unlisted again');
  assert.equal(loginBoxes(dialog).length, 1);
});

test('the stored host choice reaches all four request paths: session page, session popup, login window, unattributed request (the mode follows the page, as with rules)', async () => {
  const { sm, fake } = setupChoice((r) => ({ kind: 'button', button: r.lines[0]!.includes('app.example.com') ? '只读' : '默认' }));
  const login = async (url: string): Promise<{ loginId: string }> => {
    await assert.rejects(sm.loginBegin({ url }), isCode('wait-approval'));
    await settleDialog();
    return sm.loginBegin({ url });
  };
  await sm.loginEnd(await login(NEW_URL));   // app.example.com 选了「只读」
  const HOME = 'http://localhost:5173/';
  const H = 'http://app.example.com/';
  const post = (pageId: string | null, extra: object = {}) => fake.emitRequest({ pageId, method: 'POST', url: NEW_API, ...extra });
  // 1) 会话页：页面在只读主机上，写被拦；对照：页面在没配过的默认主机上，写照常
  const ro = await sm.open({ url: H }); const roPage = fake.openPages().at(-1)!;
  assert.equal(ro.mode, 'readonly');
  assert.equal((await post(roPage, { topUrl: H })).action, 'fulfill');
  const s = await sm.open({ url: HOME }); const page = fake.openPages().at(-1)!;
  assert.equal(s.mode, 'default');
  assert.equal((await fake.emitRequest({ pageId: page, method: 'POST', url: 'http://localhost:5173/api', topUrl: HOME })).action, 'continue');
  // 2) 会话弹窗：默认主机上的会话弹出的窗口，第一个导航（表单 POST）落在只读主机上：弹窗归会话，顶层在只读主机上，拦
  const popup = fake.emitPopup(page, 'about:blank');
  assert.equal((await post(popup.id, { topUrl: NEW_API, isNavigation: true, topFrame: true, initiatorUrl: HOME, contentType: 'application/x-www-form-urlencoded', body: 'x=1' })).action, 'fulfill');
  // 3) 登录窗口：起点是默认主机（localhost 选了「默认」）；页面在只读主机上时，写被拦；在 localhost 上照常
  const { loginId } = await login('http://localhost:5173/login.html'); const loginPage = fake.openPages().at(-1)!;
  assert.equal((await fake.emitRequest({ pageId: loginPage, method: 'POST', url: 'http://localhost:5173/api/login', topUrl: 'http://localhost:5173/login.html' })).action, 'continue');
  assert.equal((await post(loginPage, { topUrl: NEW_URL })).action, 'fulfill');
  await sm.loginEnd({ loginId });
  await sm.close({ session: s.session });
  await sm.close({ session: ro.session });
  // 4) 未归属的请求（没有会话也没有登录窗口）：请求所在页的顶层主机或目标主机只读就拦
  assert.equal((await post(null, { topUrl: NEW_URL })).action, 'fulfill');
  assert.equal((await post(null, {})).action, 'fulfill');
  assert.equal((await fake.emitRequest({ pageId: null, method: 'POST', url: 'http://localhost:5173/api' })).action, 'continue');
});

// ---- 焦点：开会话和 step 里新开的页之后，把前台还给用户原来的应用 ----

test('focus: open captures before the browser is launched and restores once after the page is open', async () => {
  const order: string[] = [];
  let c!: ReturnType<typeof setup>;
  const focus: FocusKeeper = {
    capture: async () => { order.push(`capture launches=${c.fake.launches} pages=${c.fake.openPages().length}`); return 'com.example.app'; },
    restore: async (t) => { order.push(`restore ${t} launches=${c.fake.launches} pages=${c.fake.openPages().length}`); },
  };
  c = setup({ focus });
  await c.sm.open({ url: 'http://localhost:5173/' });
  assert.deepEqual(order, ['capture launches=0 pages=0', 'restore com.example.app launches=1 pages=1']);
});

test('focus: open restores even when it fails after the browser may have grabbed the foreground', async () => {
  const focus = fakeFocus('com.example.app');
  const { sm } = setup({ focus, failOpenWith: new DriverError('other', 'launch broke') });
  await assert.rejects(sm.open({ url: 'http://localhost:5173/' }));
  assert.deepEqual(focus.calls, ['capture', 'restore:com.example.app']);
});

test('focus: an open rejected before anything is launched does not touch the foreground at all', async () => {
  const focus = fakeFocus();
  const { sm } = setup({ focus });
  await assert.rejects(sm.open({ url: 'http://localhost:5173/', profile: 'BAD NAME' }), (e: E2kError) => e.code === 'usage');
  assert.deepEqual(focus.calls, []);
});

test('focus: a login window already open when open starts means no restore', async () => {
  const focus = fakeFocus();
  const { sm } = setup({ focus });
  const { loginId } = await sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  assert.deepEqual(focus.calls, [], 'login.begin does not touch the foreground');
  await sm.open({ url: 'http://localhost:5173/' });
  assert.deepEqual(focus.calls, ['capture'], 'captured, but the login window stays in front');
  await sm.loginEnd({ loginId });
  assert.deepEqual(focus.calls, ['capture'], 'login.end does not touch the foreground either');
});

test('focus: a login window that appears while open is running means no restore', async () => {
  const calls: string[] = [];
  let c!: ReturnType<typeof setup>;
  const focus: FocusKeeper = {
    capture: async () => { calls.push('capture'); await c.sm.loginBegin({ url: 'http://localhost:5173/login.html' }); return 'com.example.app'; },
    restore: async (t) => { calls.push(`restore:${t}`); },
  };
  c = setup({ focus });
  await c.sm.open({ url: 'http://localhost:5173/' });
  assert.deepEqual(calls, ['capture']);
});

test('focus: a keeper that throws changes nothing about open and step, and is logged', async () => {
  const boom: FocusKeeper = { capture: async () => { throw new Error('capture boom'); }, restore: async () => { throw new Error('restore boom'); } };
  const { sm, fake, logs } = setup({ focus: boom });
  const { session, pageId } = await opened(sm, fake);
  const wait = sm.step({ session, ops: [{ op: 'wait', for: { ms: 300 } }] });
  await until(() => logs.some((l) => l.includes('capture boom')));
  fake.emitPopup(pageId, 'http://localhost:5173/popup');
  assert.equal((await wait).exit, 0);
  assert.ok(logs.some((l) => l.includes('capture boom')) && logs.some((l) => l.includes('restore boom')));
  await sm.close({ session });
});

// 起一个 step，等它进入执行阶段（capture 已经调过），返回这次 step 的 promise。wait 足够长，让测试有时间在 step 进行中动手。
async function runningStep(sm: SessionManager, focus: { calls: string[] }, session: string, ms = 400) {
  const before = focus.calls.length;
  const step = sm.step({ session, ops: [{ op: 'wait', for: { ms } }] });
  await until(() => focus.calls.length > before);
  return step;
}

test('focus: a step that opens a page in its session restores once, with what it captured before the ops', async () => {
  const focus = fakeFocus('com.example.app');
  const { sm, fake } = setup({ focus });
  const { session, pageId } = await opened(sm, fake);
  focus.calls.length = 0;
  const step = runningStep(sm, focus, session);
  await until(() => focus.calls.length === 1);
  assert.deepEqual(focus.calls, ['capture'], 'captured before the ops run');
  fake.emitPopup(pageId, 'http://localhost:5173/popup');
  assert.equal((await step).exit, 0);
  assert.deepEqual(focus.calls, ['capture', 'restore:com.example.app']);
  await sm.close({ session });
});

test('focus: a step that opens no page captures but never restores', async () => {
  const focus = fakeFocus();
  const { sm, fake } = setup({ focus });
  const { session, pageId } = await opened(sm, fake);
  fake.emitPopup(pageId, 'http://localhost:5173/popup-between-steps');   // 两次 step 之间开的页不算这次 step 的
  focus.calls.length = 0;
  assert.equal((await sm.step({ session, ops: [{ op: 'snapshot' }] })).exit, 0);
  assert.deepEqual(focus.calls, ['capture']);
  await sm.close({ session });
});

test('focus: a page opened by another session during a step does not count', async () => {
  const focus = fakeFocus();
  const { sm, fake } = setup({ focus });
  const a = await opened(sm, fake, 'a');
  const b = await opened(sm, fake, 'b');
  focus.calls.length = 0;
  const step = runningStep(sm, focus, a.session);
  await until(() => focus.calls.length === 1);
  fake.emitPopup(b.pageId, 'http://localhost:5173/popup-of-b');
  await step;
  assert.deepEqual(focus.calls, ['capture']);
});

test('focus: a step that opens a page while a login window is open (at its start or during it) does not restore', async () => {
  // 开始时就有登录窗口
  const f1 = fakeFocus();
  const one = setup({ focus: f1 });
  const s1 = await opened(one.sm, one.fake);
  const login1 = await one.sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  f1.calls.length = 0;
  const step1 = runningStep(one.sm, f1, s1.session);
  await until(() => f1.calls.length === 1);
  one.fake.emitPopup(s1.pageId, 'http://localhost:5173/popup');
  await step1;
  assert.deepEqual(f1.calls, ['capture']);
  await one.sm.loginEnd(login1);
  // 开始时没有，执行期间来了一个
  const f2 = fakeFocus();
  const two = setup({ focus: f2 });
  const s2 = await opened(two.sm, two.fake);
  f2.calls.length = 0;
  const step2 = runningStep(two.sm, f2, s2.session);
  await until(() => f2.calls.length === 1);
  two.fake.emitPopup(s2.pageId, 'http://localhost:5173/popup');
  await two.sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  await step2;
  assert.deepEqual(f2.calls, ['capture']);
});

// 让下一次 openPage 卡住，直到放行：模拟「登录窗口正在开、还没登记进 logins」的那段窗口。blocked() 说明已经卡在里面了。
function gateNextOpenPage(fake: FakeDriver): { hold: () => () => void; blocked: () => boolean } {
  let gate: Promise<void> | null = null;
  let blocked = false;
  const launch = fake.launch.bind(fake);
  fake.launch = async (profile) => {
    const inst = await launch(profile);
    const openPage = inst.openPage.bind(inst);
    inst.openPage = async (o) => {
      const g = gate;
      if (g !== null) { gate = null; blocked = true; await g; }
      return openPage(o);
    };
    return inst;
  };
  return { hold: () => { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); return release; }, blocked: () => blocked };
}

test('focus: an open that ends while a login window is still being started (not yet registered) does not restore', async () => {
  const focus = fakeFocus('com.example.app');
  const { sm, fake } = setup({ focus });
  const gate = gateNextOpenPage(fake);
  await sm.open({ url: 'http://localhost:5173/' });
  focus.calls.length = 0;
  const release = gate.hold();
  const begin = sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  try {
    await until(() => gate.blocked());
    await sm.open({ url: 'http://localhost:5173/' });
    assert.deepEqual(focus.calls, ['capture'], '登录窗口马上要出现：不把前台还回去');
  } finally {
    release();   // 断言失败也要放行，免得清理时一直等着这个登录
  }
  const { loginId } = await begin;
  await sm.loginEnd({ loginId });
  // 计数回到零：之后的 open 照常还。
  focus.calls.length = 0;
  await sm.open({ url: 'http://localhost:5173/' });
  assert.deepEqual(focus.calls, ['capture', 'restore:com.example.app']);
});

test('focus: a login that fails to start, or is rejected before it starts, leaves no "login in progress" behind', async () => {
  const focus = fakeFocus('com.example.app');
  const { sm } = setup({ focus });
  await assert.rejects(sm.loginBegin({ url: 'http://localhost:5173/login-down' }));          // goto 失败：启动中途抛错
  await assert.rejects(sm.loginBegin({ url: 'http://localhost:5173/login.html', profile: 'nope' }), (e: E2kError) => e.code === 'usage');
  focus.calls.length = 0;
  await sm.open({ url: 'http://localhost:5173/' });
  assert.deepEqual(focus.calls, ['capture', 'restore:com.example.app']);
});

test('focus: a step that opens a page while a login window is still being started does not restore', async () => {
  const focus = fakeFocus('com.example.app');
  const { sm, fake } = setup({ focus });
  const gate = gateNextOpenPage(fake);
  const { session, pageId } = await opened(sm, fake);
  focus.calls.length = 0;
  const step = runningStep(sm, focus, session);
  await until(() => focus.calls.length === 1);
  const release = gate.hold();
  const begin = sm.loginBegin({ url: 'http://localhost:5173/login.html' });
  try {
    await until(() => gate.blocked());
    fake.emitPopup(pageId, 'http://localhost:5173/popup');
    assert.equal((await step).exit, 0);
    assert.deepEqual(focus.calls, ['capture'], '登录窗口马上要出现：不把前台还回去');
  } finally {
    release();
  }
  await sm.loginEnd(await begin);
});

test('focus: a step rejected as busy neither captures nor restores', async () => {
  const focus = fakeFocus();
  const { sm, fake } = setup({ focus });
  const { session } = await opened(sm, fake);
  focus.calls.length = 0;
  const first = runningStep(sm, focus, session, 150);
  await assert.rejects(sm.step({ session, ops: [{ op: 'snapshot' }] }), (e: E2kError) => e.code === 'busy');
  await first;
  assert.deepEqual(focus.calls, ['capture'], 'only the running step captured');
  await sm.close({ session });
});

test('focus: a step that ends in an error after opening a page still restores, and the error is unchanged', async () => {
  const { sm, fake } = await setupGroups();
  const focus = fakeFocus('com.example.app');
  (sm as unknown as { deps: SessionDeps }).deps.focus = focus;   // setupGate 建的管理器缺省是 noFocus；这条换成会记调用的假管家
  const a = await sm.open({ url: A_URL }); const pageId = fake.openPages().at(-1)!;
  focus.calls.length = 0;
  const step = sm.step({ session: a.session, ops: [{ op: 'wait', for: { ms: 300 } }] });
  const rejected = assert.rejects(step, FROZEN_STEP_ERROR);   // 步骤执行期间被重定向进别的组：冻结，step 抛 needs-human
  await until(() => focus.calls.length === 1);
  fake.emitPopup(pageId, 'about:blank');
  fake.emitHop(pageId, B_URL + 'landing');
  await rejected;
  assert.deepEqual(focus.calls, ['capture', 'restore:com.example.app']);
});

// 开始时登录窗口开着、结束时已经关了：「开始或结束时任一」里的「开始」那一半。登录窗口在 capture 里关掉（capture 在开始标志之后）。
test('focus: a login window that was open when open started but is closed by the end still blocks the restore', async () => {
  const calls: string[] = [];
  let c!: ReturnType<typeof setup>;
  let loginId = '';
  const focus: FocusKeeper = {
    capture: async () => { calls.push('capture'); await c.sm.loginEnd({ loginId }); return 'com.example.app'; },
    restore: async (t) => { calls.push(`restore:${t}`); },
  };
  c = setup({ focus });
  ({ loginId } = await c.sm.loginBegin({ url: 'http://localhost:5173/login.html' }));
  await c.sm.open({ url: 'http://localhost:5173/' });
  assert.deepEqual(calls, ['capture']);
});

test('focus: a login window that was open when a step started but is closed by the end still blocks the restore', async () => {
  const calls: string[] = [];
  let c!: ReturnType<typeof setup>;
  let loginId = '';
  let armed = false;
  const focus: FocusKeeper = {
    capture: async () => { calls.push('capture'); if (armed) await c.sm.loginEnd({ loginId }); return 'com.example.app'; },
    restore: async (t) => { calls.push(`restore:${t}`); },
  };
  c = setup({ focus });
  const { pageId, session } = await opened(c.sm, c.fake);
  ({ loginId } = await c.sm.loginBegin({ url: 'http://localhost:5173/login.html' }));
  calls.length = 0; armed = true;
  const step = c.sm.step({ session, ops: [{ op: 'wait', for: { ms: 300 } }] });
  await until(() => calls.length === 1);
  c.fake.emitPopup(pageId, 'http://localhost:5173/popup');
  await step;
  assert.deepEqual(calls, ['capture']);
});
