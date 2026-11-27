import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { RpcError, serveJsonRpc } from '../../src/mcp/jsonrpc.ts';

type Handle = (method: string, params: unknown) => Promise<unknown>;

const echo: Handle = async (method, params) => {
  if (method === 'echo') return { params: params ?? null };
  if (method === 'rpc-error') throw new RpcError(-32602, 'params.x is wrong');
  if (method === 'boom') throw new Error('secret-detail-that-must-not-leak');
  if (method === 'slow') { await new Promise((r) => { setTimeout(r, 30); }); return { slow: true }; }
  if (method === 'fast') return { fast: true };
  if (method === 'nothing') return undefined;
  throw new RpcError(-32601, 'whatever');
};

// 把 chunks 依次写进输入，写完关掉；返回收到的每一行解析后的对象。
async function run(chunks: (string | Buffer)[], handle: Handle = echo, o: { maxLineBytes?: number } = {}): Promise<{ lines: string[]; msgs: Record<string, unknown>[] }> {
  const input = new PassThrough();
  const lines: string[] = [];
  const done = serveJsonRpc(input, (l) => { lines.push(l); }, handle, o);
  for (const c of chunks) input.write(c);
  input.end();
  await done;
  return { lines, msgs: lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const req = (o: Record<string, unknown>): string => `${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`;

describe('serveJsonRpc', () => {
  test('a request gets one response line with the same id; result undefined becomes {}', async () => {
    const { lines, msgs } = await run([req({ id: 1, method: 'echo', params: { a: 1 } }), req({ id: 'x', method: 'nothing' })]);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => !l.includes('\n')));
    assert.deepEqual(msgs[0], { jsonrpc: '2.0', id: 1, result: { params: { a: 1 } } });
    assert.deepEqual(msgs[1], { jsonrpc: '2.0', id: 'x', result: {} });
  });

  test('a message without an id whose method is not notifications/* is dropped: the handler is not called and nothing is answered', async () => {
    const called: string[] = [];
    const record: Handle = async (method) => { called.push(method); return {}; };
    const { msgs } = await run([req({ method: 'tools/call', params: { name: 'open' } }), req({ method: 'echo' }), req({ method: 'notifications/initialized' }), req({ id: 1, method: 'echo' })], record);
    assert.deepEqual(called, ['notifications/initialized', 'echo']);
    assert.deepEqual(msgs.map((m) => m.id), [1]);
  });

  test('notifications get no response, even when the handler fails; the next request still does', async () => {
    const { msgs } = await run([req({ method: 'echo' }), req({ method: 'boom' }), req({ method: 'nope' }), req({ id: 2, method: 'echo' })]);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.id, 2);
  });

  test('a parse error is -32700 with id null and the server keeps serving the next line', async () => {
    const { msgs } = await run(['{not json\n', req({ id: 7, method: 'echo' })]);
    assert.deepEqual(msgs[0], { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    assert.equal(msgs[1]!.id, 7);
    assert.ok('result' in msgs[1]!);
  });

  test('a request split over several chunks, and several requests in one chunk, are both framed by newline', async () => {
    const a = req({ id: 1, method: 'echo' });
    const { msgs } = await run([a.slice(0, 10), a.slice(10), req({ id: 2, method: 'echo' }) + req({ id: 3, method: 'echo' })]);
    assert.deepEqual(msgs.map((m) => m.id).sort(), [1, 2, 3]);
  });

  test('a multi-byte character split across chunks survives', async () => {
    const b = Buffer.from(req({ id: 1, method: 'echo', params: { t: '你好' } }), 'utf8');
    const cut = b.indexOf(Buffer.from('你', 'utf8')) + 1;
    const { msgs } = await run([b.subarray(0, cut), b.subarray(cut)]);
    assert.deepEqual(msgs[0]!.result, { params: { t: '你好' } });
  });

  test('a last line without a trailing newline is still served at end of input; blank lines are ignored', async () => {
    const { msgs } = await run(['\n  \n', req({ id: 1, method: 'echo' }).trimEnd()]);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.id, 1);
  });

  test('an array is -32600; a non-object is -32600; both with id null', async () => {
    const { msgs } = await run([`${JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'echo' }])}\n`, '42\n', '"x"\n', 'null\n']);
    assert.equal(msgs.length, 4);
    for (const m of msgs) assert.deepEqual(m, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  });

  test('a wrong jsonrpc, a missing or non-string method, or a bad id is -32600, with the id when it is readable', async () => {
    const { msgs } = await run([
      `${JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'echo' })}\n`,
      `${JSON.stringify({ id: 2, method: 'echo' })}\n`,
      req({ id: 3 }),
      req({ id: 4, method: 5 }),
      req({ id: null, method: 'echo' }),
      req({ id: { a: 1 }, method: 'echo' }),
      `${JSON.stringify({ jsonrpc: '1.0', method: 'echo' })}\n`,
    ]);
    assert.deepEqual(msgs.map((m) => m.id), [1, 2, 3, 4, null, null, null]);
    assert.ok(msgs.every((m) => (m.error as { code: number }).code === -32600));
  });

  test('a line over the limit is -32600 and is skipped; the line after it is served', async () => {
    const big = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { pad: 'x'.repeat(200) } })}\n`;
    const { msgs } = await run([big, req({ id: 2, method: 'echo' })], echo, { maxLineBytes: 100 });
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    assert.equal(msgs[1]!.id, 2);
  });

  test('an over-limit line that arrives in many chunks is reported once and skipped to its newline', async () => {
    const pad = 'y'.repeat(50);
    const { msgs } = await run([`{"jsonrpc":"2.0","id":1,"method":"echo","params":"${pad}`, pad, pad, `${pad}"}\n`, req({ id: 2, method: 'echo' })], echo, { maxLineBytes: 100 });
    assert.equal(msgs.length, 2);
    assert.equal((msgs[0]!.error as { code: number }).code, -32600);
    assert.equal(msgs[1]!.id, 2);
  });

  test('a line of exactly the limit is served; an over-limit tail with no newline is reported once', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo' });
    const exact = Buffer.byteLength(line, 'utf8');
    const { msgs } = await run([`${line}\n`, 'z'.repeat(exact + 5)], echo, { maxLineBytes: exact });
    assert.equal(msgs.length, 2);
    assert.ok('result' in msgs.find((m) => m.id === 1)!);
    assert.equal((msgs.find((m) => m.id === null)!.error as { code: number }).code, -32600);
  });

  test('an unknown method is -32601; an RpcError carries its code with the fixed message for that code', async () => {
    const { msgs } = await run([req({ id: 1, method: 'nope' }), req({ id: 2, method: 'rpc-error' })]);
    assert.deepEqual(msgs[0]!.error, { code: -32601, message: 'Method not found' });
    assert.deepEqual(msgs[1]!.error, { code: -32602, message: 'Invalid params' });
  });

  test('a handler that throws a plain Error is -32603 without its message', async () => {
    const { lines, msgs } = await run([req({ id: 1, method: 'boom' })]);
    assert.deepEqual(msgs[0]!.error, { code: -32603, message: 'Internal error' });
    assert.ok(!lines[0]!.includes('secret-detail'));
  });

  test('a result that cannot be serialised is -32603, not a crash', async () => {
    const { msgs } = await run([req({ id: 1, method: 'echo' }), req({ id: 2, method: 'big' })], async (m) => (m === 'big' ? { n: 1n } : {}));
    assert.deepEqual(msgs.map((m) => m.id).sort(), [1, 2]);
    assert.equal((msgs.find((m) => m.id === 2)!.error as { code: number }).code, -32603);
  });

  test('concurrent calls each get one whole line back, and a fast call is not held up by a slow one', async () => {
    const { lines, msgs } = await run([req({ id: 1, method: 'slow' }), req({ id: 2, method: 'fast' }), req({ id: 3, method: 'slow' }), req({ id: 4, method: 'fast' })]);
    assert.equal(lines.length, 4);
    assert.deepEqual(msgs.map((m) => m.id).slice(0, 2).sort(), [2, 4], 'the fast ones are answered first');
    assert.deepEqual(msgs.map((m) => m.id).sort(), [1, 2, 3, 4]);
  });

  test('serveJsonRpc resolves only after every in-flight call has been answered', async () => {
    const { msgs } = await run([req({ id: 1, method: 'slow' })]);
    assert.equal(msgs.length, 1);
  });

  test('a write that throws does not stop the server', async () => {
    const input = new PassThrough();
    let n = 0;
    const done = serveJsonRpc(input, () => { if (n++ === 0) throw new Error('EPIPE'); }, echo);
    input.write(req({ id: 1, method: 'echo' }));
    input.write(req({ id: 2, method: 'echo' }));
    input.end();
    await done;
    assert.equal(n, 2);
  });
});

// ---- MCP 的方法层（initialize / ping / tools/list 不碰内核，deps 给个摆设）----

import { TOOLS, mcpHandler } from '../../src/mcp/tools.ts';
import { kernelVersion } from '../../src/shared/version.ts';

const deps = { home: {} as never, makeDriver: async () => { throw new Error('no driver here'); }, clock: { now: () => 0, sleep: async () => {} } };
const mcp = (lines: Record<string, unknown>[]): Promise<{ msgs: Record<string, unknown>[] }> => run(lines.map((l) => req(l)), mcpHandler(deps));

describe('the MCP handler over serveJsonRpc', () => {
  test('initialize echoes a supported protocolVersion and falls back to 2025-06-18', async () => {
    const { msgs } = await mcp([
      { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } } },
      { id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { id: 4, method: 'initialize', params: { protocolVersion: '2099-01-01' } },
      { id: 5, method: 'initialize', params: { protocolVersion: 5 } },
      { id: 6, method: 'initialize' },
    ]);
    const byId = (id: number): Record<string, unknown> => msgs.find((m) => m.id === id)!.result as Record<string, unknown>;
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((i) => byId(i).protocolVersion), ['2024-11-05', '2025-03-26', '2025-06-18', '2025-06-18', '2025-06-18', '2025-06-18']);
    assert.deepEqual(byId(1).capabilities, { tools: {} });
    assert.deepEqual(byId(1).serverInfo, { name: 'e2k', version: kernelVersion() });
  });

  test('initialize with params that are not an object is -32602', async () => {
    const { msgs } = await mcp([{ id: 1, method: 'initialize', params: [1] }, { id: 2, method: 'initialize', params: 'x' }]);
    assert.deepEqual(msgs.map((m) => (m.error as { code: number }).code), [-32602, -32602]);
  });

  test('notifications get no response; ping answers {}', async () => {
    const { msgs } = await mcp([{ method: 'notifications/initialized' }, { method: 'notifications/cancelled', params: { requestId: 1 } }, { id: 9, method: 'ping' }]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], { jsonrpc: '2.0', id: 9, result: {} });
  });

  test('a tools/call without an id is dropped: the kernel send is never called and nothing is answered', async () => {
    const sent: string[] = [];
    const handler = mcpHandler({ ...deps, send: async (method: string) => { sent.push(method); return {}; } } as never);
    const { msgs } = await run([req({ method: 'tools/call', params: { name: 'status', arguments: {} } }), req({ id: 2, method: 'ping' })], handler);
    assert.deepEqual(sent, []);
    assert.deepEqual(msgs, [{ jsonrpc: '2.0', id: 2, result: {} }]);
  });

  test('tools/list works before initialize and lists the tools; an unknown method is -32601', async () => {
    const { msgs } = await mcp([{ id: 1, method: 'tools/list' }, { id: 2, method: 'resources/list' }, { id: 3, method: 'notifications/unknown-but-as-request' }]);
    assert.deepEqual((msgs[0]!.result as { tools: { name: string }[] }).tools.map((t) => t.name), TOOLS.map((t) => t.name));
    assert.deepEqual(msgs.slice(1).map((m) => (m.error as { code: number }).code), [-32601, -32601]);
  });
});
