import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E2kError } from '../../src/shared/errors.ts';
import { bool, httpUrl, int, oneOf, plainObject, str } from '../../src/shared/validate.ts';

const isUsage = (e: unknown) => e instanceof E2kError && e.code === 'usage';

test('httpUrl', () => {
  assert.equal(httpUrl('http://localhost:5173/a?b=1', 'url'), 'http://localhost:5173/a?b=1');
  for (const bad of ['file:///etc/hosts', 'javascript:alert(1)', 'http://user:pw@example.com/', 'not a url', 12,
    'http://example.com/' + 'a'.repeat(2048)])
    assert.throws(() => httpUrl(bad, 'url'), /url/);
});

test('httpUrl normalizes, accepts https, and rejects a username alone, other schemes and an over-long href', () => {
  assert.equal(httpUrl('HTTPS://Example.com', 'url'), 'https://example.com/');
  for (const bad of ['http://user@example.com/', 'ftp://example.com/', 'data:text/html,x', '', null, undefined,
    'http://example.com/' + ' x'.repeat(700)])
    assert.throws(() => httpUrl(bad, 'url'), isUsage);
});

test('str, int, bool, oneOf, plainObject', () => {
  assert.throws(() => str('ab', 'n', { max: 1 }));
  assert.throws(() => str('A', 'n', { max: 9, pattern: /^[a-z]+$/ }));
  assert.throws(() => int('3', 'n', { min: 0, max: 9 }));
  assert.throws(() => int(3.5, 'n', { min: 0, max: 9 }));
  assert.throws(() => int(10, 'n', { min: 0, max: 9 }));
  assert.throws(() => bool('true', 'n'));
  assert.throws(() => oneOf('x', 'n', ['a', 'b']));
  assert.throws(() => plainObject({ a: 1, b: 2 }, 'p', ['a']), /b/);
  for (const bad of [[], null, 'x']) assert.throws(() => plainObject(bad, 'p', []));
});

test('valid values pass through unchanged', () => {
  assert.equal(str('abc', 'n', { min: 1, max: 3, pattern: /^[a-z]+$/ }), 'abc');
  assert.equal(str('', 'n', { max: 3 }), '');
  assert.equal(int(0, 'n', { min: 0, max: 9 }), 0);
  assert.equal(int(9, 'n', { min: 0, max: 9 }), 9);
  assert.equal(bool(false, 'n'), false);
  assert.equal(oneOf('b', 'n', ['a', 'b'] as const), 'b');
  const obj = { a: 1 };
  assert.equal(plainObject(obj, 'p', ['a', 'b']), obj);
  const bare: Record<string, unknown> = Object.create(null);
  bare.a = 1;
  assert.equal(plainObject(bare, 'p', ['a']), bare);
});

test('every rejection is an E2kError with code usage', () => {
  const cases: (() => unknown)[] = [
    () => str(1, 'n', { max: 3 }), () => str('', 'n', { min: 1, max: 3 }),
    () => int(-1, 'n', { min: 0, max: 9 }), () => int(Number.NaN, 'n', { min: 0, max: 9 }),
    () => int(Number.POSITIVE_INFINITY, 'n', { min: 0, max: Number.POSITIVE_INFINITY }),
    () => bool(0, 'n'), () => oneOf(1, 'n', ['a']), () => oneOf('toString', 'n', ['a']),
    () => plainObject(new Date(), 'p', []), () => plainObject(new Map(), 'p', []),
    () => plainObject({ ['__proto__']: 1 }, 'p', []), () => plainObject(JSON.parse('{"__proto__":{"x":1}}'), 'p', []),
  ];
  for (const run of cases) assert.throws(run, isUsage);
});

test('plainObject names the unexpected key, quoted and cut short', () => {
  const long = 'k'.repeat(500);
  assert.throws(() => plainObject({ [long]: 1 }, 'p', []), (e: Error) =>
    isUsage(e) && e.message.includes('"kkk') && e.message.length < 200);
  assert.throws(() => plainObject({ 'a\nb': 1 }, 'p', []), (e: Error) => isUsage(e) && !e.message.includes('\n'));
});

test('error messages name the field but never echo the value', () => {
  const cases: (() => unknown)[] = [() => httpUrl('http://user:hunter2x@example.com/', 'url'), () => str('hunter2x', 'field', { max: 3 }),
    () => oneOf('hunter2x', 'field', ['a']), () => int('hunter2x', 'field', { min: 0, max: 1 })];
  for (const run of cases)
    assert.throws(run, (e: Error) => !e.message.includes('hunter2x') && /url|field/.test(e.message));
});
