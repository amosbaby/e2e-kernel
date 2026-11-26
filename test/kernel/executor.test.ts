import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriverError } from '../../src/driver/types.ts';
import type { Described, Instance, Page, RequestInfo } from '../../src/driver/types.ts';
import { exitFor, runOps, tally } from '../../src/kernel/executor.ts';
import type { ExecCtx } from '../../src/kernel/executor.ts';
import { Recorder, isWrite, toWriteRecord } from '../../src/kernel/recorder.ts';
import type { Op } from '../../src/shared/ops.ts';
import { REDACTED, redactText } from '../../src/shared/redact.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';

// 长得像 token 的串在运行时拼出来，不写成字面量。
const jwt = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NSJ9', 'c2lnbmF0dXJl' + 'LXZhbHVlLWZvci10ZXN0'].join('.');
const now = new Date('2026-01-02T03:04:05.000Z');

const PAGE_URL = 'http://localhost/';
const EVAL_URL = 'http://localhost/eval';
const EVAL_PW_URL = 'http://localhost/eval-pw';
const EVAL_UNKNOWN_URL = 'http://localhost/eval-unknown';
const PW_VALUE = 'typed-' + 'secret-value-4821';
const HINTS_URL = 'http://localhost/hints';
const HINTS_PW_URL = 'http://localhost/hints-pw';
const HINTS_UNKNOWN_URL = 'http://localhost/hints-unknown';
const FILL_VALUE = 'typed-' + 'value-7391';
const HEX_CHARS = '0123456789abcdef';

// 运行时拼出的 64 位十六进制串：仓库里没有字面量。
function hex64(): string {
  let s = '';
  for (let i = 0; i < 64; i++) s += HEX_CHARS[Math.floor(Math.random() * 16)];
  return s;
}

// 长度 ≥ 8 的片段里，有没有原值的子串。
function leaksFragment(text: string, secret: string, min = 8): boolean {
  for (let i = 0; i + min <= secret.length; i++) if (text.includes(secret.slice(i, i + min))) return true;
  return false;
}

function pageSpec(): FakePageSpec {
  return {
    snapshot: 'line\n'.repeat(5000),
    elements: {
      e2: { text: 'Add', stable: { selector: '[data-testid="add"]', via: 'testid' } },
      e3: {},
      '#save': {},
      '#status': { text: 'Added' },
      '#gone': { failWith: 'not-found' },
      e9: { password: true },
      '#flaky': { describeFails: 1 },
      '#long': { text: 'word '.repeat(2000) },
      '#name': { kind: 'text-input' },
      '#area': { kind: 'textarea' },
      '#editable': {},
      '#pwtext': { password: true, kind: 'text-input' },
      '#tok': { text: `token is ${jwt}` },
    },
    console: [
      ...Array.from({ length: 59 }, (_, i) => ({ level: 'log', text: `m${i}` })),
      // 290 个字符之后接一个 JWT：先截断再脱敏会留下半截 token。
      { level: 'warn', text: `${'x '.repeat(145)}${jwt} tail` },
    ],
  };
}

function req(method: string, url: string, body: string | null): RequestInfo {
  return { id: 'r0', pageId: 'p1', openerPageId: null, method, url, resourceType: 'fetch', isNavigation: false, topFrame: true,
    topUrl: null, contentType: body === null ? null : 'application/json', body, fromLoginForm: body === null ? null : false };
}

// 在一个页面对象上换掉几个方法，其余照旧走假驱动。
function withPage(base: Page, over: Partial<Page>): Page {
  return Object.assign(Object.create(base) as Page, over);
}

// 失败时带诊断的元素：#amb 点击失败，#in 是普通输入框（wait、describe、fill 各有一个会失败的版本）。
function hintsSpec(extra: FakePageSpec): FakePageSpec {
  const hints = [`3 matches`, `1) 可写 #amb >> nth=0 · button @(1,2 3x4) "Save"`, `token ${jwt}`, `value ${FILL_VALUE} here`];
  return { ...extra, elements: {
    '#amb': { failWith: 'other', hints },
    '#in-fill': { kind: 'text-input', failWith: 'other', hints },
    '#in-describe': { kind: 'text-input', describeFails: 1, hints },
    '#in-wait': { kind: 'text-input', waitFails: true, hints },
  } };
}

let fake: FakeDriver;
let page: Page;
let evalPage: Page;
let inst: Instance;
let recorder: Recorder;
let ctx: ExecCtx;

beforeEach(async () => {
  fake = new FakeDriver({ pages: { [PAGE_URL]: pageSpec(), [EVAL_URL]: { evalResult: { id: jwt, n: 1 } },
    [EVAL_PW_URL]: { evalResult: PW_VALUE, passwordField: true },
    [EVAL_UNKNOWN_URL]: { evalResult: PW_VALUE, passwordFieldFailWith: 'timeout' },
    [HINTS_URL]: hintsSpec({}), [HINTS_PW_URL]: hintsSpec({ passwordField: true }),
    [HINTS_UNKNOWN_URL]: hintsSpec({ passwordFieldFailWith: 'timeout' }) } });
  inst = await fake.launch({ name: 'default', userDataDir: '/tmp/e2k-fake-profile' });
  page = await inst.openPage({});
  await page.goto(PAGE_URL);
  evalPage = await inst.openPage({});
  await evalPage.goto(EVAL_URL);
  recorder = new Recorder();
  ctx = { recorder, runDir: mkdtempSync(join(tmpdir(), 'e2k-run-')), now: () => now };
});

afterEach(() => {
  rmSync(ctx.runDir, { recursive: true, force: true });
});

test('runs ops in order and stops at the first execution failure', async () => {
  const r = await runOps(page, [{ op: 'click', target: 'e2' }, { op: 'click', target: '#gone' }, { op: 'click', target: 'e3' }], ctx);
  assert.deepEqual(r.map(x => x.outcome), ['ok', 'failed', 'not-run']);
  assert.ok(!fake.calls.some(c => c.method === 'click' && c.args[0] === 'e3'));
  assert.equal(r[1].shot, 'shots/02.jpg'); assert.ok(existsSync(join(ctx.runDir, r[1].shot!)));
  assert.equal(statSync(join(ctx.runDir, 'shots')).mode & 0o777, 0o700);
  assert.deepEqual(recorder.actions.map(a => a.outcome), ['ok', 'failed', 'not-run']);
});

test('with keepGoing a failure does not stop the batch: later ops run and nothing is not-run', async () => {
  const r = await runOps(page, [{ op: 'click', target: '#gone' }, { op: 'snapshot' }, { op: 'click', target: 'e2' }], ctx, { keepGoing: true });
  assert.deepEqual(r.map(x => x.outcome), ['failed', 'ok', 'ok']);
  assert.equal(tally(r).notRun, 0); assert.equal(exitFor(tally(r)), 11);
  assert.equal(r[0].shot, 'shots/01.jpg'); assert.ok(existsSync(join(ctx.runDir, r[0].shot!)));   // 失败截图照留
  assert.ok(fake.calls.some(c => c.method === 'click' && c.args[0] === 'e2'));
  assert.deepEqual(recorder.actions.map(a => a.outcome), ['failed', 'ok', 'ok']);
});

test('keepGoing false or absent keeps the default: stop at the first failure, the rest not-run', async () => {
  const ops: Op[] = [{ op: 'click', target: '#gone' }, { op: 'click', target: 'e2' }];
  assert.deepEqual((await runOps(page, ops, ctx, { keepGoing: false })).map(x => x.outcome), ['failed', 'not-run']);
  assert.deepEqual((await runOps(page, ops, ctx, {})).map(x => x.outcome), ['failed', 'not-run']);
});

test('results carry the session-wide seq, the same as the record, across batches; not-run ops take a number too', async () => {
  const a = await runOps(page, [{ op: 'click', target: '#gone' }, { op: 'click', target: 'e2' }], ctx);
  assert.deepEqual(a.map(x => x.seq), [1, 2]); assert.equal(a[1].outcome, 'not-run');
  const b = await runOps(page, [{ op: 'snapshot' }, { op: 'click', target: 'e3' }], ctx);
  assert.deepEqual(b.map(x => x.seq), [3, 4]);
  assert.deepEqual(recorder.actions.map(x => x.seq), [...a, ...b].map(x => x.seq));
});

test('assert mismatch does not stop the batch', async () => {
  const r = await runOps(page, [{ op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Nope' }, { op: 'click', target: 'e2' }], ctx);
  assert.deepEqual(r.map(x => x.outcome), ['mismatch', 'ok']);
  assert.equal(r[0].actual, 'Added'); assert.equal(r[0].expected, 'Nope');
});

test('assert on a missing element is a mismatch with actual null', async () => {
  const [r] = await runOps(page, [{ op: 'assert', kind: 'text', target: '#nope', cmp: 'eq', expected: 'x' }], ctx);
  assert.equal(r.outcome, 'mismatch'); assert.equal(r.actual, null);
});

test('records a stable selector for ref targets and keeps selectors as given', async () => {
  await runOps(page, [{ op: 'click', target: 'e2' }, { op: 'click', target: '#save' }], ctx);
  assert.deepEqual(recorder.actions[0].target, { given: 'e2', stable: { selector: '[data-testid="add"]', via: 'testid' } });
  assert.deepEqual(recorder.actions[1].target, { given: '#save', stable: { selector: '#save', via: 'given' } });
});

test('a click still runs when describe fails first, and describe is retried afterwards', async () => {
  const [r] = await runOps(page, [{ op: 'click', target: '#flaky' }], ctx);
  assert.equal(r.outcome, 'ok'); assert.ok(fake.calls.some(c => c.method === 'click' && c.args[0] === '#flaky'));
  assert.equal(fake.calls.filter(c => c.method === 'describe' && c.args[0] === '#flaky').length, 2);
});

test('refuses to fill a password field and never records the value', async () => {
  const [r] = await runOps(page, [{ op: 'fill', target: 'e9', value: 'hunter2-not-real' }], ctx);
  assert.equal(r.outcome, 'failed'); assert.match(r.error!, /^password-field/);
  assert.ok(!fake.calls.some(c => c.method === 'fill'));
  assert.ok(!JSON.stringify(recorder.actions).includes('hunter2-not-real'));
});

test('fill is not attempted when describe fails', async () => {
  const [r] = await runOps(page, [{ op: 'fill', target: '#flaky', value: 'hunter2-not-real' }], ctx);
  assert.equal(r.outcome, 'failed');
  assert.ok(!fake.calls.some(c => c.method === 'fill'));
  assert.ok(!JSON.stringify(recorder.actions).includes('hunter2-not-real'));
});

test('outputs are redacted first, then capped; eval results become one JSON string', async () => {
  const [long] = await runOps(page, [{ op: 'text', target: '#long' }], ctx);
  assert.ok((long.output as string).endsWith('…[truncated 10000]')); assert.ok((long.output as string).length < 4100);
  const [ev] = await runOps(evalPage, [{ op: 'eval', js: 'x' }], ctx);       // evalPage 的 evalResult 是 { id: jwt, n: 1 }
  assert.equal(typeof ev.output, 'string'); assert.ok(!(ev.output as string).includes(jwt)); assert.match(ev.output as string, /"n":1/);
});

test('an eval result is recorded redacted and capped at 1000 characters; the step response keeps the longer form', async () => {
  const [ev] = await runOps(evalPage, [{ op: 'eval', js: 'x' }], ctx);
  const rec = recorder.actions[0]!;
  assert.equal(typeof rec.output, 'string');
  assert.match(rec.output!, /"n":1/); assert.ok(!rec.output!.includes(jwt)); assert.equal(rec.outputOmitted, undefined);
  assert.equal(rec.output, ev.output, 'a short result is identical in the record and in the response');
  // 5000 字符：记录截到 1000 并带标记，回应照旧给到 4000
  const big = await inst.openPage({}); await big.goto(PAGE_URL);
  const bigPage = withPage(big, { evaluate: async () => 'y'.repeat(5000) });
  const [long] = await runOps(bigPage, [{ op: 'eval', js: 'x' }], ctx);
  const recLong = recorder.actions[1]!.output!;
  assert.ok(recLong.startsWith('"yyy') && recLong.endsWith('…[truncated 5002]'), recLong.slice(-30)); assert.ok(recLong.length <= 1000 + 20);
  assert.ok((long.output as string).endsWith('…[truncated 5002]') && (long.output as string).length > 4000);
});

test('eval redacts the whole result before cutting it: a token straddling character 1000 leaves no fragment', async () => {
  const straddle = 'x'.repeat(980) + ' ' + jwt + ' tail';
  const p = withPage(page, { evaluate: async () => straddle });
  await runOps(p, [{ op: 'eval', js: 'x' }], ctx);
  const out = recorder.actions[0]!.output!;
  assert.ok(!out.includes('eyJ') && !out.includes(jwt.slice(0, 30)), out);
});

test('an eval source is never recorded: only a short hash, the same for the same source', async () => {
  const src = `fetch("/x?token=abc123", { headers: { a: "${jwt}" } })`;
  await runOps(page, [{ op: 'eval', js: src }, { op: 'eval', js: src }, { op: 'eval', js: src + ' ' }], ctx);
  const [a, b, c] = recorder.actions;
  assert.match(a!.jsHash!, /^sha256:[0-9a-f]{16}$/);
  assert.equal(a!.jsHash, b!.jsHash); assert.notEqual(a!.jsHash, c!.jsHash);
  assert.deepEqual(a!.op, { op: 'eval', js: REDACTED });
  const recorded = JSON.stringify(recorder.actions);
  for (const gone of [jwt, 'abc123', 'fetch(']) assert.ok(!recorded.includes(gone));
  assert.ok(redactText(a!.jsHash!) === a!.jsHash, 'the hash must survive redaction as it is');
});

test('only eval records output and a hash; other ops never do', async () => {
  await runOps(page, [{ op: 'text', target: '#long' }, { op: 'snapshot' }, { op: 'click', target: '#save' }], ctx);
  for (const a of recorder.actions) { assert.equal(a.output, undefined); assert.equal(a.jsHash, undefined); assert.equal(a.outputOmitted, undefined); }
});

test('an eval on a page with a password-like field records no output, only outputOmitted and the hash; the response is unchanged', async () => {
  const pw = await inst.openPage({}); await pw.goto(EVAL_PW_URL);
  const [r] = await runOps(pw, [{ op: 'eval', js: 'document.querySelector("#pw").value' }], ctx);
  assert.equal(r.output, JSON.stringify(PW_VALUE), 'the agent still gets the value');
  const rec = recorder.actions[0]!;
  assert.equal(rec.outputOmitted, true); assert.equal('output' in rec, false);
  assert.match(rec.jsHash!, /^sha256:[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(recorder.actions).includes(PW_VALUE));
});

test('an eval whose password probe fails records no output (fail closed)', async () => {
  const unknown = await inst.openPage({}); await unknown.goto(EVAL_UNKNOWN_URL);
  await runOps(unknown, [{ op: 'eval', js: 'x' }], ctx);
  assert.equal(recorder.actions[0]!.outputOmitted, true); assert.equal('output' in recorder.actions[0]!, false);
  // 探测本身抛 DriverError（页面在换文档之类）也一样
  const throwing = withPage(page, { hasPasswordLikeField: async () => { throw new DriverError('other', 'gone'); } });
  await runOps(throwing, [{ op: 'eval', js: 'x' }], ctx);
  assert.equal(recorder.actions[1]!.outputOmitted, true); assert.equal('output' in recorder.actions[1]!, false);
});

test('a password field that appears or disappears during an eval still keeps the output out of the record', async () => {
  const probes = (...found: (boolean | null)[]): Partial<Page> => {
    const left = [...found];
    return { hasPasswordLikeField: async () => ({ found: left.shift() ?? null, frames: ['http://localhost/'] }) };
  };
  await runOps(withPage(page, probes(false, true)), [{ op: 'eval', js: 'x' }], ctx);     // 跑之前没有，跑完有
  assert.equal(recorder.actions[0]!.outputOmitted, true);
  await runOps(withPage(page, probes(true, false)), [{ op: 'eval', js: 'x' }], ctx);     // 跑之前有，跑完被页面脚本删了
  assert.equal(recorder.actions[1]!.outputOmitted, true);
  await runOps(withPage(page, probes(false, false)), [{ op: 'eval', js: 'x' }], ctx);    // 两次都确定没有：记
  assert.equal(recorder.actions[2]!.outputOmitted, undefined); assert.equal(typeof recorder.actions[2]!.output, 'string');
});

test('an eval during which the page swapped documents records no output, even if both probes say there is no password field', async () => {
  const urls = [['http://localhost/a'], ['http://localhost/b']];
  const jumped = withPage(page, { hasPasswordLikeField: async () => ({ found: false, frames: urls.shift()! }) });
  await runOps(jumped, [{ op: 'eval', js: 'x' }], ctx);
  assert.equal(recorder.actions[0]!.outputOmitted, true); assert.equal('output' in recorder.actions[0]!, false);
});

test('an eval that throws: the agent gets the error, the record keeps only a fixed text and the hash', async () => {
  const thrown = (msg: string): Page => withPage(page, { evaluate: async () => { throw new DriverError('other', msg); } });
  // 页面值经 throw new Error(value) 进了错误消息；脚本源码里的标识符经 ReferenceError 进了错误消息
  const [a] = await runOps(thrown('page.evaluate: Error: ' + PW_VALUE), [{ op: 'eval', js: 'throw new Error(document.querySelector("#pw").value)' }], ctx);
  assert.equal(a.outcome, 'failed'); assert.ok(String((a as { error?: string }).error).includes(PW_VALUE), 'the agent still sees the error');
  const [c] = await runOps(thrown('page.evaluate: ReferenceError: secretIdent is not defined'), [{ op: 'eval', js: 'secretIdent + 1' }], ctx);
  assert.equal(c.outcome, 'failed'); assert.ok(String((c as { error?: string }).error).includes('secretIdent'));
  for (const rec of recorder.actions) {
    assert.equal(rec.outcome, 'failed'); assert.equal(rec.error, 'other: eval 抛错（消息未记录）');
    assert.match(rec.jsHash!, /^sha256:[0-9a-f]{16}$/); assert.equal(rec.output, undefined);
  }
  const recorded = JSON.stringify(recorder.actions);
  for (const gone of [PW_VALUE, 'secretIdent', 'querySelector']) assert.ok(!recorded.includes(gone), gone);
  // 非 eval 的失败照旧记错误消息
  await runOps(page, [{ op: 'click', target: '#gone' }], ctx);
  assert.notEqual(recorder.actions[2]!.error, 'other: eval 抛错（消息未记录）');
});

test('wait uses the 10 second default', async () => {
  await runOps(page, [{ op: 'wait', for: { text: 'x' } }, { op: 'wait', for: { text: 'x' }, timeoutMs: 500 }], ctx);
  assert.deepEqual(fake.calls.filter(c => c.method === 'waitFor').map(c => c.args[1]), [10_000, 500]);
});

test('recorder keeps writes apart from reads and redacts them', () => {
  recorder.addRequest({ ...req('POST', 'http://localhost/api/items?token=abc123', '{"password":"p1"}'), id: 'r1', topUrl: 'http://localhost/?sid=s9' },
    { action: 'continue' }, 'default', now);
  recorder.addRequest({ ...req('GET', 'http://localhost/api/items', null), id: 'r2' }, { action: 'continue' }, 'default', now);
  assert.equal(recorder.completeRequest('r1', 201, false), true); assert.equal(recorder.completeRequest('zz', 200, false), false);
  assert.equal(recorder.writes.length, 1); assert.equal(recorder.requests.length, 2);
  assert.equal(recorder.writes[0].status, 201); assert.equal(recorder.writes[0].decision, 'allowed');
  for (const gone of ['abc123', 'p1', 's9']) assert.ok(!JSON.stringify([recorder.writes, recorder.requests]).includes(gone));
});

test('tally and exitFor', () => {
  assert.equal(exitFor({ ok: 1, match: 1, mismatch: 0, failed: 0, notRun: 0 }), 0);
  assert.equal(exitFor({ ok: 0, match: 0, mismatch: 1, failed: 0, notRun: 0 }), 10);
  assert.equal(exitFor({ ok: 0, match: 0, mismatch: 1, failed: 1, notRun: 2 }), 11);
});

// ---- 补充测试：顺序与记录、密码框、脱敏、输出上限、请求记录 ----

test('tally counts every outcome', () => {
  const items = (['ok', 'ok', 'match', 'mismatch', 'failed', 'not-run', 'not-run'] as const).map(outcome => ({ outcome }));
  assert.deepEqual(tally(items), { ok: 2, match: 1, mismatch: 1, failed: 1, notRun: 2 });
});

test('results carry the op index and name; not-run actions are recorded with their target', async () => {
  const r = await runOps(page, [{ op: 'click', target: '#gone' }, { op: 'hover', target: 'e3' }], ctx);
  assert.deepEqual(r.map(x => [x.index, x.op, x.outcome]), [[0, 'click', 'failed'], [1, 'hover', 'not-run']]);
  assert.deepEqual(recorder.actions[1], { seq: 2, at: now.toISOString(), ms: 0, op: { op: 'hover', target: 'e3' },
    target: { given: 'e3', stable: null }, outcome: 'not-run' });
});

test('seq and shot numbers continue across batches in one session', async () => {
  await runOps(page, [{ op: 'click', target: 'e2' }], ctx);
  const [r] = await runOps(page, [{ op: 'click', target: '#gone' }], ctx);
  assert.equal(r.shot, 'shots/02.jpg');
  assert.deepEqual(recorder.actions.map(a => a.seq), [1, 2]);
  const [s] = await runOps(page, [{ op: 'screenshot' }], ctx);
  assert.equal(s.outcome, 'ok'); assert.equal(s.shot, 'shots/03.jpg'); assert.ok(existsSync(join(ctx.runDir, 'shots/03.jpg')));
  assert.equal(recorder.actions[2].shot, 'shots/03.jpg');
});

test('screenshot names carry the label and the extension, and the record keeps the op', async () => {
  await runOps(page, [{ op: 'click', target: 'e2' }, { op: 'click', target: 'e2' }], ctx);
  const r = await runOps(page, [
    { op: 'screenshot', label: 'checkout-mobile', format: 'png' }, { op: 'screenshot', label: 'plain' }, { op: 'screenshot', format: 'png' },
    { op: 'screenshot', target: 'e2', mask: ['#status'] },
  ], ctx);
  assert.deepEqual(r.map(x => x.shot), ['shots/03-checkout-mobile.png', 'shots/04-plain.jpg', 'shots/05.png', 'shots/06.jpg']);
  for (const x of r) assert.ok(existsSync(join(ctx.runDir, x.shot!)));
  assert.deepEqual(recorder.actions[2].op, { op: 'screenshot', label: 'checkout-mobile', format: 'png' });
  assert.deepEqual(recorder.actions[5].target, { given: 'e2', stable: { selector: '[data-testid="add"]', via: 'testid' } });
  const shot = fake.calls.filter(c => c.method === 'screenshot').map(c => c.args[0] as Record<string, unknown>);
  assert.deepEqual(shot.map(o => [o.fullPage, o.format, o.target, o.mask]), [[false, 'png', undefined, undefined], [false, 'jpeg', undefined, undefined],
    [false, 'png', undefined, undefined], [false, 'jpeg', 'e2', ['#status']]]);
});

test('a failed screenshot with a label and a png format still leaves a plain NN.jpg failure shot', async () => {
  const [s] = await runOps(page, [{ op: 'screenshot', label: 'gone-thing', format: 'png', target: '#absent' }], ctx);
  assert.equal(s.outcome, 'failed'); assert.equal(s.shot, 'shots/01.jpg');
  assert.ok(existsSync(join(ctx.runDir, 'shots/01.jpg')) && !existsSync(join(ctx.runDir, 'shots/01-gone-thing.png')));
});

test('a mask that matches nothing fails the screenshot and leaves no failure shot, masked or not', async () => {
  const r = await runOps(page, [{ op: 'screenshot', label: 'masked', mask: ['#status', '#absent'] }, { op: 'snapshot' }], ctx);
  assert.deepEqual(r.map(x => x.outcome), ['failed', 'not-run']);
  assert.equal(r[0].error, 'not-found: mask[1] matched no element');
  assert.equal(r[0].shot, undefined); assert.equal(recorder.actions[0].shot, undefined);
  assert.ok(!existsSync(join(ctx.runDir, 'shots')) || readdirSync(join(ctx.runDir, 'shots')).length === 0);
  // 别的操作失败照旧留失败截图
  const [c] = await runOps(page, [{ op: 'click', target: '#gone' }], ctx);
  assert.equal(c.shot, 'shots/03.jpg');
});

test('a password refusal stops the batch and leaves the value out of the result too', async () => {
  const r = await runOps(page, [{ op: 'fill', target: 'e9', value: 'hunter2-not-real' }, { op: 'click', target: 'e2' }], ctx);
  assert.deepEqual(r.map(x => x.outcome), ['failed', 'not-run']);
  assert.equal(r[0].error, 'password-field: 内核不输入密码，请由人登录后再继续');
  assert.deepEqual(recorder.actions[0].op, { op: 'fill', target: 'e9', value: REDACTED });
  assert.ok(!JSON.stringify(r).includes('hunter2-not-real'));
  assert.ok(!fake.calls.some(c => c.method === 'click'));
});

test('fill is not attempted when describe cannot say whether the target is a password field', async () => {
  const unsure = withPage(page, { describe: async () => ({ stable: null, isPassword: undefined as unknown as boolean, kind: 'text-input' as const }) });
  const [r] = await runOps(unsure, [{ op: 'fill', target: '#name', value: 'hunter2-not-real' }], ctx);
  assert.equal(r.outcome, 'failed');
  assert.ok(!fake.calls.some(c => c.method === 'fill'));
  assert.deepEqual(recorder.actions[0].op, { op: 'fill', target: '#name', value: REDACTED });
});

test('fill runs after a describe that says it is not a password field', async () => {
  const [r] = await runOps(page, [{ op: 'fill', target: '#name', value: 'Widget' }], ctx);
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(fake.calls.filter(c => c.method === 'fill').map(c => c.args), [['#name', 'Widget']]);
  assert.deepEqual(recorder.actions[0].target, { given: '#name', stable: { selector: '#name', via: 'given' } });
});

test('a fill that was not run never records its value (the password status is unknown)', async () => {
  const r = await runOps(page, [{ op: 'click', target: '#gone' }, { op: 'fill', target: 'e9', value: 'hunter2-not-real' }], ctx);
  assert.deepEqual(r.map(x => x.outcome), ['failed', 'not-run']);
  assert.deepEqual(recorder.actions[1].op, { op: 'fill', target: 'e9', value: REDACTED });
  assert.ok(!fake.calls.some(c => c.method === 'describe' && c.args[0] === 'e9'));
  assert.ok(!JSON.stringify([r, recorder.actions]).includes('hunter2-not-real'));
});

test('a confirmed non-password fill keeps its value in the record', async () => {
  const [r] = await runOps(page, [{ op: 'fill', target: '#name', value: 'Widget' }], ctx);
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(recorder.actions[0].op, { op: 'fill', target: '#name', value: 'Widget' });
});

test('a textarea fill keeps its value; a contenteditable (kind other) fill runs but records [REDACTED]', async () => {
  const r = await runOps(page, [
    { op: 'fill', target: '#area', value: 'Widget' }, { op: 'fill', target: '#editable', value: 'hunter2-not-real' },
  ], ctx);
  assert.deepEqual(r.map(x => x.outcome), ['ok', 'ok']);
  assert.deepEqual(fake.calls.filter(c => c.method === 'fill').map(c => c.args), [['#area', 'Widget'], ['#editable', 'hunter2-not-real']]);
  assert.deepEqual(recorder.actions[0].op, { op: 'fill', target: '#area', value: 'Widget' });
  assert.deepEqual(recorder.actions[1].op, { op: 'fill', target: '#editable', value: REDACTED });
  assert.ok(!JSON.stringify([r, recorder.actions]).includes('hunter2-not-real'));
});

test('a describe without a kind is treated as other: the fill runs and the value is not recorded', async () => {
  const noKind = withPage(page, { describe: async () => ({ stable: null, isPassword: false } as unknown as Described) });
  const [r] = await runOps(noKind, [{ op: 'fill', target: '#name', value: 'hunter2-not-real' }], ctx);
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(recorder.actions[0].op, { op: 'fill', target: '#name', value: REDACTED });
});

test('a text-like input flagged as a password (autocomplete) is refused and its value never recorded', async () => {
  const [r] = await runOps(page, [{ op: 'fill', target: '#pwtext', value: 'hunter2-not-real' }], ctx);
  assert.equal(r.outcome, 'failed'); assert.match(r.error!, /^password-field/);
  assert.ok(!fake.calls.some(c => c.method === 'fill'));
  assert.deepEqual(recorder.actions[0].op, { op: 'fill', target: '#pwtext', value: REDACTED });
  assert.ok(!JSON.stringify([r, recorder.actions]).includes('hunter2-not-real'));
});

test('a fill that fails after a non-password describe does not record its value, nor echo it in the error', async () => {
  const echoing = withPage(page, { fill: async (_t, v) => { throw new DriverError('other', `cannot type ${v}`); } });
  const [r] = await runOps(echoing, [{ op: 'fill', target: '#name', value: 'hunter2-not-real' }], ctx);
  assert.equal(r.outcome, 'failed');
  assert.deepEqual(recorder.actions[0].op, { op: 'fill', target: '#name', value: REDACTED });
  assert.ok(!JSON.stringify([r, recorder.actions]).includes('hunter2-not-real'));
});

test('fill waits for its target before describe, and does not fill when the wait fails', async () => {
  const order: string[] = [];
  const waits: unknown[] = [];
  const late = withPage(page, {
    waitFor: async (cond, ms) => { order.push('waitFor'); waits.push([cond, ms]); },
    describe: async (t) => { order.push('describe'); return page.describe(t); },
    fill: async (t, v) => { order.push('fill'); return page.fill(t, v); },
  });
  const [ok] = await runOps(late, [{ op: 'fill', target: '#name', value: 'Widget' }], ctx);
  assert.equal(ok.outcome, 'ok');
  assert.deepEqual(order, ['waitFor', 'describe', 'fill']);
  assert.deepEqual(waits, [[{ target: '#name', state: 'visible' }, 10_000]]);

  order.length = 0;
  const never = withPage(page, {
    waitFor: async () => { order.push('waitFor'); throw new DriverError('timeout', 'waiting for #name timed out'); },
    describe: async (t) => { order.push('describe'); return page.describe(t); },
    fill: async (t, v) => { order.push('fill'); return page.fill(t, v); },
  });
  const r = await runOps(never, [{ op: 'fill', target: '#name', value: 'hunter2-not-real' }, { op: 'click', target: 'e2' }], ctx);
  assert.deepEqual(r.map(x => x.outcome), ['failed', 'not-run']);
  assert.match(r[0].error!, /^timeout:/);
  assert.deepEqual(order, ['waitFor']);
  assert.deepEqual(recorder.actions[1].op, { op: 'fill', target: '#name', value: REDACTED });
  assert.deepEqual(recorder.actions[2].op, { op: 'click', target: 'e2' });
  assert.ok(!JSON.stringify([r, recorder.actions]).includes('hunter2-not-real'));
});

test('recorded ops are redacted: fill value, goto url and eval js', async () => {
  const ops: Op[] = [
    { op: 'fill', target: '#name', value: `Bearer ${jwt}` },
    { op: 'eval', js: `fetch("/x?token=abc123", { headers: { a: "${jwt}" } })` },
    { op: 'goto', url: 'http://localhost/next?token=abc123' },
  ];
  const r = await runOps(page, ops, ctx);
  assert.deepEqual(r.map(x => x.outcome), ['ok', 'ok', 'ok']);
  const recorded = JSON.stringify(recorder.actions);
  for (const gone of [jwt, 'abc123']) assert.ok(!recorded.includes(gone));
  assert.deepEqual(recorder.actions[1].op, { op: 'eval', js: REDACTED });   // eval 源码不进记录，哪怕脱敏过
  assert.equal(fake.calls.find(c => c.method === 'fill')!.args[1], `Bearer ${jwt}`);
});

test('assert actual strings are redacted in the result and the record', async () => {
  const [r] = await runOps(page, [{ op: 'assert', kind: 'text', target: '#tok', cmp: 'contains', expected: 'token is' }], ctx);
  assert.equal(r.outcome, 'match');
  assert.ok(!JSON.stringify([r, recorder.actions]).includes(jwt));
});

test('assert fails, and stops the batch, when read throws anything other than not-found', async () => {
  const slow = withPage(page, { read: async () => { throw new DriverError('timeout', 'read timed out'); } });
  const r = await runOps(slow, [{ op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Added' }, { op: 'click', target: 'e2' }], ctx);
  assert.deepEqual(r.map(x => x.outcome), ['failed', 'not-run']);
  assert.match(r[0].error!, /^timeout: /);
});

test('driver error messages are redacted before they reach the result or the record', async () => {
  const leaky = withPage(page, {
    click: async () => { throw new DriverError('timeout', `waiting for locator at http://localhost/a?token=abc123&x=${jwt}`); },
  });
  const [r] = await runOps(leaky, [{ op: 'click', target: 'e2' }], ctx);
  assert.equal(r.outcome, 'failed');
  const both = JSON.stringify([r, recorder.actions]);
  for (const gone of ['abc123', jwt]) assert.ok(!both.includes(gone));
  assert.match(r.error!, /^timeout: waiting for locator/);
});

test('when redaction throws, the raw value is replaced by a fixed marker', async () => {
  const hostile = { toString: () => 'raw-page-value', replace: () => { throw new Error('boom'); } };
  const odd = withPage(page, { text: async () => hostile as unknown as string });
  const [r] = await runOps(odd, [{ op: 'text' }], ctx);
  assert.equal(r.outcome, 'ok'); assert.equal(r.output, REDACTED);

  const badUrl = { toString: () => { throw new Error('boom'); }, replace: () => { throw new Error('boom'); } };
  recorder.addRequest({ ...req('POST', badUrl as unknown as string, null), id: 'r7' }, { action: 'continue' }, 'default', now);
  assert.equal(recorder.requests[0].url, REDACTED); assert.equal(recorder.writes[0].url, REDACTED);
});

test('snapshot, text max and console are capped after redaction', async () => {
  const [snap, short] = await runOps(page, [{ op: 'snapshot' }, { op: 'text', target: '#long', max: 100 }], ctx);
  assert.equal(snap.output, `${'line\n'.repeat(5000).slice(0, 20000)}…[truncated 25000]`);
  assert.equal(short.output, `${'word '.repeat(20)}…[truncated 10000]`);

  const [con] = await runOps(page, [{ op: 'console' }], ctx);
  const entries = con.output as { level: string; text: string }[];
  assert.equal(entries.length, 50); assert.equal(entries[0].text, 'm10');
  const last = entries[49].text;
  assert.ok(last.endsWith('…[truncated 305]')); assert.ok(last.includes(REDACTED)); assert.ok(!last.includes('eyJ'));
});

test('network returns the 50 most recent requests and the recorder keeps 200', async () => {
  for (let i = 1; i <= 260; i++) recorder.addRequest({ ...req('GET', `http://localhost/r${i}`, null), id: `r${i}` }, { action: 'continue' }, 'default', now);
  assert.equal(recorder.requests.length, 200);
  assert.equal(recorder.requests[0].url, 'http://localhost/r61');
  const [net] = await runOps(page, [{ op: 'network' }], ctx);
  const list = net.output as { url: string }[];
  assert.equal(list.length, 50); assert.equal(list[0].url, 'http://localhost/r211'); assert.equal(list[49].url, 'http://localhost/r260');
  assert.equal(recorder.completeRequest('r1', 200, false), false);   // 摘要已被挤出，也不是写
  assert.equal(recorder.completeRequest('r260', 204, false), true); assert.equal(recorder.requests[199].status, 204);
});

test('completeRequest finds a write after its summary has left the request list', () => {
  recorder.addRequest({ ...req('POST', 'http://localhost/api/items', '{"name":"a"}'), id: 'w1' }, { action: 'continue' }, 'default', now);
  for (let i = 1; i <= 250; i++) recorder.addRequest({ ...req('GET', `http://localhost/r${i}`, null), id: `g${i}` }, { action: 'continue' }, 'default', now);
  assert.equal(recorder.requests.length, 200);
  assert.equal(recorder.completeRequest('w1', 201, false), true);
  assert.equal(recorder.writes[0].status, 201); assert.equal(recorder.writes[0].failed, false);
});

test('request summary ids are generated by the kernel, not taken from the driver', () => {
  recorder.addRequest({ ...req('GET', 'http://localhost/a', null), id: 'page-chosen-id' }, { action: 'continue' }, 'default', now);
  assert.notEqual(recorder.requests[0].id, 'page-chosen-id'); assert.match(recorder.requests[0].id, /^n\d+$/);
  assert.equal(recorder.completeRequest('page-chosen-id', 200, false), true); assert.equal(recorder.requests[0].status, 200);
});

test('toWriteRecord omits the body unless the page is known to hold no password field (fail closed)', () => {
  const secret = 'not-a-real-secret-value';
  const base = req('POST', 'http://localhost/api/x', `note=${secret}`);
  for (const fromLoginForm of [true, null]) {
    const w = toWriteRecord({ ...base, fromLoginForm }, { action: 'continue' }, 'default', now);
    assert.equal(w.body, null); assert.equal(w.bodyOmitted, true);
    assert.ok(!JSON.stringify(w).includes(secret));
  }
  const kept = toWriteRecord({ ...base, fromLoginForm: false, body: '{"password":"p1","n":1}', contentType: 'application/json' }, { action: 'continue' }, 'default', now);
  assert.equal(kept.bodyOmitted, false);
  assert.ok(kept.body !== null && kept.body.includes('[REDACTED]') && !kept.body.includes('p1'));
  const noBody = toWriteRecord({ ...req('DELETE', 'http://localhost/api/x/1', null), fromLoginForm: null }, { action: 'continue' }, 'default', now);
  assert.equal(noBody.body, null); assert.equal(noBody.bodyOmitted, false, 'a request with no body has nothing to omit');
});

test('toWriteRecord classifies GraphQL from the original body, also when the body is not recorded, and takes the host from the raw url', () => {
  const doc = JSON.stringify({ query: 'mutation Save { save { id } }' });
  const post = (url: string, body: string | null, extra: Partial<RequestInfo> = {}) =>
    toWriteRecord({ ...req('POST', url, body), contentType: 'application/json', fromLoginForm: false, ...extra }, { action: 'continue' }, 'default', now);
  const kept = post('http://localhost/graphql', doc);
  assert.equal(kept.graphql, 'mutation'); assert.equal(kept.host, 'localhost'); assert.equal(kept.body !== null, true);
  for (const fromLoginForm of [true, null]) {
    const w = post('http://localhost/graphql', doc, { fromLoginForm });
    assert.equal(w.body, null); assert.equal(w.bodyOmitted, true);
    assert.equal(w.graphql, 'mutation', 'the body is not recorded, but the classification still comes from it');
    assert.ok(!JSON.stringify(w).includes('Save'));
  }
  assert.equal(post('http://localhost/graphql', JSON.stringify({ query: '{ a }' })).graphql, 'query');
  assert.equal(post('http://localhost/api/x', JSON.stringify({ n: 1 })).graphql, null);
  assert.equal(post('http://localhost/api/x', null).graphql, null);
  // graphqlKind 抛错不能让整条记录（以及 onRequest）失败：给 'unknown'。
  const odd = post('http://localhost/api/x', {} as unknown as string);
  assert.equal(odd.graphql, 'unknown');
  // host 取自原始 url（userinfo 不进来），单独脱敏；取不到给 REDACTED。
  assert.equal(post('http://someone:pw@Example.COM:8080/a?b=1', null).host, 'example.com');
  const longLabel = 'Ab1'.repeat(14);
  assert.equal(post(`https://${longLabel}.example.com/x`, null).host, '[REDACTED].example.com');
  assert.equal(post('not a url', null).host, '[REDACTED]');
});

test('isWrite, toWriteRecord and hosts', () => {
  assert.deepEqual(['POST', 'PUT', 'PATCH', 'DELETE', 'patch', 'GET', 'HEAD', 'OPTIONS'].map(isWrite), [true, true, true, true, true, false, false, false]);
  const w = toWriteRecord({ ...req('PUT', 'http://localhost/api/items/1', null), id: 'r5', topUrl: 'http://localhost/' }, { action: 'abort' }, 'readonly', now);
  assert.deepEqual(w, { id: 'r5', at: now.toISOString(), method: 'PUT', url: 'http://localhost/api/items/1', status: null, failed: false,
    body: null, bodyOmitted: false, pageUrl: 'http://localhost/', decision: 'blocked', targetMode: 'readonly', host: 'localhost', graphql: null });
  recorder.addHost('localhost', 'default'); recorder.addHost('localhost', 'default'); recorder.addHost('127.0.0.1', 'readonly');
  assert.deepEqual(recorder.hosts, [{ host: 'localhost', mode: 'default' }, { host: '127.0.0.1', mode: 'readonly' }]);
});

// ---- P8：失败时的诊断（hints） ----

async function hintsPage(url: string): Promise<Page> {
  const p = await inst.openPage({});
  await p.goto(url);
  return p;
}

test('hints from a failed click are redacted, capped, and reach both the result and the record', async () => {
  const p = await hintsPage(HINTS_URL);
  const [r] = await runOps(p, [{ op: 'click', target: '#amb' }], ctx);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.hints!.length, 4);
  assert.equal(r.hints![0], '3 matches'); assert.ok(r.hints![1]!.includes('>> nth=0'));
  assert.ok(!JSON.stringify(r.hints).includes(jwt));
  assert.deepEqual(recorder.actions[0]!.hints, r.hints);
  // 没有诊断的失败不带 hints 键
  const [g] = await runOps(page, [{ op: 'click', target: '#gone' }], ctx);
  assert.equal('hints' in g!, false); assert.equal('hints' in recorder.actions[1]!, false);
});

test('hints are redacted before they are cut: a token that straddles the 200 or 300 mark does not survive in pieces', async () => {
  // 64 位十六进制串从第 180 个和第 290 个字符起：先截到 200 或 300 再脱敏，都会留下 20 位或 10 位的半截，HEX 规则（32 位起）认不出来
  for (const pad of [170, 280]) {
    const secret = hex64();
    const p = await withHints(`${'p'.repeat(pad)} data-x="${secret}" tail`);
    const [r] = await runOps(p, [{ op: 'click', target: '#amb' }], ctx);
    const text = r.hints!.join('\n');
    assert.ok(!leaksFragment(text, secret), `${pad}: ${text}`);
    assert.ok(!leaksFragment(JSON.stringify(recorder.actions), secret));
    assert.ok(r.hints![0]!.includes('[REDACTED]'));
  }
  // 一个很长的条目：脱敏之后截到 300
  const long = await withHints(`${'w '.repeat(500)}${jwt}`);
  const [r2] = await runOps(long, [{ op: 'click', target: '#amb' }], ctx);
  assert.ok(r2!.hints![0]!.length <= 300 + 30, String(r2!.hints![0]!.length)); assert.ok(r2!.hints![0]!.includes('[truncated'));
});

// 一页上只有 #amb，它的第一条 hint 由测试指定。
async function withHints(first: string): Promise<Page> {
  const url = `http://localhost/hints-${Math.random().toString(16).slice(2)}`;
  const f = new FakeDriver({ pages: { [url]: { elements: { '#amb': { failWith: 'other', hints: [first] } } } } });
  const i = await f.launch({ name: 'default', userDataDir: '/tmp/e2k-fake-profile' });
  const p = await i.openPage({});
  await p.goto(url);
  return p;
}

test('at most 6 hints are kept', async () => {
  const url = 'http://localhost/many';
  const f = new FakeDriver({ pages: { [url]: { elements: { '#amb': { failWith: 'other', hints: Array.from({ length: 10 }, (_, i) => `h${i}`) } } } } });
  const p = await (await f.launch({ name: 'default', userDataDir: '/tmp/e2k-fake-profile' })).openPage({});
  await p.goto(url);
  const [r] = await runOps(p, [{ op: 'click', target: '#amb' }], ctx);
  assert.deepEqual(r!.hints, ['h0', 'h1', 'h2', 'h3', 'h4', 'h5']);
});

test('every fill failure path carries hints, and the typed value is replaced first', async () => {
  const p = await hintsPage(HINTS_URL);
  for (const target of ['#in-wait', '#in-describe', '#in-fill']) {
    ctx.recorder.actions.length = 0;
    const [r] = await runOps(p, [{ op: 'fill', target, value: FILL_VALUE }], ctx);
    assert.equal(r!.outcome, 'failed', target);
    assert.ok(r!.hints !== undefined && r!.hints.length === 4, target);
    assert.equal(r!.hints![0], '3 matches'); assert.ok(r!.hints![1]!.includes('>> nth=0'));
    assert.ok(r!.hints![3]!.includes('[REDACTED]'), r!.hints![3]);
    for (const text of [JSON.stringify(r), JSON.stringify(recorder.actions)]) {
      assert.ok(!text.includes(FILL_VALUE), target); assert.ok(!text.includes(jwt), target);
    }
  }
});

test('the typed value is replaced even when it is too short for the generic redaction to know it', async () => {
  const p = await hintsPage(HINTS_URL);
  const [r] = await runOps(p, [{ op: 'fill', target: '#in-fill', value: 'v' }], ctx);
  assert.ok(r!.hints!.every(h => !h.includes('v')), JSON.stringify(r!.hints));
  assert.ok(r!.hints![1]!.includes('Sa[REDACTED]e'));
});

test('on a page with a password field, or when that cannot be told, the record keeps a fixed note instead of the hints; the response still has them', async () => {
  for (const url of [HINTS_PW_URL, HINTS_UNKNOWN_URL]) {
    ctx.recorder.actions.length = 0;
    const p = await hintsPage(url);
    const [r] = await runOps(p, [{ op: 'click', target: '#amb' }], ctx);
    assert.equal(r!.hints![0], '3 matches', url);
    const rec = recorder.actions[0]!;
    assert.equal(rec.hints!.length, 1, url); assert.match(rec.hints![0]!, /^\[诊断未记录/);
    assert.ok(!JSON.stringify(recorder.actions).includes('matches'), url);
  }
});
