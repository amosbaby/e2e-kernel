import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriverError } from '../../src/driver/types.ts';
import type { Page, RequestInfo } from '../../src/driver/types.ts';
import { exitFor, runOps, tally } from '../../src/kernel/executor.ts';
import type { ExecCtx } from '../../src/kernel/executor.ts';
import { Recorder, isWrite, toWriteRecord } from '../../src/kernel/recorder.ts';
import type { Op } from '../../src/shared/ops.ts';
import { REDACTED } from '../../src/shared/redact.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';

// 长得像 token 的串在运行时拼出来，不写成字面量。
const jwt = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NSJ9', 'c2lnbmF0dXJl' + 'LXZhbHVlLWZvci10ZXN0'].join('.');
const now = new Date('2026-01-02T03:04:05.000Z');

const PAGE_URL = 'http://localhost/';
const EVAL_URL = 'http://localhost/eval';

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
      '#name': {},
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
    topUrl: null, contentType: body === null ? null : 'application/json', body };
}

// 在一个页面对象上换掉几个方法，其余照旧走假驱动。
function withPage(base: Page, over: Partial<Page>): Page {
  return Object.assign(Object.create(base) as Page, over);
}

let fake: FakeDriver;
let page: Page;
let evalPage: Page;
let recorder: Recorder;
let ctx: ExecCtx;

beforeEach(async () => {
  fake = new FakeDriver({ pages: { [PAGE_URL]: pageSpec(), [EVAL_URL]: { evalResult: { id: jwt, n: 1 } } } });
  const inst = await fake.launch({ name: 'default', userDataDir: '/tmp/e2k-fake-profile' });
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

test('a password refusal stops the batch and leaves the value out of the result too', async () => {
  const r = await runOps(page, [{ op: 'fill', target: 'e9', value: 'hunter2-not-real' }, { op: 'click', target: 'e2' }], ctx);
  assert.deepEqual(r.map(x => x.outcome), ['failed', 'not-run']);
  assert.equal(r[0].error, 'password-field: 内核不输入密码，请由人登录后再继续');
  assert.deepEqual(recorder.actions[0].op, { op: 'fill', target: 'e9', value: REDACTED });
  assert.ok(!JSON.stringify(r).includes('hunter2-not-real'));
  assert.ok(!fake.calls.some(c => c.method === 'click'));
});

test('fill is not attempted when describe cannot say whether the target is a password field', async () => {
  const unsure = withPage(page, { describe: async () => ({ stable: null, isPassword: undefined as unknown as boolean }) });
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

test('isWrite, toWriteRecord and hosts', () => {
  assert.deepEqual(['POST', 'PUT', 'PATCH', 'DELETE', 'patch', 'GET', 'HEAD', 'OPTIONS'].map(isWrite), [true, true, true, true, true, false, false, false]);
  const w = toWriteRecord({ ...req('PUT', 'http://localhost/api/items/1', null), id: 'r5', topUrl: 'http://localhost/' }, { action: 'abort' }, 'readonly', now);
  assert.deepEqual(w, { id: 'r5', at: now.toISOString(), method: 'PUT', url: 'http://localhost/api/items/1', status: null, failed: false,
    body: null, pageUrl: 'http://localhost/', decision: 'blocked', targetMode: 'readonly' });
  recorder.addHost('localhost', 'default'); recorder.addHost('localhost', 'default'); recorder.addHost('127.0.0.1', 'readonly');
  assert.deepEqual(recorder.hosts, [{ host: 'localhost', mode: 'default' }, { host: '127.0.0.1', mode: 'readonly' }]);
});
