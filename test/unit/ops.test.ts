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
    { op: 'wait', for: { ms: 0 } },
    { op: 'assert', kind: 'count', target: 'li', cmp: 'lte', expected: 3 },
    { op: 'assert', kind: 'visible', target: 'e1', cmp: 'ne', expected: false },
    { op: 'assert', kind: 'css', target: '#a', property: 'color', cmp: 'eq', expected: 'rgb(0, 0, 0)' },
  ];
  assert.deepEqual(validateOps(ops), ops);
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
