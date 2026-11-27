import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E2kError } from '../../src/shared/errors.ts';
import { DECLARABLE_METHODS, MAX_DECLARATIONS, declarationKey, normalizeDeclarations, sameDeclaration } from '../../src/kernel/declarations.ts';

const isUsage = (e: unknown): boolean => e instanceof E2kError && e.code === 'usage';
const item = (method: string, url: string, operation?: string) => (operation === undefined ? { method, url } : { method, url, operation });

test('constants: the four write methods, at most 12', () => {
  assert.deepEqual([...DECLARABLE_METHODS], ['POST', 'PUT', 'PATCH', 'DELETE']);
  assert.equal(MAX_DECLARATIONS, 12);
});

test('declarations are normalised to the canonical address, operation null when absent', () => {
  assert.deepEqual(normalizeDeclarations([item('POST', 'HTTP://API.Example.com:80/v1/items'), item('PUT', 'https://api.example.com'), item('DELETE', 'http://127.0.0.1:3000/x/*', 'Gone')]), [
    { method: 'DELETE', url: 'http://127.0.0.1:3000/x/*', operation: 'Gone' },
    { method: 'POST', url: 'http://api.example.com/v1/items', operation: null },
    { method: 'PUT', url: 'https://api.example.com/', operation: null },
  ]);
});

test('duplicates collapse and the result is sorted, so the same set always gives the same list', () => {
  const a = item('POST', 'http://api.example.com/a');
  const b = item('POST', 'http://api.example.com/b', 'Save');
  const c = item('POST', 'http://api.example.com/b');
  const x = normalizeDeclarations([b, a, c, { ...a }, item('POST', 'http://API.example.com/a')]);
  assert.equal(x.length, 3);
  assert.deepEqual(normalizeDeclarations([c, b, a]), x);
  assert.deepEqual(normalizeDeclarations([a, b, c]), x);
  assert.deepEqual(normalizeDeclarations([]), []);
});

test('more than twelve entries are a usage error, twelve are fine', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => item('POST', `http://api.example.com/${i}`));
  assert.equal(normalizeDeclarations(many(12)).length, 12);
  assert.throws(() => normalizeDeclarations(many(13)), isUsage);
});

test('rejected: other methods, a query string, a fragment, credentials, a relative or odd url, a bad operation', () => {
  const bad: unknown[] = [
    item('GET', 'http://api.example.com/x'), item('post', 'http://api.example.com/x'), item('OPTIONS', 'http://api.example.com/x'),
    item('POST', 'http://api.example.com/x?y=1'), item('POST', 'http://api.example.com/x?'), item('POST', 'http://api.example.com/x#f'),
    item('POST', 'http://user:pw@api.example.com/x'), item('POST', '/x'), item('POST', 'ftp://api.example.com/x'), item('POST', 'http://api.example.com/a b'),
    item('POST', 'http://api.example.com/a/../b'), item('POST', 'http://api.example.com/a%2Fb'), item('POST', 'http://*.example.com/x'), item('POST', 'http://api.example.com/a*'),
    item('POST', 'http://api.example.com/x', 'a-b'), item('POST', 'http://api.example.com/x', '1abc'), item('POST', 'http://api.example.com/x', ''), item('POST', 'http://api.example.com/x', 'A'.repeat(101)),
    item('POST', 'http://api.example.com/x', 'Save\n'), { method: 'POST', url: 'http://api.example.com/x', operation: 5 }, { method: 'POST', url: 'http://api.example.com/x', extra: 1 },
  ];
  for (const b of bad) assert.throws(() => normalizeDeclarations([b as never]), isUsage, JSON.stringify(b));
  assert.doesNotThrow(() => normalizeDeclarations([item('POST', 'http://api.example.com/x', '_a1'), item('POST', 'http://api.example.com/x', 'A'.repeat(100))]));
});

test('the usage message names the field and never echoes the given value', () => {
  try {
    normalizeDeclarations([item('POST', 'http://api.example.com/x?token=Zq7x91Lk')]);
    assert.fail('should throw');
  } catch (e) {
    assert.ok(isUsage(e));
    assert.ok(!(e as Error).message.includes('Zq7x91Lk') && /allow\[0\]/.test((e as Error).message));
  }
});

test('the operation is part of a declaration\'s identity: same method and address with different operations (or none) are different entries', () => {
  const url = 'http://api.example.com/graphql';
  const out = normalizeDeclarations([item('POST', url), item('POST', url, 'Save'), item('POST', url, 'Other'), item('POST', url, 'Save')]);
  assert.deepEqual(out.map((d) => d.operation).sort(), ['Other', 'Save', null]);
  assert.notEqual(declarationKey({ method: 'POST', url, operation: null }), declarationKey({ method: 'POST', url, operation: 'Save' }));
  assert.equal(sameDeclaration({ method: 'POST', url, operation: 'Save' }, { method: 'POST', url, operation: 'Other' }), false);
});
