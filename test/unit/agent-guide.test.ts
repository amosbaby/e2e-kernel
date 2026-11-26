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
