import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoleTarget, stableCandidates } from '../../src/drivers/playwright/stable.ts';

test('candidates in priority order', () => {
  assert.deepEqual(stableCandidates({ testId: 'add', id: 'x', role: 'button', name: 'Add', cssPath: 'body > button:nth-of-type(1)' }), [
    { selector: '[data-testid="add"]', via: 'testid' }, { selector: '#x', via: 'id' },
    { selector: 'role=button[name="Add"]', via: 'role' }, { selector: 'body > button:nth-of-type(1)', via: 'css' }]);
});

test('escaping and omissions', () => {
  const c = stableCandidates({ testId: null, id: 'a:b', role: 'button', name: 'Say "hi"', cssPath: 'body > button:nth-of-type(2)' });
  assert.deepEqual(c.map(x => x.selector), ['[id="a:b"]', 'role=button[name="Say \\"hi\\""]', 'body > button:nth-of-type(2)']);
  assert.deepEqual(stableCandidates({ testId: null, id: null, role: 'button', name: null, cssPath: 'p' }).map(x => x.via), ['css']);
});

test('quotes and backslashes in values are escaped, so a value cannot close the attribute early', () => {
  const c = stableCandidates({ testId: 'a"]b\\', id: 'x"y', role: null, name: null, cssPath: 'p' });
  assert.deepEqual(c.map(x => x.selector), ['[data-testid="a\\"]b\\\\"]', '[id="x\\"y"]', 'p']);
});

test('ids that are valid CSS identifiers use the # form, others the attribute form', () => {
  const sel = (id: string): string | undefined =>
    stableCandidates({ testId: null, id, role: null, name: null, cssPath: 'p' }).find(x => x.via === 'id')?.selector;
  assert.equal(sel('save-btn_2'), '#save-btn_2');
  assert.equal(sel('_x'), '#_x');
  assert.equal(sel('-x'), '#-x');
  for (const id of ['1abc', '-1', 'a b', 'a.b', 'a#b', 'a:b', '-', 'é'])
    assert.equal(sel(id), `[id="${id}"]`, id);
});

test('empty strings count as absent', () => {
  assert.deepEqual(stableCandidates({ testId: '', id: '', role: 'button', name: '', cssPath: 'p' }).map(x => x.via), ['css']);
  assert.deepEqual(stableCandidates({ testId: null, id: null, role: '', name: 'Add', cssPath: 'p' }).map(x => x.via), ['css']);
});

test('a role that is not a plain word is not written into a selector', () => {
  assert.deepEqual(stableCandidates({ testId: null, id: null, role: 'a]b', name: 'x', cssPath: 'p' }).map(x => x.via), ['css']);
});

test('parseRoleTarget round-trips what stableCandidates writes', () => {
  assert.deepEqual(parseRoleTarget('role=button[name="Say \\"hi\\""]'), { role: 'button', name: 'Say "hi"' });
  assert.equal(parseRoleTarget('#save'), null);
  assert.equal(parseRoleTarget('role=button'), null);
});

test('parseRoleTarget round-trips awkward names and rejects near-misses', () => {
  for (const name of ['a\\b', 'a\\"b', '"', '\\', 'x]y', 'line1\nline2', '文字']) {
    const sel = stableCandidates({ testId: null, id: null, role: 'link', name, cssPath: 'p' })[0]?.selector ?? '';
    assert.deepEqual(parseRoleTarget(sel), { role: 'link', name }, JSON.stringify(name));
  }
  for (const t of ['role=button[name="a"]x', 'xrole=button[name="a"]', 'role=button[name="a\\"]', 'role=button[name="a"b"]',
    'role=[name="a"]', 'role=button[name=a]', 'role=button[name="a"][x]', 'button[name="a"]'])
    assert.equal(parseRoleTarget(t), null, t);
});
