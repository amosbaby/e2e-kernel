import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../../src/shared/escape.ts';

test('escapeHtml', () => assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;'));

test('escapeHtml escapes every occurrence, does not double-decode, and leaves other text alone', () => {
  assert.equal(escapeHtml('<<>>&&'), '&lt;&lt;&gt;&gt;&amp;&amp;');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  assert.equal(escapeHtml('plain 文字 ✓'), 'plain 文字 ✓');
  assert.equal(escapeHtml(''), '');
});
