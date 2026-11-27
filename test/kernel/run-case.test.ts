import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readCaseFile } from '../../src/cases/case.ts';
import type { CaseFile, CaseStep } from '../../src/cases/case.ts';
import { runCase } from '../../src/cases/run-case.ts';
import type { RunOutcome } from '../../src/cases/run-case.ts';
import { main } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/main.ts';
import { saveCase } from '../../src/cli/commands.ts';
import { noFocus } from '../../src/kernel/focus.ts';
import { startKernel } from '../../src/kernel/server.ts';
import type { Driver } from '../../src/driver/types.ts';
import { call } from '../../src/shared/client.ts';
import { E2kError } from '../../src/shared/errors.ts';
import type { Method } from '../../src/shared/protocol.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';
import { answeringDeny, fakeDialog } from '../support/fake-dialog.ts';
import { approveRulesFile } from '../support/approve-rules.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

// 一个不能出现在任何输出里的值：运行时拼出来，不写成字面量。
const secret = ['pw', 'Zq7', 'x91', 'Lk'].join('-');

const SID = 's-a1b2c3';
const BASIS = '原会话里 agent 的判定，重跑不判定';

// ---- 假时钟、脚本化的 send ----

function fakeClock(realMs = 0) {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { slept.push(ms); if (realMs > 0) await sleep(realMs); t += ms; },
    slept,
    elapsed: () => t,
  };
}

interface Rec { method: Method; params: Record<string, unknown> }
type Handler = (n: number, params: Record<string, unknown>) => unknown;

function stepOk(ops: number, over: Record<string, unknown> = {}): unknown {
  return { session: SID, results: [], tallies: { ok: ops, match: 0, mismatch: 0, failed: 0, notRun: 0 }, exit: 0, blocked: null, next: null, writesBlocked: 0, notices: [], ...over };
}

const openOk = { session: SID, name: 'x', url: 'http://localhost:5173/', title: '', mode: 'default', runDir: '/r', snapshot: '', blocked: null, next: null, profile: 'default', borrowed: false, identity: null };
const closeOk = { session: SID, runDir: '/r', reportPath: '/r/report.html', resultPath: '/r/result.json', tallies: { ok: 0, match: 0, mismatch: 0, failed: 0, notRun: 0 }, consistency: 'ok', exit: 0 };

function scripted(over: { open?: Handler; step?: Handler; close?: Handler } = {}) {
  const calls: Rec[] = [];
  const counts: Record<string, number> = { open: 0, step: 0, close: 0 };
  const send = async (method: Method, params: unknown): Promise<unknown> => {
    const p = params as Record<string, unknown>;
    calls.push({ method, params: p });
    const n = (counts[method] = (counts[method] ?? 0) + 1);
    const h = over[method as 'open' | 'step' | 'close'];
    if (h !== undefined) return h(n, p);
    if (method === 'open') return openOk;
    if (method === 'step') return stepOk((p.ops as unknown[]).length);
    if (method === 'close') return closeOk;
    throw new Error(`unexpected ${method}`);
  };
  const of = (m: Method): Rec[] => calls.filter((c) => c.method === m);
  return { send, calls, of };
}

const pending = (id: string | null): E2kError => new E2kError('wait-approval', id === null ? '等人在弹框里批准' : `等人在弹框里批准：放行写请求的声明（请求 ${id}）`);

// ---- 用例构造 ----

const click = (seq: number, target = '#go'): CaseStep => ({ seq, op: { op: 'click', target } });
const skipStep = (seq: number, op = 'eval', why = 'eval 不能重放'): CaseStep => ({ seq, skip: { op, why } });
const clicks = (n: number): CaseStep[] => Array.from({ length: n }, (_, i) => click(i + 1));

function caseOf(over: Partial<CaseFile> = {}): CaseFile {
  return {
    e2kCase: 1, name: 'replay', source: { session: 's-000001', kernelVersion: '0.1.0' },
    open: { url: 'http://localhost:5173/', profile: 'default', viewport: null, touch: false, readonly: false, allow: [] },
    steps: [click(1)], allow: [], findings: [], containsWrites: false,
    ...over,
  };
}

const allowAt = (seq: number, url = 'http://localhost:5173/api/save', operation?: string): CaseFile['allow'][number] => ({ method: 'POST', url, ...(operation === undefined ? {} : { operation }), seq });

const lens = (calls: Rec[]): number[] => calls.map((c) => (c.params.ops as unknown[]).length);

describe('runCase with a scripted kernel', () => {
  test('a clean replay is open, one step call, close with verdict pass and exit 0', async () => {
    const s = scripted();
    const r = await runCase(s.send, caseOf(), { clock: fakeClock() });
    assert.deepEqual(s.calls.map((c) => c.method), ['open', 'step', 'close']);
    assert.deepEqual(s.calls[0]!.params, { url: 'http://localhost:5173/', name: 'replay', profile: 'default' });
    assert.deepEqual(s.calls[1]!.params, { session: SID, ops: [{ op: 'click', target: '#go' }] });
    assert.deepEqual(s.calls[2]!.params, { session: SID, verdict: { value: 'pass' } });
    assert.deepEqual([r.exit, r.session, r.reportPath, r.verdict, r.skipped, r.error], [0, SID, '/r/report.html', 'pass', 0, null]);
    assert.deepEqual(r.tallies, { ok: 1, match: 0, mismatch: 0, failed: 0, notRun: 0 });
  });

  test('open gets the case parameters, the name can be overridden, and an empty allow list is not sent', async () => {
    const s = scripted();
    const c = caseOf({ open: { url: 'http://localhost:5173/', profile: 'a/t1', viewport: { width: 800, height: 600 }, touch: true, readonly: true,
      allow: [{ method: 'POST', url: 'http://localhost:5173/x', operation: 'Save' }] } });
    await runCase(s.send, c, { name: 'other-name', clock: fakeClock() });
    assert.deepEqual(s.calls[0]!.params, { url: 'http://localhost:5173/', name: 'other-name', profile: 'a/t1', viewport: { width: 800, height: 600 }, touch: true, readonly: true,
      allow: [{ method: 'POST', url: 'http://localhost:5173/x', operation: 'Save' }] });
  });

  test('more than 50 steps are sent in batches of 50', async () => {
    const s = scripted();
    const r = await runCase(s.send, caseOf({ steps: clicks(120) }), { clock: fakeClock() });
    assert.deepEqual(lens(s.of('step')), [50, 50, 20]);
    assert.ok(s.of('step').every((c) => !('keepGoing' in c.params) && !('allow' in c.params)));
    assert.equal(r.verdict, 'pass');
    assert.deepEqual(r.tallies, { ok: 120, match: 0, mismatch: 0, failed: 0, notRun: 0 });
  });

  test('declarations are sent with the batch that starts at their seq', async () => {
    const s = scripted();
    const c = caseOf({ steps: clicks(8), allow: [allowAt(5, 'http://localhost:5173/api/a', 'Save'), allowAt(5, 'http://localhost:5173/api/b')] });
    await runCase(s.send, c, { clock: fakeClock() });
    assert.deepEqual(lens(s.of('step')), [4, 4]);
    assert.ok(!('allow' in s.of('step')[0]!.params));
    assert.deepEqual(s.of('step')[1]!.params.allow, [{ method: 'POST', url: 'http://localhost:5173/api/a', operation: 'Save' }, { method: 'POST', url: 'http://localhost:5173/api/b' }]);
  });

  test('a declaration whose seq is a skipped step goes to the first runnable step after it; one past the end goes to the last batch', async () => {
    const s = scripted();
    const steps = [click(1), click(2), skipStep(3), click(4), click(5)];
    await runCase(s.send, caseOf({ steps, allow: [allowAt(3, 'http://localhost:5173/api/a'), allowAt(99, 'http://localhost:5173/api/z')] }), { clock: fakeClock() });
    assert.deepEqual(lens(s.of('step')), [2, 2], 'the batch is cut at step 4, not at the skipped 3');
    assert.deepEqual(s.of('step')[1]!.params.allow, [{ method: 'POST', url: 'http://localhost:5173/api/a' }, { method: 'POST', url: 'http://localhost:5173/api/z' }]);
    assert.ok(!('allow' in s.of('step')[0]!.params));
  });

  test('a declaration in the middle of a 50-step run cuts the batch there', async () => {
    const s = scripted();
    await runCase(s.send, caseOf({ steps: clicks(60), allow: [allowAt(55)] }), { clock: fakeClock() });
    assert.deepEqual(lens(s.of('step')), [50, 4, 6]);
    assert.ok(!('allow' in s.of('step')[1]!.params) && 'allow' in s.of('step')[2]!.params);
  });

  test('declarations that pile up on one batch beyond 12 are refused before the session is opened', async () => {
    const s = scripted();
    const allow = Array.from({ length: 13 }, (_, i) => allowAt(i < 7 ? 1 : 2, `http://localhost:5173/api/${i}`));
    const r = await runCase(s.send, caseOf({ steps: [skipStep(1), skipStep(2), click(3)], allow }), { clock: fakeClock() });
    assert.equal(s.calls.length, 0);
    assert.deepEqual([r.exit, r.session, r.verdict, r.error?.code], [2, null, null, 'usage']);
  });

  test('a mismatch makes the verdict fail and the exit 10, and the run goes on', async () => {
    const s = scripted({ step: (n, p) => stepOk((p.ops as unknown[]).length, n === 1 ? { exit: 10, tallies: { ok: 49, match: 0, mismatch: 1, failed: 0, notRun: 0 } } : {}) });
    const r = await runCase(s.send, caseOf({ steps: clicks(60) }), { clock: fakeClock() });
    assert.equal(s.of('step').length, 2);
    assert.deepEqual([r.exit, r.verdict], [10, 'fail']);
    const v = (s.of('close')[0]!.params.verdict) as { value: string; because: string };
    assert.equal(v.value, 'fail'); assert.match(v.because, /1 处不符/);
  });

  test('a failed action exits 11, the rest is not run, and the batches after it are not sent', async () => {
    const s = scripted({ step: () => stepOk(50, { exit: 11, tallies: { ok: 10, match: 0, mismatch: 0, failed: 1, notRun: 39 } }) });
    const r = await runCase(s.send, caseOf({ steps: clicks(120) }), { clock: fakeClock() });
    assert.equal(s.of('step').length, 1);
    assert.deepEqual([r.exit, r.verdict], [11, 'fail']);
    assert.deepEqual(r.tallies, { ok: 10, match: 0, mismatch: 0, failed: 1, notRun: 39 + 70 });
    const v = (s.of('close')[0]!.params.verdict) as { value: string; because: string };
    assert.match(v.because, /1 步执行失败/); assert.match(v.because, /109 步未执行/);
  });

  test('a failure beats a mismatch for the exit code, and both are a fail verdict', async () => {
    const s = scripted({ step: (n) => (n === 1 ? stepOk(1, { exit: 10, tallies: { ok: 0, match: 0, mismatch: 1, failed: 0, notRun: 0 } }) : stepOk(1, { exit: 11, tallies: { ok: 0, match: 0, mismatch: 0, failed: 1, notRun: 0 } })) });
    const r = await runCase(s.send, caseOf({ steps: [click(1), click(2)], allow: [allowAt(2)] }), { clock: fakeClock() });
    assert.deepEqual([s.of('step').length, r.exit, r.verdict], [2, 11, 'fail']);
  });

  test('skipped steps are not sent, make the verdict undetermined, and are listed in notDone one by one', async () => {
    const s = scripted();
    const c = caseOf({ steps: [click(1), skipStep(2, 'eval', 'eval 不能重放'), click(3), skipStep(4, 'click', '目标是快照引用，没有稳定的选择器')] });
    const r = await runCase(s.send, c, { clock: fakeClock() });
    assert.deepEqual(lens(s.of('step')), [2]);
    const close = s.of('close')[0]!.params;
    assert.deepEqual(close.notDone, ['步骤 2（eval）不能重放：eval 不能重放', '步骤 4（click）不能重放：目标是快照引用，没有稳定的选择器']);
    const v = close.verdict as { value: string; because: string };
    assert.equal(v.value, 'undetermined'); assert.match(v.because, /2 步不能重放/);
    assert.deepEqual([r.exit, r.verdict, r.skipped], [0, 'undetermined', 2]);
  });

  test('more than 20 skipped steps keep 19 lines and one line that counts the rest', async () => {
    const s = scripted();
    const steps = [click(1), ...Array.from({ length: 25 }, (_, i) => skipStep(i + 2))];
    await runCase(s.send, caseOf({ steps }), { clock: fakeClock() });
    const notDone = s.of('close')[0]!.params.notDone as string[];
    assert.equal(notDone.length, 20);
    assert.equal(notDone[0], '步骤 2（eval）不能重放：eval 不能重放');
    assert.equal(notDone[19], '另有 6 步不能重放');
    assert.equal(s.of('close')[0]!.params.verdict && (s.of('close')[0]!.params.verdict as { value: string }).value, 'undetermined');
  });

  test('a fail verdict still lists the skipped steps', async () => {
    const s = scripted({ step: () => stepOk(1, { exit: 10, tallies: { ok: 0, match: 0, mismatch: 1, failed: 0, notRun: 0 } }) });
    await runCase(s.send, caseOf({ steps: [click(1), skipStep(2)] }), { clock: fakeClock() });
    const close = s.of('close')[0]!.params;
    assert.equal((close.verdict as { value: string }).value, 'fail');
    assert.deepEqual(close.notDone, ['步骤 2（eval）不能重放：eval 不能重放']);
  });

  test('findings come back as undetermined claims with the fixed basis; no findings sends none', async () => {
    const s = scripted();
    await runCase(s.send, caseOf({ findings: [{ claim: '页面上有保存按钮' }, { claim: '第二条' }] }), { clock: fakeClock() });
    assert.deepEqual(s.of('close')[0]!.params.findings, [
      { claim: '页面上有保存按钮', basis: BASIS, verdict: 'undetermined' }, { claim: '第二条', basis: BASIS, verdict: 'undetermined' },
    ]);
    const none = scripted();
    await runCase(none.send, caseOf(), { clock: fakeClock() });
    assert.ok(!('findings' in none.of('close')[0]!.params) && !('notDone' in none.of('close')[0]!.params));
  });

  test('a case with only skipped steps opens, sends no step, and closes undetermined', async () => {
    const s = scripted();
    const r = await runCase(s.send, caseOf({ steps: [skipStep(1)] }), { clock: fakeClock() });
    assert.deepEqual(s.calls.map((c) => c.method), ['open', 'close']);
    assert.equal(r.verdict, 'undetermined');
  });

  // ---- 21：等人在弹框里批准 ----

  test('21 on open is retried every 2 seconds with the same parameters until it goes through; the prompt hook fires once', async () => {
    const waiting: (string | null)[] = [];
    const s = scripted({ open: (n) => { if (n <= 3) throw pending('a-111111'); return openOk; } });
    const clock = fakeClock();
    const r = await runCase(s.send, caseOf(), { clock, onWaiting: (id) => { waiting.push(id); } });
    assert.deepEqual(clock.slept, [2000, 2000, 2000]);
    assert.deepEqual(waiting, ['a-111111']);
    assert.equal(s.of('open').length, 4);
    assert.deepEqual(s.of('open')[3]!.params, s.of('open')[0]!.params);
    assert.equal(r.verdict, 'pass');
  });

  test('the same request id for 120 seconds exits 21; there is no session to close', async () => {
    const s = scripted({ open: () => { throw pending('a-222222'); } });
    const clock = fakeClock();
    const r = await runCase(s.send, caseOf(), { clock });
    assert.equal(clock.slept.length, 60); assert.ok(clock.slept.every((ms) => ms === 2000)); assert.equal(clock.elapsed(), 120_000);
    assert.deepEqual([r.exit, r.session, r.verdict, r.reportPath, r.tallies, r.error?.code], [21, null, null, null, null, 'wait-approval']);
    assert.deepEqual(s.calls.map((c) => c.method), Array(61).fill('open'));
  });

  test('the 120 seconds start again for each new request id', async () => {
    const waiting: (string | null)[] = [];
    // 每个 id 等 100 秒（50 次），共三个：总共 300 秒也不超时。
    const s = scripted({ open: (n) => { if (n <= 150) throw pending(`a-${String(Math.floor((n - 1) / 50) + 1).repeat(6)}`); return openOk; } });
    const clock = fakeClock();
    const r = await runCase(s.send, caseOf(), { clock, onWaiting: (id) => { waiting.push(id); } });
    assert.equal(r.verdict, 'pass');
    assert.equal(clock.elapsed(), 300_000);
    assert.deepEqual(waiting, ['a-111111', 'a-222222', 'a-333333']);
  });

  test('a message without an id counts as its own id: going from an id to none restarts the clock, and none for 120 seconds exits 21', async () => {
    const s = scripted({ open: (n) => { if (n <= 50) throw pending('a-444444'); throw pending(null); } });
    const clock = fakeClock();
    const waiting: (string | null)[] = [];
    const r = await runCase(s.send, caseOf(), { clock, onWaiting: (id) => { waiting.push(id); } });
    assert.deepEqual(waiting, ['a-444444', null]);
    assert.equal(clock.elapsed(), 100_000 + 120_000);
    assert.equal(r.exit, 21);
  });

  test('21 on a step carrying declarations is retried the same way, with the same parameters', async () => {
    const s = scripted({ step: (n, p) => { if (n <= 2) throw pending('a-555555'); return stepOk((p.ops as unknown[]).length); } });
    const clock = fakeClock();
    const r = await runCase(s.send, caseOf({ allow: [allowAt(1)] }), { clock });
    assert.deepEqual(clock.slept, [2000, 2000]);
    assert.equal(s.of('step').length, 3);
    assert.deepEqual(s.of('step')[2]!.params, s.of('step')[0]!.params);
    assert.deepEqual(r.verdict, 'pass');
  });

  test('21 on a step for 120 seconds exits 21 and still closes the session with undetermined', async () => {
    const s = scripted({ step: () => { throw pending('a-666666'); } });
    const clock = fakeClock();
    const r = await runCase(s.send, caseOf({ allow: [allowAt(1)] }), { clock });
    assert.equal(clock.elapsed(), 120_000);
    assert.equal(s.of('close').length, 1);
    assert.equal((s.of('close')[0]!.params.verdict as { value: string }).value, 'undetermined');
    assert.deepEqual([r.exit, r.verdict, r.session, r.error?.code], [21, 'undetermined', SID, 'wait-approval']);
  });

  // ---- 登录墙、中途出错 ----

  test('a step that hits a login wall stops the run: undetermined because 撞到登录墙, exit 20, no more batches', async () => {
    const s = scripted({ step: () => stepOk(5, { exit: 20, blocked: 'login', next: 'x' }) });
    const r = await runCase(s.send, caseOf({ steps: clicks(120) }), { clock: fakeClock() });
    assert.equal(s.of('step').length, 1);
    const v = s.of('close')[0]!.params.verdict as { value: string; because: string };
    assert.equal(v.value, 'undetermined'); assert.match(v.because, /撞到登录墙/);
    assert.deepEqual([r.exit, r.verdict], [20, 'undetermined']);
  });

  test('a login wall beats a failure and a mismatch for the exit code', async () => {
    const s = scripted({ step: () => stepOk(5, { exit: 20, blocked: 'login', tallies: { ok: 0, match: 0, mismatch: 1, failed: 1, notRun: 3 } }) });
    const r = await runCase(s.send, caseOf({ steps: clicks(5) }), { clock: fakeClock() });
    assert.deepEqual([r.exit, r.verdict], [20, 'undetermined']);
  });

  test('an open that lands on a login wall sends no step: close undetermined because 撞到登录墙, exit 20', async () => {
    const s = scripted({ open: () => ({ ...openOk, blocked: 'login' }) });
    const r = await runCase(s.send, caseOf(), { clock: fakeClock() });
    assert.deepEqual(s.calls.map((c) => c.method), ['open', 'close']);
    assert.match((s.of('close')[0]!.params.verdict as { because: string }).because, /撞到登录墙/);
    assert.deepEqual([r.exit, r.verdict], [20, 'undetermined']);
  });

  test('an error mid-run still closes the session with undetermined, and the error code is the exit code', async () => {
    const s = scripted({ step: (n, p) => { if (n === 2) throw new E2kError('needs-human', `要人处理 ${secret}`, '请人看一下'); return stepOk((p.ops as unknown[]).length); } });
    const r = await runCase(s.send, caseOf({ steps: clicks(120) }), { clock: fakeClock() });
    assert.deepEqual(s.calls.map((c) => c.method), ['open', 'step', 'step', 'close']);
    const v = s.of('close')[0]!.params.verdict as { value: string; because: string };
    assert.equal(v.value, 'undetermined'); assert.match(v.because, /第 2 批/); assert.ok(!v.because.includes(secret), 'because is counts, never the error text');
    assert.deepEqual([r.exit, r.verdict, r.session, r.error?.code, r.error?.next], [22, 'undetermined', SID, 'needs-human', '请人看一下']);
    assert.equal(r.reportPath, '/r/report.html');
  });

  test('every error code is the exit code of the run, and a failing close does not hide the first error', async () => {
    for (const [code, exit] of [['usage', 2], ['busy', 2], ['internal', 1], ['not-found', 2]] as const) {
      const s = scripted({ step: () => { throw new E2kError(code, 'x'); }, close: () => { throw new E2kError('internal', 'close failed'); } });
      const r = await runCase(s.send, caseOf(), { clock: fakeClock() });
      assert.deepEqual([r.exit, r.error?.code, r.reportPath, s.of('close').length], [exit, code, null, 1], code);
    }
  });

  test('a wait-login error from a step is a login wall, not an error: undetermined because 撞到登录墙, exit 20', async () => {
    const s = scripted({ step: () => { throw new E2kError('wait-login', 'x'); } });
    const r = await runCase(s.send, caseOf(), { clock: fakeClock() });
    assert.match((s.of('close')[0]!.params.verdict as { because: string }).because, /撞到登录墙/);
    assert.deepEqual([r.exit, r.verdict, r.error], [20, 'undetermined', null]);
  });

  test('a mismatch earlier and an error later: the error code wins and the verdict is undetermined', async () => {
    const s = scripted({ step: (n) => { if (n === 2) throw new E2kError('internal', 'boom'); return stepOk(50, { exit: 10, tallies: { ok: 49, match: 0, mismatch: 1, failed: 0, notRun: 0 } }); } });
    const r = await runCase(s.send, caseOf({ steps: clicks(60) }), { clock: fakeClock() });
    assert.deepEqual([r.exit, r.verdict], [1, 'undetermined']);
  });

  test('errors on open carry their exit code; nothing is closed', async () => {
    for (const [code, exit] of [['usage', 2], ['needs-human', 22], ['internal', 1]] as const) {
      const s = scripted({ open: () => { throw new E2kError(code, 'x', 'next-hint'); } });
      const r = await runCase(s.send, caseOf(), { clock: fakeClock() });
      assert.deepEqual([r.exit, r.session, r.error?.code, r.error?.next, s.calls.length], [exit, null, code, 'next-hint', 1], code);
    }
  });

  test('a reply that is not what a kernel sends is an internal error, and an opened session is still closed', async () => {
    const bad = scripted({ open: () => ({ nope: 1 }) });
    const r1 = await runCase(bad.send, caseOf(), { clock: fakeClock() });
    assert.deepEqual([r1.exit, r1.error?.code, bad.calls.length], [1, 'internal', 1]);
    const bad2 = scripted({ step: () => ({ exit: 3 }) });
    const r2 = await runCase(bad2.send, caseOf(), { clock: fakeClock() });
    assert.deepEqual([r2.exit, r2.error?.code, r2.verdict, bad2.of('close').length], [1, 'internal', 'undetermined', 1]);
  });

  test('an exception that is not an E2kError is not swallowed', async () => {
    const s = scripted({ step: () => { throw new TypeError('bug'); } });
    await assert.rejects(runCase(s.send, caseOf(), { clock: fakeClock() }), TypeError);
    assert.equal(s.of('close').length, 1, 'the session is closed on the way out');
  });
});

// ---- 用真的内核和假驱动 ----

const PAGES: Record<string, FakePageSpec> = {
  'http://localhost:5173/': { elements: { '#go': {}, '#status': { text: 'Added' }, '#gone': { failWith: 'not-found' } } },
  'http://localhost:5173/wall': { snapshot: '- textbox "Password"', passwordField: true, elements: { '#go': {} } },
};

interface Rig { home: ReturnType<typeof makeTmpHome>; fake: FakeDriver; send(m: Method, p: unknown): Promise<unknown>; stop(): Promise<void> }

async function rig(o: { rules?: unknown; dialog?: ReturnType<typeof fakeDialog> } = {}): Promise<Rig> {
  const home = makeTmpHome();
  if (o.rules !== undefined) { writeFileSync(home.home.rulesFile, JSON.stringify(o.rules)); approveRulesFile(home.home); }
  const fake = new FakeDriver({ pages: PAGES });
  const kernel = await startKernel({ focus: noFocus, home: home.home, driver: fake, dialog: o.dialog ?? fakeDialog() });
  const send = async (m: Method, p: unknown): Promise<unknown> => {
    const r = await call(home.home, m, p);
    if (!r.ok) throw new E2kError(r.error.code, r.error.message, r.error.next);
    return r.result;
  };
  return { home, fake, send, stop: async () => { await kernel.stop(); home.cleanup(); } };
}

async function withRig(o: Parameters<typeof rig>[0], fn: (r: Rig) => Promise<void>): Promise<void> {
  const r = await rig(o);
  try { await fn(r); } finally { await r.stop(); }
}

const resultOf = (o: RunOutcome): { verdict: { value: string; because?: string }; actions: { op: unknown; outcome: string }[]; findings: unknown[]; start: { deny: { allow: unknown[] } | null } } => {
  assert.notEqual(o.session, null);
  const text = readFileSync(join(resultDirOf(o), 'result.json'), 'utf8');
  return JSON.parse(text) as ReturnType<typeof resultOf>;
};
function resultDirOf(o: RunOutcome): string {
  assert.ok(o.reportPath !== null);
  return o.reportPath.replace(/\/report\.html$/, '');
}

describe('runCase against a real kernel with a fake driver', () => {
  test('run replays a saved case and writes a report with verdict pass; the actions match the original session', async () => {
    await withRig({}, async (r) => {
      const out = join(realpathSync(mkdtempSync(join(tmpdir(), 'e2k-out-'))), 'case.json');
      try {
        const opened = await r.send('open', { url: 'http://localhost:5173/', name: 'orig-run' }) as { session: string };
        const ops = [{ op: 'click', target: '#go' }, { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Added' }];
        await r.send('step', { session: opened.session, ops });
        const closed = await r.send('close', { session: opened.session, verdict: { value: 'pass' } }) as { resultPath: string };
        const original = JSON.parse(readFileSync(closed.resultPath, 'utf8')) as { actions: { op: unknown }[] };
        assert.equal(saveCase(r.home.home, { session: opened.session, out }).exit, 0);
        const outcome = await runCase(r.send, readCaseFile(out), { name: 'again', clock: fakeClock() });
        assert.deepEqual([outcome.exit, outcome.verdict, outcome.skipped], [0, 'pass', 0]);
        assert.notEqual(outcome.session, opened.session);
        const replay = resultOf(outcome);
        assert.equal(replay.verdict.value, 'pass');
        assert.deepEqual(replay.actions.map((a) => a.op), original.actions.map((a) => a.op));
        assert.deepEqual(outcome.tallies, { ok: 1, match: 1, mismatch: 0, failed: 0, notRun: 0 });
      } finally { rmSync(join(out, '..'), { recursive: true, force: true }); }
    });
  });

  test('a mismatch makes the verdict fail in the report and the exit 10', async () => {
    await withRig({}, async (r) => {
      const c = caseOf({ steps: [click(1), { seq: 2, op: { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Wrong' } }, click(3)] });
      const o = await runCase(r.send, c, { clock: fakeClock() });
      assert.deepEqual([o.exit, o.verdict], [10, 'fail']);
      const res = resultOf(o);
      assert.equal(res.verdict.value, 'fail'); assert.match(res.verdict.because ?? '', /1 处不符/);
      assert.equal(res.actions.length, 3, 'the step after the mismatch still ran');
    });
  });

  test('a failed action exits 11 and the rest is not run: the batches after the failing one are never sent', async () => {
    await withRig({}, async (r) => {
      const c = caseOf({ steps: [click(1, '#gone'), ...Array.from({ length: 59 }, (_, i) => click(i + 2))] });
      const o = await runCase(r.send, c, { clock: fakeClock() });
      assert.deepEqual([o.exit, o.verdict], [11, 'fail']);
      const res = resultOf(o);
      assert.equal(res.actions.length, 50, 'only the first batch reached the kernel');
      assert.deepEqual(res.actions.slice(0, 2).map((a) => a.outcome), ['failed', 'not-run']);
      assert.equal(res.verdict.value, 'fail');
    });
  });

  test('skipped steps make the verdict undetermined in the report and list each one in notDone', async () => {
    await withRig({}, async (r) => {
      const o = await runCase(r.send, caseOf({ steps: [click(1), skipStep(2, 'eval', 'eval 不能重放'), skipStep(3, 'fill', '内容已被脱敏，不能重放')] }), { clock: fakeClock() });
      assert.deepEqual([o.exit, o.verdict, o.skipped], [0, 'undetermined', 2]);
      const res = JSON.parse(readFileSync(join(resultDirOf(o), 'result.json'), 'utf8')) as { verdict: { value: string }; notDone: string[] };
      assert.equal(res.verdict.value, 'undetermined');
      assert.deepEqual(res.notDone, ['步骤 2（eval）不能重放：eval 不能重放', '步骤 3（fill）不能重放：内容已被脱敏，不能重放']);
    });
  });

  test('findings come back as undetermined claims in the report', async () => {
    await withRig({}, async (r) => {
      const o = await runCase(r.send, caseOf({ findings: [{ claim: '按钮在页面右上角' }] }), { clock: fakeClock() });
      assert.deepEqual(resultOf(o).findings, [{ claim: '按钮在页面右上角', basis: BASIS, verdict: 'undetermined' }]);
    });
  });

  test('a step that hits a login wall stops the run: verdict undetermined because 撞到登录墙, exit 20', async () => {
    await withRig({}, async (r) => {
      const c = caseOf({ steps: [click(1), { seq: 2, op: { op: 'goto', url: 'http://localhost:5173/wall' } }, click(3)] });
      const o = await runCase(r.send, c, { clock: fakeClock() });
      assert.deepEqual([o.exit, o.verdict], [20, 'undetermined']);
      const res = resultOf(o);
      assert.equal(res.verdict.value, 'undetermined'); assert.match(res.verdict.because ?? '', /撞到登录墙/);
    });
  });

  test('a case saved from a deny-host session asks the deny dialog again on run (open.allow, 可写) and goes through after the click', async () => {
    const dialog = fakeDialog(answeringDeny('可写'));
    await withRig({ rules: { version: 1, rules: [{ match: 'localhost', mode: 'deny' }] }, dialog }, async (r) => {
      const allow = [{ method: 'POST', url: 'http://localhost:5173/api/save', operation: 'Save' }];
      const c = caseOf({ open: { url: 'http://localhost:5173/', profile: 'default', viewport: null, touch: false, readonly: false, allow }, containsWrites: true });
      const clock = fakeClock(10);
      const waiting: (string | null)[] = [];
      const o = await runCase(r.send, c, { clock, onWaiting: (id) => { waiting.push(id); } });
      assert.deepEqual([o.exit, o.verdict], [0, 'pass']);
      assert.equal(dialog.requests.length, 1);
      assert.match(dialog.requests[0]!.title, /打开不允许的域名/);
      assert.ok(clock.slept.length >= 1 && clock.slept.every((ms) => ms === 2000));
      assert.equal(waiting.length, 1);
      assert.equal(resultOf(o).start.deny?.allow.length, 1);
    });
  });

  test('a declaration approved before on a read-only host is not asked again on run', async () => {
    const dialog = fakeDialog((q) => ({ kind: 'button', button: q.buttons.includes('放行') ? '放行' : '拒绝' }));
    await withRig({ dialog }, async (r) => {
      const c = caseOf({ open: { url: 'http://localhost:5173/', profile: 'default', viewport: null, touch: false, readonly: true, allow: [] }, allow: [allowAt(1, 'http://localhost:5173/api/items', 'Save')], containsWrites: true });
      const first = fakeClock(10);
      const o1 = await runCase(r.send, c, { clock: first });
      assert.deepEqual([o1.exit, o1.verdict], [0, 'pass']);
      assert.equal(dialog.requests.length, 1);
      assert.match(dialog.requests[0]!.lines.join('\n'), /POST http:\/\/localhost:5173\/api\/items/);
      assert.ok(first.slept.length >= 1);
      const second = fakeClock(10);
      const o2 = await runCase(r.send, c, { clock: second });
      assert.deepEqual([o2.exit, o2.verdict], [0, 'pass']);
      assert.equal(dialog.requests.length, 1, 'no second question');
      assert.deepEqual(second.slept, []);
    });
  });
});

// ---- run 命令：读用例文件，拒绝在开会话之前 ----

function io(env: NodeJS.ProcessEnv, driver: () => Promise<Driver>, realSleepMs = 0): Io & { outText(): string; errText(): string } {
  const out: string[] = []; const err: string[] = [];
  const clock = fakeClock(realSleepMs);
  return {
    clock, out: (s) => { out.push(s); }, err: (s) => { err.push(s); }, env, selfCmd: 'node bin/e2k.js',
    stdin: { isTTY: true, readLine: async () => '', readAll: async () => '' },
    makeDriver: driver, managerName: async () => 'Aqua',
    onStopSignal: () => {}, exit: () => {},
    outText: () => out.join('\n'), errText: () => err.join('\n'),
  };
}

describe('e2k run', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'e2k-case-')));
  after(() => { rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const put = (text: string): string => { const p = join(dir, `c${++n}.json`); writeFileSync(p, text); return p; };
  const good = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...caseOf(), ...over });

  test('run <file> replays the case, prints the verdict and the report, and exits with the run\'s code (--json too)', async () => {
    await withRig({}, async (r) => {
      const file = put(good({ name: 'cli-replay' }));
      const t = io(r.home.env, async () => r.fake);
      assert.equal(await main(['run', file], t), 0, t.errText());
      assert.match(t.outText(), /结论 pass/); assert.match(t.outText(), /报告 /);
      const j = io(r.home.env, async () => r.fake);
      assert.equal(await main(['run', file, '--name', 'renamed', '--json'], j), 0, j.errText());
      const parsed = JSON.parse(j.outText()) as { session: string; verdict: string; reportPath: string; skipped: number; error: unknown };
      assert.deepEqual([parsed.verdict, parsed.skipped, parsed.error], ['pass', 0, null]);
      assert.match(parsed.reportPath, /renamed/);
      const bad = put(good({ steps: [click(1, '#gone')] }));
      const f = io(r.home.env, async () => r.fake);
      assert.equal(await main(['run', bad], f), 11);
      assert.match(f.outText(), /结论 fail/);
    });
  });

  test('run with no file, two files or an unknown option is a usage error; run --name with a bad name is refused before open', async () => {
    await withRig({}, async (r) => {
      for (const args of [['run'], ['run', 'a.json', 'b.json'], ['run', put(good()), '--nope'], ['run', put(good()), '--name']]) {
        assert.equal(await main(args, io(r.home.env, async () => r.fake)), 2, args.join(' '));
      }
      const t = io(r.home.env, async () => r.fake);
      assert.equal(await main(['run', put(good()), '--name', `Bad Name ${secret}`], t), 2);
      assert.ok(!t.errText().includes(secret));
      assert.equal(r.fake.launches, 0);
    });
  });

  test('a case file that is a symlink, too big, not JSON, hand-edited or missing is refused before any open, and nothing of it is echoed', async () => {
    await withRig({}, async (r) => {
      const real = put(good());
      const link = join(dir, 'link.json'); symlinkSync(real, link);
      const big = put(`{"e2kCase":1,"pad":"${'x'.repeat(1_000_100)}"}`);
      const files: [string, string][] = [
        ['symlink', link], ['too big', big], ['missing', join(dir, 'missing.json')], ['directory', dir],
        ['not json', put(`not json ${secret}`)],
        ['wrong version', put(good({ e2kCase: 2 }))],
        ['extra key', put(good({ [secret]: 1 }))],
        ['extra key in open', put(good({ open: { ...caseOf().open, [secret]: 1 } }))],
        ['bad op', put(good({ steps: [{ seq: 1, op: { op: 'click', target: '#go', [secret]: 1 } }] }))],
        ['unknown op', put(good({ steps: [{ seq: 1, op: { op: `nope-${secret}` } }] }))],
        ['eval op', put(good({ steps: [{ seq: 1, op: { op: 'eval', js: '1' } }] }))],
        ['empty steps', put(good({ steps: [] }))],
        ['bad url', put(good({ open: { ...caseOf().open, url: `javascript:${secret}` } }))],
      ];
      for (const [what, file] of files) {
        const t = io(r.home.env, async () => r.fake);
        assert.equal(await main(['run', file, '--json'], t), 2, what);
        const all = t.outText() + t.errText();
        assert.ok(!all.includes(secret), `${what}: no echo`);
        assert.ok(all.length > 0, what);
      }
      assert.equal(r.fake.launches, 0, 'no browser was launched');
      assert.equal(r.fake.calls.length, 0);
      const status = await r.send('status', {}) as { sessions: unknown[] };
      assert.deepEqual(status.sessions, [], 'no session was opened');
    });
  });

  test('the wait for a person goes to standard error (so --json stays clean) and the run goes through after the click', async () => {
    const dialog = fakeDialog(answeringDeny('只读'));
    await withRig({ rules: { version: 1, rules: [{ match: 'localhost', mode: 'deny' }] }, dialog }, async (r) => {
      const t = io(r.home.env, async () => r.fake, 10);
      assert.equal(await main(['run', put(good()), '--json'], t), 0, t.errText());
      assert.match(t.errText(), /^请在弹出的对话框里选择（请求 a-[0-9a-f]{6}）$/m);
      assert.equal((JSON.parse(t.outText()) as { verdict: string }).verdict, 'pass');
    });
  });

  test('run without a kernel prints how to start it and exits 22', async () => {
    const empty = makeTmpHome();
    try {
      const t = io(empty.env, async () => new FakeDriver({ pages: PAGES }));
      assert.equal(await main(['run', put(good())], t), 22);
      assert.match(t.errText(), /node bin\/e2k\.js start/);
    } finally { empty.cleanup(); }
  });

  test('help lists run', async () => {
    const t = io(makeTmpHome().env, async () => new FakeDriver({ pages: PAGES }));
    assert.equal(await main(['help'], t), 0);
    assert.match(t.outText(), /run <用例文件>/);
    assert.match(t.outText(), /--name/);
  });
});
