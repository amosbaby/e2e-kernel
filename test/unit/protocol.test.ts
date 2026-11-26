import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { E2kError, ErrorCode } from '../../src/shared/errors.ts';
import { isSensitiveKey, redactDeep } from '../../src/shared/redact.ts';
import { ExitCode, KERNEL_SKIP_KEYS, MAX_LINE_BYTES, MAX_OPS_BYTES, PROTOCOL_VERSION, exitCodeFor, parseRequest, validateParams }
  from '../../src/shared/protocol.ts';
import type { Method } from '../../src/shared/protocol.ts';

const isUsage = (e: E2kError) => e.code === 'usage';
// 按方法名分派的调用方式（内核收到请求后就是这样调的），方便表驱动地测各个方法。
const validateAny = validateParams as (method: Method, p: unknown) => unknown;

test('constants', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(MAX_LINE_BYTES, 1_048_576);
  assert.equal(MAX_OPS_BYTES, 1_000_000);
});

test('exit codes', () => {
  assert.deepEqual(ExitCode, { OK: 0, INTERNAL: 1, USAGE: 2, MISMATCH: 10, ACTION_FAILED: 11, WAIT_LOGIN: 20, WAIT_APPROVAL: 21, NEEDS_HUMAN: 22 });
  const codes: ErrorCode[] = ['usage', 'not-found', 'busy', 'action-failed', 'internal', 'needs-human', 'wait-login', 'wait-approval'];
  assert.deepEqual(codes.map(exitCodeFor), [2, 2, 2, 11, 1, 22, 20, 21]);
});

test('skip keys are exactly the documented list, and no kernel field name is a sensitive key', () => {
  assert.deepEqual([...KERNEL_SKIP_KEYS].sort(),
    ['given', 'home', 'id', 'loginId', 'name', 'reportPath', 'resultPath', 'runDir', 'selector', 'session', 'shot', 'target']);
  const kernelFields = [...KERNEL_SKIP_KEYS, 'v', 'ok', 'result', 'error', 'code', 'message', 'next', 'method', 'params', 'url', 'title', 'mode', 'snapshot',
    'results', 'tallies', 'exit', 'index', 'op', 'outcome', 'output', 'actual', 'expected', 'consistency', 'sessions', 'idleSec', 'version', 'pid',
    'driver', 'capabilities', 'instance', 'actions', 'writes', 'allowed', 'blocked', 'unattributed', 'hosts', 'verdict', 'findings', 'notDone',
    'coverage', 'closedBy', 'start', 'stable', 'via', 'status', 'failed', 'body', 'pageUrl', 'decision', 'targetMode', 'resourceType', 'level', 'text', 'bodyOmitted', 'fromLoginForm',
    'profiles', 'state', 'lastLogin', 'at', 'host', 'outputOmitted', 'jsHash', 'hints', 'seq', 'keepGoing'];
  for (const k of kernelFields) assert.ok(!isSensitiveKey(k), k);
});

test('host names are not skipped: they go through normal redaction', () => {
  const longLabel = 'Ab1'.repeat(14);
  const out = redactDeep({ host: `${longLabel}.example.com` }, { skipKeys: KERNEL_SKIP_KEYS });
  assert.equal(out.host, '[REDACTED].example.com');
});

test('kernel paths and session names survive redaction under the skip keys', () => {
  const segment = 'Ab1'.repeat(14);
  const dir = `/state/runs/${segment}/20261126-010203-s-a41f00`;
  const result = { session: 's-a41f00', name: 'orders', runDir: dir, reportPath: `${dir}/report.html`,
    resultPath: `${dir}/result.json`, results: [{ index: 0, op: 'screenshot', outcome: 'ok', shot: `${dir}/shots/01.jpg` }] };
  assert.deepEqual(redactDeep(result, { skipKeys: KERNEL_SKIP_KEYS }), result);
});

test('parseRequest', () => {
  assert.equal(parseRequest('{"v":1,"id":"a1","method":"status","params":{}}').method, 'status');
  for (const bad of ['not json', '{"v":2,"id":"a1","method":"status","params":{}}',
    '{"v":1,"id":"a1","method":"approve","params":{}}', '{"v":1,"id":"a1","method":"status","params":{},"x":1}',
    `{"v":1,"id":"${'a'.repeat(65)}","method":"status","params":{}}`])
    assert.throws(() => parseRequest(bad), (e: E2kError) => e.code === 'usage');
});

test('parseRequest rejects other malformed lines', () => {
  for (const bad of ['null', '[]', '"x"', '{"v":"1","id":"a1","method":"status","params":{}}',
    '{"v":1,"id":"a 1","method":"status","params":{}}', '{"v":1,"id":"","method":"status","params":{}}',
    '{"v":1,"method":"status","params":{}}', `{"v":1,"id":"a1","method":"status","params":{"p":"${'x'.repeat(MAX_LINE_BYTES)}"}}`])
    assert.throws(() => parseRequest(bad), isUsage, bad.slice(0, 80));
  const req = parseRequest('{"v":1,"id":"A-9","method":"login.end","params":{"loginId":"l-00ff00"}}');
  assert.deepEqual(req, { v: 1, id: 'A-9', method: 'login.end', params: { loginId: 'l-00ff00' } });
});

test('validateParams', () => {
  assert.deepEqual(validateParams('open', { url: 'http://localhost:5173/', viewport: { width: 1280, height: 800 }, name: 'orders' }),
    { url: 'http://localhost:5173/', viewport: { width: 1280, height: 800 }, name: 'orders' });
  for (const bad of [{ url: 'http://localhost/', name: '../x' }, { url: 'http://localhost/', name: 'A B' },
    { url: 'http://localhost/', allow: [] }, { url: 'ftp://localhost/' }])
    assert.throws(() => validateParams('open', bad));
  assert.throws(() => validateParams('step', { session: 'x', ops: [{ op: 'snapshot' }] }));
  assert.throws(() => validateParams('close', { session: 's-a41f00', verdict: { value: 'undetermined' } }), /because/);
  assert.ok(validateParams('close', { session: 's-a41f00', verdict: { value: 'pass' } }));
});

test('validateParams for the remaining methods', () => {
  assert.deepEqual(validateParams('status', {}), {});
  assert.deepEqual(validateParams('open', { url: 'http://localhost/' }), { url: 'http://localhost/' });
  assert.deepEqual(validateParams('step', { session: 's-a41f00', ops: [{ op: 'snapshot' }] }),
    { session: 's-a41f00', ops: [{ op: 'snapshot' }] });
  const close = { session: 's-a41f00', verdict: { value: 'undetermined', because: 'page did not load' },
    findings: [{ claim: 'a', basis: 'b' }], notDone: ['c'] };
  assert.deepEqual(validateParams('close', close), close);
  assert.deepEqual(validateParams('login.begin', { url: 'https://example.com/login' }), { url: 'https://example.com/login' });
  assert.deepEqual(validateParams('login.end', { loginId: 'l-a41f00' }), { loginId: 'l-a41f00' });
});

test('step takes an optional boolean keepGoing and nothing else new', () => {
  assert.deepEqual(validateParams('step', { session: 's-a41f00', ops: [{ op: 'snapshot' }], keepGoing: true }),
    { session: 's-a41f00', ops: [{ op: 'snapshot' }], keepGoing: true });
  assert.deepEqual(validateParams('step', { session: 's-a41f00', ops: [{ op: 'snapshot' }], keepGoing: false }), { session: 's-a41f00', ops: [{ op: 'snapshot' }], keepGoing: false });
  for (const bad of [{ keepGoing: 'yes' }, { keepGoing: 1 }, { keepGoing: null }, { keepGoing_: true }, { keep_going: true }])
    assert.throws(() => validateParams('step', { session: 's-a41f00', ops: [{ op: 'snapshot' }], ...bad }), isUsage, JSON.stringify(bad));
});

test('validateParams rejects bad parameters with usage', () => {
  const cases: [Method, unknown][] = [
    ['status', { x: 1 }], ['status', null], ['status', undefined],
    ['open', { url: 'http://localhost/', name: 'a'.repeat(41) }], ['open', { url: 'http://localhost/', name: '-a' }],
    ['open', { url: 'http://localhost/', viewport: { width: 319, height: 800 } }],
    ['open', { url: 'http://localhost/', viewport: { width: 1280, height: 2161 } }],
    ['step', { session: 's-a41f00' }], ['step', { session: 's-A41F00', ops: [{ op: 'snapshot' }] }],
    ['step', { session: 's-a41f00', ops: [{ op: 'approve' }] }], ['step', { session: 's-a41f00', ops: [{ op: 'snapshot' }], x: 1 }],
    ['close', { session: 's-a41f00', verdict: { value: 'ok' } }],
    ['close', { session: 's-a41f00', verdict: { value: 'pass', because: 'x'.repeat(1001) } }],
    ['close', { session: 's-a41f00', verdict: { value: 'undetermined', because: '' } }],
    ['close', { session: 's-a41f00', findings: Array(21).fill({ claim: 'a', basis: 'b' }) }],
    ['close', { session: 's-a41f00', findings: [{ claim: '', basis: 'b' }] }],
    ['close', { session: 's-a41f00', findings: [{ claim: 'a', basis: 'x'.repeat(501) }] }],
    ['close', { session: 's-a41f00', findings: { claim: 'a', basis: 'b' } }],
    ['close', { session: 's-a41f00', notDone: Array(21).fill('a') }], ['close', { session: 's-a41f00', notDone: [''] }],
    ['close', { session: 's-a41f00', notDone: [1] }],
    ['login.begin', { url: 'javascript:alert(1)' }], ['login.begin', {}],
    ['login.end', { loginId: 'l-a41f0' }], ['login.end', { loginId: 's-a41f00' }],
  ];
  for (const [method, p] of cases) assert.throws(() => validateAny(method, p), isUsage, `${method} ${JSON.stringify(p)?.slice(0, 80)}`);
});

test('validateParams rejects unknown keys inside nested objects', () => {
  const cases: [Method, unknown][] = [
    ['open', { url: 'http://localhost/', viewport: { width: 1280, height: 800, depth: 1 } }],
    ['close', { session: 's-a41f00', verdict: { value: 'pass', score: 1 } }],
    ['close', { session: 's-a41f00', findings: [{ claim: 'a', basis: 'b', extra: 1 }] }],
    ['step', { session: 's-a41f00', ops: [{ op: 'wait', for: { ms: 1, extra: 1 } }] }],
  ];
  for (const [method, p] of cases) assert.throws(() => validateAny(method, p), isUsage, method);
});
