import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CASE_BYTES, buildCase, parseCase, readCaseFile } from '../../src/cases/case.ts';
import type { CaseFile } from '../../src/cases/case.ts';
import { E2kError } from '../../src/shared/errors.ts';
import { REDACTED } from '../../src/shared/redact.ts';

// 手写的 result.json（已脱敏的那一份）。只放 buildCase 要读的字段，另加几个无关字段，确认它们被忽略。
type Act = Record<string, unknown>;
function act(seq: number, op: Record<string, unknown>, outcome: string, target?: { given: string; stable: { selector: string; via: string } | null }): Act {
  return { seq, at: '2026-01-01T00:00:00.000Z', ms: 5, op, ...(target === undefined ? {} : { target }), outcome };
}

function sampleActions(): Act[] {
  return [
    act(1, { op: 'snapshot' }, 'ok'),
    act(2, { op: 'click', target: '#go' }, 'ok', { given: '#go', stable: { selector: '#go', via: 'given' } }),
    act(3, { op: 'text', target: '#status' }, 'ok', { given: '#status', stable: { selector: '#status', via: 'given' } }),
    act(4, { op: 'click', target: '#nope' }, 'failed', { given: '#nope', stable: null }),
    act(5, { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Saved' }, 'match', { given: '#status', stable: { selector: '#status', via: 'given' } }),
    act(6, { op: 'assert', kind: 'url', cmp: 'contains', expected: '/done' }, 'mismatch'),
    act(7, { op: 'eval', js: '1+1' }, 'ok'),
    act(8, { op: 'goto', url: 'http://localhost:5173/next' }, 'not-run'),
    act(9, { op: 'wait', for: { ms: 100 } }, 'ok'),
    act(10, { op: 'screenshot' }, 'ok'),
  ];
}

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1, kernelVersion: '0.1.0', session: 's-abc123', name: 'checkout',
    start: { url: 'http://localhost:5173/', viewport: { width: 1280, height: 800 }, touch: false, profile: 'default', borrowed: false, deny: null, borrowDeny: null, readonly: false },
    actions: sampleActions(),
    writes: { allowed: [], blocked: [], unattributed: [], summary: [], blockedSummary: [] },
    declarations: [],
    findings: [{ claim: 'the page saves', basis: 'seen it', verdict: 'pass' }],
    ...over,
  };
}

function start(over: Record<string, unknown>): Record<string, unknown> {
  return { ...(run().start as Record<string, unknown>), ...over };
}

function usageOf(fn: () => unknown): E2kError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof E2kError, 'an E2kError');
    assert.equal(e.code, 'usage');
    return e;
  }
  assert.fail('expected a usage error');
}

const seqs = (c: CaseFile): number[] => c.steps.map((s) => s.seq);

test('by default keeps successful actions and executed asserts, drops reads, failures, not-run and eval', () => {
  const c = buildCase(run(), {});
  assert.deepEqual(seqs(c), [2, 5, 6, 9]);
  assert.deepEqual(c.steps[0], { seq: 2, op: { op: 'click', target: '#go' } });
  assert.deepEqual(c.steps[1]?.op, { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Saved' });
  assert.equal(c.e2kCase, 1);
  assert.deepEqual(c.source, { session: 's-abc123', kernelVersion: '0.1.0' });
  assert.equal(c.name, 'checkout');
  assert.deepEqual(c.findings, [{ claim: 'the page saves' }]);
  assert.deepEqual(c.open, { url: 'http://localhost:5173/', profile: 'default', viewport: { width: 1280, height: 800 }, touch: false, readonly: false, allow: [] });
});

test('a ref target is replaced by its stable selector; a ref without one becomes a skip', () => {
  const actions = [
    act(1, { op: 'click', target: 'e5' }, 'ok', { given: 'e5', stable: { selector: '[data-testid="save"]', via: 'testid' } }),
    act(2, { op: 'click', target: 'f1e7' }, 'ok', { given: 'f1e7', stable: null }),
    act(3, { op: 'hover', target: 'e9' }, 'ok'),
  ];
  const c = buildCase(run({ actions }), {});
  assert.deepEqual(c.steps[0], { seq: 1, op: { op: 'click', target: '[data-testid="save"]' } });
  assert.equal(c.steps[1]?.op, undefined);
  assert.equal(c.steps[1]?.skip?.op, 'click');
  assert.match(c.steps[1]?.skip?.why ?? '', /选择器/);
  assert.equal(c.steps[2]?.skip?.op, 'hover');
  // 引用只在 op.target 上有稳定选择器可换；等待目标里的引用换不了，也是跳过
  const waitRef = buildCase(run({ actions: [act(1, { op: 'wait', for: { target: 'e3', state: 'visible' } }, 'ok')] }), {});
  assert.equal(waitRef.steps[0]?.skip?.op, 'wait');
});

test('redacted fill values, eval and redacted selectors become skips with a reason', () => {
  const actions = [
    act(1, { op: 'fill', target: '#pw', value: REDACTED }, 'ok', { given: '#pw', stable: { selector: '#pw', via: 'given' } }),
    act(2, { op: 'click', target: `[title="${REDACTED}"]` }, 'ok', { given: `[title="${REDACTED}"]`, stable: { selector: `[title="${REDACTED}"]`, via: 'given' } }),
    act(3, { op: 'click', target: 'e4' }, 'ok', { given: 'e4', stable: { selector: `[aria-label=${REDACTED}]`, via: 'role' } }),
    act(4, { op: 'eval', js: '1' }, 'ok'),
  ];
  const c = buildCase(run({ actions }), { steps: [1, 2, 3, 4] });
  for (const s of c.steps) {
    assert.equal(s.op, undefined, String(s.seq));
    assert.ok(s.skip !== undefined && s.skip.why.length > 0, String(s.seq));
  }
  assert.deepEqual(c.steps.map((s) => s.skip?.op), ['fill', 'click', 'click', 'eval']);
  assert.ok(!JSON.stringify(c).includes(REDACTED), 'the case carries no redacted content');
});

test('any string in an op that contains [REDACTED] (fill.value partly redacted, wait.for.text, wait.for.urlContains) makes the step a skip', () => {
  const actions = [
    act(1, { op: 'fill', target: '#a', value: `hello ${REDACTED} world` }, 'ok', { given: '#a', stable: { selector: '#a', via: 'given' } }),
    act(2, { op: 'wait', for: { text: `Welcome ${REDACTED}` } }, 'ok'),
    act(3, { op: 'wait', for: { urlContains: `/u/${REDACTED}` } }, 'ok'),
    act(4, { op: 'goto', url: `http://localhost:5173/?q=${REDACTED}` }, 'ok'),
    act(5, { op: 'assert', kind: 'text', target: '#a', cmp: 'eq', expected: `${REDACTED}` }, 'match', { given: '#a', stable: { selector: '#a', via: 'given' } }),
  ];
  const c = buildCase(run({ actions }), {});
  assert.deepEqual(seqs(c), [1, 2, 3, 4, 5]);
  assert.ok(c.steps.every((s) => s.skip !== undefined && s.op === undefined));
  assert.ok(!JSON.stringify(c).includes(REDACTED));
});

test('--steps keeps exactly those sequence numbers, eval included (as a skip)', () => {
  const c = buildCase(run(), { steps: [3, 4, 7] });
  assert.deepEqual(seqs(c), [3, 4, 7]);
  assert.deepEqual(c.steps[0], { seq: 3, op: { op: 'text', target: '#status' } });
  assert.equal(c.steps[1]?.op?.op, 'click');   // 失败的点击也可以点名选进来
  assert.equal(c.steps[2]?.skip?.op, 'eval');
  assert.match(c.steps[2]?.skip?.why ?? '', /eval/);
  assert.ok(!JSON.stringify(c).includes('1+1'), 'the eval source never gets into the case');
});

test('--steps that names a missing sequence number, or is not 1-200 increasing integers, is usage', () => {
  usageOf(() => buildCase(run(), { steps: [99] }));
  usageOf(() => buildCase(run(), { steps: [] }));
  usageOf(() => buildCase(run(), { steps: [3, 2] }));
  usageOf(() => buildCase(run(), { steps: [2, 2] }));
  usageOf(() => buildCase(run(), { steps: [0] }));
  usageOf(() => buildCase(run(), { steps: [1.5] }));
  usageOf(() => buildCase(run(), { steps: ['2'] as unknown as number[] }));
  usageOf(() => buildCase(run(), { steps: 'x' as unknown as number[] }));
  const many = Array.from({ length: 201 }, (_, i) => i + 1);
  const actions = many.map((n) => act(n, { op: 'hover', target: '#a' }, 'ok'));
  usageOf(() => buildCase(run({ actions }), { steps: many }));
  assert.equal(buildCase(run({ actions }), { steps: many.slice(0, 200) }).steps.length, 200);
});

test('a session with nothing to export is usage', () => {
  usageOf(() => buildCase(run({ actions: [act(1, { op: 'snapshot' }, 'ok')] }), {}));
});

test('a redacted start url, a redacted allow address or a redacted open.allow refuses to export', () => {
  usageOf(() => buildCase(run({ start: start({ url: `http://localhost:5173/?t=${REDACTED}` }) }), {}));
  usageOf(() => buildCase(run({ start: start({ url: REDACTED }) }), {}));
  usageOf(() => buildCase(run({ declarations: [{ method: 'POST', url: `http://localhost:5173/${REDACTED}`, operation: null, approved: 'dialog', seq: 2 }] }), {}));
  usageOf(() => buildCase(run({ start: start({ deny: { host: 'd.example.com', mode: 'writable', allow: [{ method: 'POST', url: `http://d.example.com/${REDACTED}`, operation: null }] } }) }), {}));
});

test('actions or start in the wrong shape refuses to export', () => {
  const bad: unknown[] = [
    run({ actions: 'x' }), run({ actions: [null] }), run({ actions: [act(1, { op: 'click' }, 'wat')] }),
    run({ actions: [{ seq: 1, op: 'click', outcome: 'ok' }] }), run({ actions: [act(0, { op: 'click', target: '#a' }, 'ok')] }),
    run({ actions: [act(2, { op: 'click', target: '#a' }, 'ok'), act(2, { op: 'click', target: '#a' }, 'ok')] }),
    run({ actions: [{ ...act(1, { op: 'click', target: '#a' }, 'ok'), target: { given: 3, stable: null } }] }),
    run({ actions: undefined }), run({ start: undefined }), run({ start: 'x' }), run({ start: start({ url: 3 }) }),
    run({ start: start({ viewport: { width: 'a', height: 1 } }) }), run({ start: start({ touch: 'no' }) }), run({ start: start({ readonly: undefined }) }),
    run({ start: start({ profile: 3 }) }), run({ start: start({ profile: 'A/B' }) }), run({ start: start({ deny: 'x' }) }), run({ start: start({ deny: { host: 'h', mode: 'readonly', allow: 'x' } }) }),
    run({ writes: undefined }), run({ writes: { allowed: 'x' } }), run({ declarations: 'x' }), run({ declarations: [null] }), run({ findings: 'x' }), run({ findings: [{ claim: 3 }] }),
    run({ session: 'nope' }), run({ kernelVersion: 3 }), run({ name: REDACTED }), null, 'x', [], 3,
  ];
  for (const [i, r] of bad.entries()) {
    const e = usageOf(() => buildCase(r, {}));
    assert.ok(!e.message.includes(REDACTED), `case ${i}`);
  }
  assert.equal(usageOf(() => buildCase(run(), { name: 'Bad Name' })).code, 'usage');
  assert.equal(buildCase(run(), { name: 'mine' }).name, 'mine');
});

test('more than 500 selected steps refuses to export', () => {
  const actions = Array.from({ length: 501 }, (_, i) => act(i + 1, { op: 'hover', target: '#a' }, 'ok'));
  usageOf(() => buildCase(run({ actions }), {}));
  assert.equal(buildCase(run({ actions: actions.slice(0, 500) }), {}).steps.length, 500);
});

test('open.profile turns a@b into a/b', () => {
  assert.equal(buildCase(run({ start: start({ profile: 'g@work' }) }), {}).open.profile, 'g/work');
  assert.equal(buildCase(run({ start: start({ profile: 'g' }) }), {}).open.profile, 'g');
});

test('open carries viewport null, touch and readonly through', () => {
  const c = buildCase(run({ start: start({ viewport: null, touch: true, readonly: true }) }), {});
  assert.deepEqual(c.open, { url: 'http://localhost:5173/', profile: 'default', viewport: null, touch: true, readonly: true, allow: [] });
});

test('allow entries carry the seq of their declaration', () => {
  const declarations = [
    { method: 'POST', url: 'http://localhost:5173/api/save', operation: 'Save', approved: 'dialog', seq: 2 },
    { method: 'DELETE', url: 'http://localhost:5173/api/x', operation: null, approved: 'remembered', seq: 9 },
  ];
  const c = buildCase(run({ declarations }), {});
  assert.deepEqual(c.allow, [
    { method: 'POST', url: 'http://localhost:5173/api/save', operation: 'Save', seq: 2 },
    { method: 'DELETE', url: 'http://localhost:5173/api/x', seq: 9 },
  ]);
});

test('a declaration without an integer seq (a record from an older kernel) refuses to export, with a reason', () => {
  const decl = { method: 'POST', url: 'http://localhost:5173/a', operation: null, approved: 'dialog' };
  for (const d of [decl, { ...decl, seq: '2' }, { ...decl, seq: 0 }, { ...decl, seq: 1.5 }]) {
    const e = usageOf(() => buildCase(run({ declarations: [{ ...decl, seq: 3 }, d] }), {}));
    assert.match(e.message, /序号/);
  }
});

test('open.allow comes from start.deny.allow (operation null is left out)', () => {
  const deny = { host: 'd.example.com', mode: 'writable', allow: [{ method: 'POST', url: 'http://d.example.com/api', operation: 'Go' }, { method: 'PUT', url: 'http://d.example.com/b', operation: null }] };
  const c = buildCase(run({ start: start({ url: 'http://d.example.com/', deny }) }), {});
  assert.deepEqual(c.open.allow, [{ method: 'POST', url: 'http://d.example.com/api', operation: 'Go' }, { method: 'PUT', url: 'http://d.example.com/b' }]);
  assert.deepEqual(c.allow, []);
});

test('containsWrites is true when the session let writes through or declared any', () => {
  assert.equal(buildCase(run(), {}).containsWrites, false);
  assert.equal(buildCase(run({ writes: { allowed: [{ id: 'w1' }], blocked: [], unattributed: [] } }), {}).containsWrites, true);
  assert.equal(buildCase(run({ writes: { allowed: [], blocked: [{ id: 'w1' }], unattributed: [{ id: 'w2' }] } }), {}).containsWrites, false);
  assert.equal(buildCase(run({ declarations: [{ method: 'POST', url: 'http://localhost:5173/a', operation: null, approved: 'dialog', seq: 2 }] }), {}).containsWrites, true);
});

test('buildCase output always passes parseCase (and parseCase gives the same case back)', () => {
  const variants: Record<string, unknown>[] = [
    {},
    { start: start({ profile: 'g@s', viewport: null, touch: true, readonly: true }) },
    { declarations: [{ method: 'POST', url: 'http://localhost:5173/a', operation: 'Op', approved: 'dialog', seq: 2 }] },
    { start: start({ deny: { host: 'h.example.com', mode: 'writable', allow: [{ method: 'PATCH', url: 'http://h.example.com/a', operation: null }] } }) },
    { actions: [act(1, { op: 'fill', target: '#a', value: REDACTED }, 'ok', { given: '#a', stable: { selector: '#a', via: 'given' } }), act(2, { op: 'click', target: '#b' }, 'ok')] },
  ];
  for (const [i, over] of variants.entries()) {
    const c = buildCase(run(over), {});
    assert.deepEqual(parseCase(JSON.stringify(c)), c, `variant ${i}`);
    assert.deepEqual(parseCase(JSON.stringify(c, null, 2)), c, `variant ${i} pretty`);
  }
  const every = buildCase(run(), { steps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.deepEqual(parseCase(JSON.stringify(every)), every);
});

// ---- parseCase：用例文件可能被手改，严格 ----

function goodCase(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildCase(run({ declarations: [{ method: 'POST', url: 'http://localhost:5173/a', operation: 'Op', approved: 'dialog', seq: 2 }] }), {}))) as Record<string, unknown>;
}

// 不回显原值的探针：运行时拼出来的独特串。
const probe = ['zq', 'Xv7', 'kp-unique'].join('-');

function refuses(text: string, why: string): void {
  const e = usageOf(() => parseCase(text));
  assert.match(e.message, /^用例文件不对：/, why);
  assert.ok(!e.message.toLowerCase().includes(probe.toLowerCase()), `${why}: no echo`);
}

test('parseCase refuses extra keys (top level and nested), a wrong version, and missing keys, without echoing', () => {
  const g = goodCase();
  assert.doesNotThrow(() => parseCase(JSON.stringify(g)));
  refuses(JSON.stringify({ ...g, [probe]: 1 }), 'extra top-level key');
  refuses(JSON.stringify({ ...g, e2kCase: 2 }), 'version 2');
  refuses(JSON.stringify({ ...g, e2kCase: '1' }), 'version string');
  const noName = { ...g };
  delete noName.name;
  refuses(JSON.stringify(noName), 'missing name');
  refuses(JSON.stringify({ ...g, source: { ...(g.source as object), [probe]: 1 } }), 'extra source key');
  refuses(JSON.stringify({ ...g, open: { ...(g.open as object), [probe]: 1 } }), 'extra open key');
  refuses(JSON.stringify({ ...g, findings: [{ claim: 'x', [probe]: 1 }] }), 'extra finding key');
  refuses(JSON.stringify({ ...g, allow: [{ method: 'POST', url: 'http://localhost:5173/a', seq: 1, [probe]: 1 }] }), 'extra allow key');
  refuses(JSON.stringify({ ...g, steps: [{ seq: 1, op: { op: 'click', target: '#a', [probe]: 1 } }] }), 'extra op key');
  refuses(`{"e2kCase":1,"${probe}":`, 'truncated JSON');
  refuses(probe, 'not JSON');
  refuses(JSON.stringify([g]), 'an array');
  refuses('null', 'null');
  refuses(JSON.stringify(Object.fromEntries([['__proto__', { x: 1 }], ...Object.entries(g)])), 'a __proto__ key');
  refuses(JSON.stringify({ ...g, name: probe.toUpperCase() }), 'bad name');
  refuses(JSON.stringify({ ...g, source: { session: probe, kernelVersion: '1' } }), 'bad session id');
  refuses(JSON.stringify({ ...g, open: { ...(g.open as object), url: `ftp://${probe}/` } }), 'bad url');
  refuses(JSON.stringify({ ...g, open: { ...(g.open as object), profile: probe.toUpperCase() } }), 'bad profile');
  refuses(JSON.stringify({ ...g, open: { ...(g.open as object), viewport: { width: 1, height: 1 } } }), 'bad viewport');
  refuses(JSON.stringify({ ...g, containsWrites: probe }), 'bad flag');
});

test('parseCase refuses a bad op, eval, a step with both op and skip (or neither), and bad step counts, without echoing', () => {
  const g = goodCase();
  const withSteps = (steps: unknown): string => JSON.stringify({ ...g, steps });
  refuses(withSteps([{ seq: 1, op: { op: 'nope', target: probe } }]), 'unknown op');
  refuses(withSteps([{ seq: 1, op: { op: 'click' } }]), 'click without target');
  refuses(withSteps([{ seq: 1, op: { op: 'goto', url: `javascript:${probe}` } }]), 'goto javascript:');
  refuses(withSteps([{ seq: 1, op: { op: 'eval', js: probe } }]), 'eval op');
  refuses(withSteps([{ seq: 1, op: { op: 'click', target: '#a' }, skip: { op: 'click', why: 'x' } }]), 'both op and skip');
  refuses(withSteps([{ seq: 1 }]), 'neither op nor skip');
  refuses(withSteps([{ op: { op: 'click', target: '#a' } }]), 'no seq');
  refuses(withSteps([{ seq: 0, op: { op: 'click', target: '#a' } }]), 'seq 0');
  refuses(withSteps([{ seq: 2, op: { op: 'click', target: '#a' } }, { seq: 1, op: { op: 'click', target: '#a' } }]), 'seq not increasing');
  refuses(withSteps([{ seq: 1, skip: { op: 'click', why: 'x', [probe]: 1 } }]), 'extra skip key');
  refuses(withSteps([{ seq: 1, skip: { op: probe, why: 'x' } }]), 'skip op not an op name');
  refuses(withSteps([{ seq: 1, skip: { op: 'click', why: 3 } }]), 'skip why not a string');
  refuses(withSteps([{ seq: 1, skip: 'x' }]), 'skip not an object');
  refuses(withSteps([]), 'no steps');
  refuses(withSteps('x'), 'steps not an array');
  refuses(withSteps(Array.from({ length: 501 }, (_, i) => ({ seq: i + 1, op: { op: 'hover', target: '#a' } }))), '501 steps');
  assert.doesNotThrow(() => parseCase(withSteps(Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, op: { op: 'hover', target: '#a' } })))));
  assert.doesNotThrow(() => parseCase(withSteps([{ seq: 4, skip: { op: 'eval', why: '不能重放' } }])));
});

test('parseCase refuses an executable step with [REDACTED] in any string or with a snapshot-ref target, without echoing', () => {
  const g = goodCase();
  const withSteps = (steps: unknown): string => JSON.stringify({ ...g, steps });
  const bads: Record<string, unknown>[] = [
    { op: 'fill', target: '#a', value: `x ${REDACTED} ${probe}` }, { op: 'wait', for: { text: `${REDACTED}${probe}` } }, { op: 'wait', for: { urlContains: REDACTED } },
    { op: 'click', target: `[title=${REDACTED}]` }, { op: 'goto', url: `http://localhost:5173/${REDACTED}` },
    { op: 'click', target: 'e5' }, { op: 'hover', target: 'f2e11' }, { op: 'wait', for: { target: 'e3', state: 'visible' } }, { op: 'screenshot', mask: ['#a', 'e4'] },
    { op: 'text', target: 'e1' }, { op: 'assert', kind: 'text', target: 'e2', cmp: 'eq', expected: probe },
  ];
  for (const op of bads) refuses(withSteps([{ seq: 1, op }]), JSON.stringify(op));
  // 选择器长得不像引用就可以
  assert.doesNotThrow(() => parseCase(withSteps([{ seq: 1, op: { op: 'click', target: '#e5' } }])));
});

test('containsWrites is also true when the case carries an open.allow list (a deny-host write list)', () => {
  const deny = { host: 'd.example.com', mode: 'writable', allow: [{ method: 'POST', url: 'http://d.example.com/api', operation: null }] };
  assert.equal(buildCase(run({ start: start({ url: 'http://d.example.com/', deny }) }), {}).containsWrites, true);
  assert.equal(buildCase(run({ start: start({ url: 'http://d.example.com/', deny: { ...deny, mode: 'readonly', allow: [] } }) }), {}).containsWrites, false);
});

test('parseCase refuses bad allow entries and more than 12 for one seq', () => {
  const g = goodCase();
  const withAllow = (allow: unknown): string => JSON.stringify({ ...g, allow });
  const item = { method: 'POST', url: 'http://localhost:5173/a', seq: 1 };
  assert.doesNotThrow(() => parseCase(withAllow([item, { ...item, operation: 'Op' }])));
  refuses(withAllow([{ ...item, method: 'GET' }]), 'GET');
  refuses(withAllow([{ ...item, url: '' }]), 'empty url');
  refuses(withAllow([{ ...item, operation: '' }]), 'empty operation');
  refuses(withAllow([{ ...item, seq: 0 }]), 'seq 0');
  refuses(withAllow([{ method: 'POST', url: 'http://localhost:5173/a' }]), 'no seq');
  refuses(withAllow('x'), 'not an array');
  refuses(withAllow(Array.from({ length: 13 }, () => item)), '13 for one seq');
  assert.doesNotThrow(() => parseCase(withAllow(Array.from({ length: 12 }, () => item))));
  const bigOpen = JSON.stringify({ ...g, open: { ...(g.open as object), allow: Array.from({ length: 13 }, () => ({ method: 'POST', url: 'http://localhost:5173/a' })) } });
  refuses(bigOpen, 'open.allow 13');
  refuses(JSON.stringify({ ...g, open: { ...(g.open as object), allow: [{ ...item }] } }), 'open.allow entry with seq');
});

test('parseCase refuses more than MAX_CASE_BYTES', () => {
  const g = goodCase();
  const text = JSON.stringify({ ...g, findings: [{ claim: 'x' }] });
  assert.ok(Buffer.byteLength(text) < MAX_CASE_BYTES);
  assert.equal(MAX_CASE_BYTES, 1_000_000);
  refuses(`${text}${' '.repeat(MAX_CASE_BYTES)}`, 'too big');
  refuses(JSON.stringify({ ...g, findings: Array.from({ length: 20 }, () => ({ claim: probe.repeat(5000) })) }), 'huge but under 20 claims');
});

test('parseCase refuses more than 20 findings and an empty or over-long claim', () => {
  const g = goodCase();
  refuses(JSON.stringify({ ...g, findings: Array.from({ length: 21 }, () => ({ claim: 'x' })) }), '21 findings');
  refuses(JSON.stringify({ ...g, findings: [{ claim: '' }] }), 'empty claim');
  refuses(JSON.stringify({ ...g, findings: [{ claim: 'x'.repeat(501) }] }), 'long claim');
});

test('readCaseFile reads a case file, and refuses a symlink, a directory, a missing file and an oversized file, without echoing the path', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'e2k-case-')));
  try {
    chmodSync(dir, 0o700);
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(goodCase()));
    assert.deepEqual(readCaseFile(good), parseCase(JSON.stringify(goodCase())));
    const link = join(dir, 'link.json');
    symlinkSync(good, link);
    usageOf(() => readCaseFile(link));
    mkdirSync(join(dir, 'd.json'));
    usageOf(() => readCaseFile(join(dir, 'd.json')));
    usageOf(() => readCaseFile(join(dir, 'missing.json')));
    const big = join(dir, 'big.json');
    writeFileSync(big, ' '.repeat(MAX_CASE_BYTES + 1));
    const e = usageOf(() => readCaseFile(big));
    assert.ok(!e.message.includes(dir));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, `{"${probe}": 1}`);
    assert.ok(!usageOf(() => readCaseFile(bad)).message.includes(probe));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a claim over 500 characters is clipped to 500 instead of failing the export, without splitting a surrogate pair', () => {
  const long = 'a'.repeat(600);
  const c = buildCase(run({ findings: [{ claim: long, basis: 'b', verdict: 'pass' }, { claim: 'short', basis: 'b', verdict: 'fail' }] }), {});
  assert.deepEqual(c.findings, [{ claim: 'a'.repeat(500) }, { claim: 'short' }]);
  // 第 500 个代码单元正好是代理对的前半：去掉它，剩 499 个
  const pair = buildCase(run({ findings: [{ claim: 'b'.repeat(499) + '\u{1F600}' + 'c' }] }), {});
  assert.equal(pair.findings[0]!.claim, 'b'.repeat(499));
  assert.doesNotThrow(() => parseCase(JSON.stringify(c)));
});
