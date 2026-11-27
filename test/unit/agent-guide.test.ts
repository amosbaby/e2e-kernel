import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// docs/agent-guide.md 是 agent 第一次读的短说明：要够短，里面的 JSON 示例要能解析。
const GUIDE = new URL('../../docs/agent-guide.md', import.meta.url);
const MAX_BYTES = 15000;

test('the agent guide is at most 15000 bytes', () => {
  const text = readFileSync(GUIDE, 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_BYTES, `agent-guide.md 超过 ${MAX_BYTES} 字节`);
});

test('every json block in the agent guide parses', () => {
  const text = readFileSync(GUIDE, 'utf8');
  const blocks = [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)];
  assert.ok(blocks.length > 0, '至少要有一个 json 示例');
  for (const [i, m] of blocks.entries()) {
    assert.doesNotThrow(() => { JSON.parse(m[1] ?? ''); }, `第 ${i + 1} 个 json 块不是合法 JSON`);
  }
});

// 终审 I-4：待批期间只有新增或改成只读的 rules 条目立即生效；登出、登录主机、白名单、身份、组的改动都要等批准。文字不能说多。
test('the docs say that only new or read-only rules are in force before approval, not that tightening is', () => {
  const guide = readFileSync(GUIDE, 'utf8');
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(guide, /新增或改成只读的 `rules` 条目/);
  assert.match(guide, /登出、登录主机、白名单、身份、组/);
  assert.doesNotMatch(guide, /收紧已生效|收紧的部分已生效/);
  assert.match(readme, /only a new or read-only entry of `rules` is in force at once/);
  assert.doesNotMatch(readme, /a tightening one is in force at once/);
});
