import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { E2kError } from '../../src/shared/errors.ts';
import { CMP_BY_KIND, READ_OPS, isRef, validateOps } from '../../src/shared/ops.ts';

const isUsage = (e: E2kError) => e.code === 'usage';

test('validateOps accepts the v1 operations', () => {
  const ops = [
    { op: 'snapshot' }, { op: 'click', target: 'e2' },
    { op: 'fill', target: 'role=textbox[name="New item"]', value: 'x' },
    { op: 'press', key: 'Control+a' }, { op: 'press', key: '/' },
    { op: 'wait', for: { text: 'Added' }, timeoutMs: 5000 },
    { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Added' },
    { op: 'assert', kind: 'css', target: '#styled', property: 'font-size', cmp: 'gte', expected: 18 },
    { op: 'assert', kind: 'url', cmp: 'contains', expected: '/index.html' },
    { op: 'eval', js: 'document.title' },
  ];
  assert.deepEqual(validateOps(ops), ops);
});

test('validateOps accepts every other operation shape', () => {
  const ops = [
    { op: 'snapshot', depth: 5 }, { op: 'text', target: 'e1', max: 20000 }, { op: 'text' },
    { op: 'screenshot', fullPage: true }, { op: 'console' }, { op: 'network' }, { op: 'hover', target: 'f1e3' },
    { op: 'press', key: 'Enter', target: 'e4' }, { op: 'scroll', dx: -10000, dy: 10000 }, { op: 'scroll', target: 'e5' },
    { op: 'goto', url: 'http://localhost:5173/a' }, { op: 'viewport', width: 3840, height: 2160 },
    { op: 'wait', for: { target: 'e1', state: 'hidden' } }, { op: 'wait', for: { urlContains: '/done' }, timeoutMs: 60000 },
    { op: 'wait', for: { ms: 0 } }, { op: 'wait', for: { idle: 100 } }, { op: 'wait', for: { idle: 9500 }, timeoutMs: 10000 },
    { op: 'wait', for: { idle: 500 }, timeoutMs: 1000 },
    { op: 'assert', kind: 'count', target: 'li', cmp: 'lte', expected: 3 },
    { op: 'assert', kind: 'visible', target: 'e1', cmp: 'ne', expected: false },
    { op: 'assert', kind: 'css', target: '#a', property: 'color', cmp: 'eq', expected: 'rgb(0, 0, 0)' },
  ];
  assert.deepEqual(validateOps(ops), ops);
});

test('screenshot accepts label, target, format and mask in any valid combination', () => {
  const ops = [
    { op: 'screenshot' }, { op: 'screenshot', label: 'checkout-mobile' }, { op: 'screenshot', label: 'a', format: 'png' },
    { op: 'screenshot', format: 'jpeg', fullPage: true }, { op: 'screenshot', target: '#card' }, { op: 'screenshot', target: 'e3', fullPage: false },
    { op: 'screenshot', mask: ['#a'] }, { op: 'screenshot', target: '#card', mask: ['e1', '.x'], label: '0-9', format: 'png' },
    { op: 'screenshot', label: 'x'.repeat(40) }, { op: 'screenshot', mask: Array.from({ length: 10 }, (_, i) => `#m${i}`) },
  ];
  assert.deepEqual(validateOps(ops), ops);
});

test('screenshot rejects unsafe labels, bad formats, fullPage with target and bad masks', () => {
  const bad: unknown[] = [
    ...['Shot', 'a/b', '../x', 'a.b', 'a_b', '-a', '', 'a b', 'x'.repeat(41), 'é', 'a\nb', 'a\n'].map((label) => [{ op: 'screenshot', label }]),
    [{ op: 'screenshot', label: 1 }], [{ op: 'screenshot', format: 'gif' }], [{ op: 'screenshot', format: 'PNG' }], [{ op: 'screenshot', format: 1 }],
    [{ op: 'screenshot', fullPage: true, target: '#a' }], [{ op: 'screenshot', target: '' }], [{ op: 'screenshot', target: 'x'.repeat(501) }],
    [{ op: 'screenshot', mask: [] }], [{ op: 'screenshot', mask: Array.from({ length: 11 }, (_, i) => `#m${i}`) }],
    [{ op: 'screenshot', mask: '#a' }], [{ op: 'screenshot', mask: [''] }], [{ op: 'screenshot', mask: [1] }], [{ op: 'screenshot', maskColor: '#fff' }],
  ];
  for (const b of bad) assert.throws(() => validateOps(b), isUsage, JSON.stringify(b).slice(0, 120));
  assert.throws(() => validateOps([{ op: 'screenshot', fullPage: true, target: '#a' }]),
    (e: E2kError) => e.code === 'usage' && e.message.includes('fullPage and target cannot be used together'));
});

test('the label rule holds up against long adversarial input', () => {
  const t0 = Date.now();
  for (const label of ['a'.repeat(30000), 'a-'.repeat(15000), '-'.repeat(30000) + '!'])
    assert.throws(() => validateOps([{ op: 'screenshot', label }]), isUsage);
  assert.ok(Date.now() - t0 < 2000);
});

test('validateOps rejects bad operations', () => {
  const bad: unknown[] = [
    [], Array(51).fill({ op: 'snapshot' }), 'x',
    [{ op: 'click' }], [{ op: 'click', target: 'e2', extra: 1 }], [{ op: 'approve' }],
    [{ op: 'press', key: 'a b' }], [{ op: 'press', key: 'x'.repeat(51) }],
    [{ op: 'assert', kind: 'text', target: '#a', cmp: 'gt', expected: 'x' }],
    [{ op: 'assert', kind: 'text', target: '#a', cmp: 'matches', expected: 'x' }],
    [{ op: 'assert', kind: 'css', target: '#a', cmp: 'eq', expected: '1px' }],
    [{ op: 'assert', kind: 'count', target: 'li', cmp: 'eq', expected: '3' }],
    [{ op: 'eval', js: 'x'.repeat(20001) }], [{ op: 'wait', for: { ms: 10001 } }],
    [{ op: 'goto', url: 'file:///x' }], [{ op: 'viewport', width: 100, height: 100 }],
  ];
  for (const b of bad) assert.throws(() => validateOps(b), isUsage);
});

test('validateOps rejects field-level violations', () => {
  const bad: unknown[] = [
    [null], [[]], [{}], [{ op: 'click', target: '' }], [{ op: 'click', target: 'x'.repeat(501) }],
    [{ op: 'fill', target: 'e1', value: 'x'.repeat(10001) }], [{ op: 'eval', js: '' }],
    [{ op: 'snapshot', depth: 0 }], [{ op: 'snapshot', depth: 51 }], [{ op: 'text', max: 20001 }],
    [{ op: 'scroll', dx: 10001 }], [{ op: 'screenshot', fullPage: 'yes' }], [{ op: 'console', target: 'e1' }],
    [{ op: 'wait', for: { text: 'a' }, timeoutMs: 60001 }], [{ op: 'wait', for: { text: '' } }],
    [{ op: 'wait', for: { urlContains: 'x'.repeat(501) } }], [{ op: 'wait' }],
    [{ op: 'assert', kind: 'url', target: 'e1', cmp: 'eq', expected: '/' }],
    [{ op: 'assert', kind: 'text', cmp: 'eq', expected: 'x' }],
    [{ op: 'assert', kind: 'text', target: 'e1', property: 'color', cmp: 'eq', expected: 'x' }],
    [{ op: 'assert', kind: 'css', target: 'e1', property: 'Font_Size', cmp: 'eq', expected: 'x' }],
    [{ op: 'assert', kind: 'css', target: 'e1', property: 'color', cmp: 'contains', expected: 'x' }],
    [{ op: 'assert', kind: 'css', target: 'e1', property: 'color', cmp: 'eq', expected: true }],
    [{ op: 'assert', kind: 'visible', target: 'e1', cmp: 'gt', expected: true }],
    [{ op: 'assert', kind: 'visible', target: 'e1', cmp: 'eq', expected: 'true' }],
    [{ op: 'assert', kind: 'count', target: 'li', cmp: 'eq', expected: 1.5 }],
    [{ op: 'assert', kind: 'text', target: 'e1', cmp: 'eq', expected: 'x'.repeat(2001) }],
    [{ op: 'assert', kind: 'text', target: 'e1', cmp: 'eq' }],
    [{ op: 'goto', url: 'http://user:pw@localhost/' }],
  ];
  for (const b of bad) assert.throws(() => validateOps(b), isUsage, JSON.stringify(b).slice(0, 120));
});

test('validateOps rejects unknown keys inside nested objects', () => {
  for (const b of [
    [{ op: 'wait', for: { text: 'a', extra: 1 } }],
    [{ op: 'wait', for: { target: 'e1', state: 'visible', extra: 1 } }],
    [{ op: 'wait', for: JSON.parse('{"ms":1,"__proto__":{}}') }],
  ]) assert.throws(() => validateOps(b), isUsage);
});

test('a wait condition must match exactly one variant', () => {
  for (const cond of [{}, { text: 'a', ms: 5 }, { urlContains: '/a', text: 'a' }, { target: 'e1' },
    { state: 'visible' }, { target: 'e1', state: 'gone' }, { ms: 1, target: 'e1', state: 'visible' }, null, 'Added'])
    assert.throws(() => validateOps([{ op: 'wait', for: cond }]), isUsage, JSON.stringify(cond));
});

test('an idle wait takes 100..10000 ms, stands alone, and needs a timeout 500 ms longer', () => {
  for (const b of [
    { op: 'wait', for: { idle: 50 } }, { op: 'wait', for: { idle: 99 } }, { op: 'wait', for: { idle: 10001 } },
    { op: 'wait', for: { idle: 100.5 } }, { op: 'wait', for: { idle: '200' } }, { op: 'wait', for: { idle: null } },
    { op: 'wait', for: { idle: 500, ms: 1 } }, { op: 'wait', for: { idle: 500, text: 'a' } },
    { op: 'wait', for: { idle: 500 }, timeoutMs: 499 }, { op: 'wait', for: { idle: 500 }, timeoutMs: 0 },
    { op: 'wait', for: { idle: 500 }, timeoutMs: 500 }, { op: 'wait', for: { idle: 500 }, timeoutMs: 999 },
    { op: 'wait', for: { idle: 10000 }, timeoutMs: 10000 }, { op: 'wait', for: { idle: 10000 }, timeoutMs: 10499 },
  ]) assert.throws(() => validateOps([b]), isUsage, JSON.stringify(b));
  assert.deepEqual(validateOps([{ op: 'wait', for: { idle: 10000 }, timeoutMs: 10500 }]), [{ op: 'wait', for: { idle: 10000 }, timeoutMs: 10500 }]);
});

test('error messages name the field and never echo the value', () => {
  const secretish = 'v'.repeat(10001);
  assert.throws(() => validateOps([{ op: 'snapshot' }, { op: 'fill', target: 'e1', value: secretish }]),
    (e: E2kError) => e.message.includes('ops[1].value') && !e.message.includes(secretish));
});

test('cmp table and read ops', () => {
  assert.deepEqual(CMP_BY_KIND, {
    text: ['eq', 'ne', 'contains'], url: ['eq', 'ne', 'contains'], count: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'],
    visible: ['eq', 'ne'], css: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'],
  });
  assert.deepEqual([...READ_OPS].sort(), ['console', 'network', 'screenshot', 'snapshot', 'text']);
});

test('isRef', () => {
  assert.ok(isRef('e2')); assert.ok(isRef('f1e3')); assert.ok(!isRef('#e2'));
  assert.ok(!isRef('e')); assert.ok(!isRef('f1')); assert.ok(!isRef('e2 ')); assert.ok(!isRef('xe2'));
});
