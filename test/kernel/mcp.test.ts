import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { main } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/main.ts';
import { callTool, startMcp, TOOLS } from '../../src/mcp/tools.ts';
import type { ToolDeps } from '../../src/mcp/tools.ts';
import { noFocus } from '../../src/kernel/focus.ts';
import { startKernel } from '../../src/kernel/server.ts';
import type { KernelHandle } from '../../src/kernel/server.ts';
import { E2kError } from '../../src/shared/errors.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';
import { fakeDialog, choosingModeOnly } from '../support/fake-dialog.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

// 一个不能出现在任何输出里的值：运行时拼出来，不写成字面量。
const secret = ['pw', 'Zq7', 'x91', 'Lk'].join('-');

const PAGES: Record<string, FakePageSpec> = {
  'http://localhost:5173/': { snapshot: '- button "Add" [ref=e2]', elements: { e2: {}, '#status': { text: 'Added' }, '#gone': { failWith: 'not-found' } } },
  'http://localhost:5173/wall': { snapshot: '- textbox "Password"', passwordField: true, elements: { '#status': { text: 'Added' } } },
};
const HOME = 'http://localhost:5173/';

const kernelTmp = makeTmpHome();
const empty = makeTmpHome();
const work = mkdtempSync(join(tmpdir(), 'e2k-mcp-'));
let k: KernelHandle;
before(async () => {
  k = await startKernel({ focus: noFocus, home: kernelTmp.home, driver: new FakeDriver({ pages: PAGES }), dialog: fakeDialog(choosingModeOnly('默认')) });
});
after(async () => {
  await k.stop();
  kernelTmp.cleanup();
  empty.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const clock = { now: () => 0, sleep: async () => {} };
const deps = (over: Partial<ToolDeps> = {}): ToolDeps => ({
  home: kernelTmp.home, makeDriver: async () => new FakeDriver({ pages: PAGES }), clock, selfCmd: 'node bin/e2k.js', managerName: async () => 'Aqua', ...over,
});

interface Body { exit: number; result?: unknown; error?: { code: string; message: string; next?: string } }
async function tool(name: string, args: unknown, d: ToolDeps = deps()): Promise<{ isError: boolean; body: Body; text: string }> {
  const r = await callTool(d, name, args);
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0]!.type, 'text');
  return { isError: r.isError, body: JSON.parse(r.content[0]!.text) as Body, text: r.content[0]!.text };
}

// CLI 的 --json 输出：成功是结果本身，出错是 { error }。
function cliIo(env: NodeJS.ProcessEnv = kernelTmp.env, over: Partial<Io> = {}): Io & { outText(): string; errText(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s) => { out.push(s); }, err: (s) => { err.push(s); }, env, selfCmd: 'node bin/e2k.js',
    stdin: { isTTY: true, readLine: async () => '', readAll: async () => '' },
    makeDriver: async () => new FakeDriver({ pages: PAGES }), managerName: async () => 'Aqua',
    clock, onStopSignal: () => {}, exit: () => {},
    outText: () => out.join('\n'), errText: () => err.join('\n'),
    ...over,
  };
}
async function cli(args: string[], env: NodeJS.ProcessEnv = kernelTmp.env): Promise<{ exit: number; json: unknown }> {
  const t = cliIo(env);
  const exit = await main([...args, '--json'], t);
  return { exit, json: JSON.parse(t.outText()) as unknown };
}

// 两边各开一个会话，结果里 会话号、名字、时间戳、目录 不同，换成占位再比。
function norm(x: unknown, ...names: string[]): unknown {
  let s = JSON.stringify(x);
  for (const n of names) s = s.replaceAll(n, 'NAME');
  return JSON.parse(s.replace(/s-[0-9a-f]{6}/g, 'SID').replace(/\d{8}-\d{6}/g, 'TS')) as unknown;
}

describe('tools/list', () => {
  test('has exactly open, step, close, run, save_case, status, doctor, rule_list; no login, approve or rule-changing tool', () => {
    assert.deepEqual(TOOLS.map((t) => t.name), ['open', 'step', 'close', 'run', 'save_case', 'status', 'doctor', 'rule_list']);
    assert.ok(!TOOLS.some((t) => /login|approv|grant|rule_(set|add|edit|write)/.test(t.name)));
    for (const t of TOOLS) {
      const s = t.inputSchema as { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
      assert.equal(s.type, 'object', t.name);
      assert.equal(s.additionalProperties, false, t.name);
      assert.ok(Array.isArray(s.required) && typeof s.properties === 'object', t.name);
      assert.ok(s.required.every((r) => r in s.properties), t.name);
      assert.ok(t.description.length > 0 && t.description.length < 400, t.name);
    }
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema as { properties: Record<string, { type?: string; items?: unknown }>; required: string[] }]));
    assert.deepEqual(byName.step!.properties.ops, { type: 'array', items: { type: 'object' } });
    assert.deepEqual(byName.open!.required, ['url']);
    assert.deepEqual(byName.step!.required, ['session', 'ops']);
    assert.deepEqual(Object.keys(byName.status!.properties), []);
  });
});

describe('tools match the CLI --json', () => {
  test('open, step, close through tools give the same results as the CLI', async () => {
    const c = await cli(['open', HOME, '--name', 'cli-one']);
    const o = await tool('open', { url: HOME, name: 'tool-one' });
    assert.equal(c.exit, 0);
    assert.equal(o.body.exit, 0);
    assert.equal(o.isError, false);
    assert.deepEqual(norm(o.body.result, 'tool-one'), norm(c.json, 'cli-one'));
    const sidC = (c.json as { session: string }).session;
    const sidT = (o.body.result as { session: string }).session;

    const ops = [{ op: 'snapshot' }, { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Added' }, { op: 'click', target: 'e2' }];
    const sc = await cli(['step', sidC, JSON.stringify(ops)]);
    const st = await tool('step', { session: sidT, ops });
    assert.equal(st.body.exit, sc.exit);
    assert.deepEqual(norm(st.body.result), norm(sc.json));

    const cc = await cli(['close', sidC, '--verdict', 'pass', '--because', 'ok']);
    const ct = await tool('close', { session: sidT, verdict: 'pass', because: 'ok' });
    assert.equal(ct.body.exit, cc.exit);
    assert.deepEqual(norm(ct.body.result, 'tool-one'), norm(cc.json, 'cli-one'));
  });

  test('close takes findings, notDone and superseded like the CLI', async () => {
    const sid = ((await tool('open', { url: HOME, name: 'tool-two' })).body.result as { session: string }).session;
    const r = await tool('close', { session: sid, verdict: 'undetermined', because: 'later', findings: [{ claim: 'c', basis: 'b' }], notDone: ['x'] });
    assert.equal(r.body.exit, 0, r.text);
    assert.equal(r.isError, false);
  });

  test('run, save_case, status, doctor and rule_list through tools match the CLI', async () => {
    // status
    const sc = await cli(['status']);
    const st = await tool('status', {});
    assert.equal(st.body.exit, 0);
    const strip = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (key, v) => (key === 'idleSec' ? 0 : v))) as unknown;
    assert.deepEqual(strip(st.body.result), strip(sc.json));
    // doctor
    const dc = await cli(['doctor']);
    const dt = await tool('doctor', {});
    assert.equal(dt.body.exit, dc.exit);
    assert.deepEqual(dt.body.result, dc.json);
    // rule_list
    const rc = await cli(['rule', 'list']);
    const rt = await tool('rule_list', {});
    assert.equal(rt.body.exit, rc.exit);
    assert.deepEqual(rt.body.result, rc.json);
    // save_case + run: 先开一个会话、做点事、close，再导出、再重放
    const sid = ((await tool('open', { url: HOME, name: 'for-case' })).body.result as { session: string }).session;
    await tool('step', { session: sid, ops: [{ op: 'click', target: '#status' }, { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Added' }] });
    await tool('close', { session: sid, verdict: 'pass', because: 'ok' });
    const outT = join(work, 'case-t.json');
    const outC = join(work, 'case-c.json');
    const sct = await tool('save_case', { session: sid, out: outT });
    const scc = await cli(['save-case', sid, '--out', outC]);
    assert.equal(sct.body.exit, 0, sct.text);
    assert.deepEqual({ ...(sct.body.result as object), path: 'P' }, { ...(scc.json as object), path: 'P' });
    const rn = await tool('run', { file: outT, name: 'tool-run' });
    const rnc = await cli(['run', outC, '--name', 'cli-run']);
    assert.equal(rn.body.exit, rnc.exit);
    assert.deepEqual(norm(rn.body.result, 'tool-run'), norm(rnc.json, 'cli-run'));
    assert.equal(((rn.body.result as { verdict: string }).verdict), 'pass');
    const sub = await tool('save_case', { session: sid, out: join(work, 'case-steps.json'), steps: [1] });
    assert.equal(sub.body.exit, 0, sub.text);
  });
});

describe('exit codes through tools', () => {
  test('10 mismatch, 11 failed action and 20 login wall are normal results carrying exit', async () => {
    const sid = ((await tool('open', { url: HOME, name: 'exits-a' })).body.result as { session: string }).session;
    const mismatch = await tool('step', { session: sid, ops: [{ op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Nope' }] });
    assert.deepEqual([mismatch.body.exit, mismatch.isError], [10, false]);
    assert.ok('result' in mismatch.body);
    const failed = await tool('step', { session: sid, ops: [{ op: 'click', target: '#gone' }] });
    assert.deepEqual([failed.body.exit, failed.isError], [11, false]);
    const wall = await tool('open', { url: `${HOME}wall`, name: 'exits-wall' });
    assert.deepEqual([wall.body.exit, wall.isError], [20, false]);
    assert.ok('result' in wall.body);
  });

  test('21 (waiting for a person) is a normal result with an error body and exit 21', async () => {
    const send = async (): Promise<never> => { throw new E2kError('wait-approval', '等人在弹框里批准（请求 a-1b2c3d）'); };
    const r = await tool('open', { url: HOME }, deps({ send }));
    assert.deepEqual([r.body.exit, r.isError, r.body.error?.code], [21, false, 'wait-approval']);
  });

  test('1 (internal error from a throwing send), 2 (usage) and 22 (no kernel) are isError', async () => {
    const boom = async (): Promise<never> => { throw new TypeError(`leaks ${secret}`); };
    const internal = await tool('status', {}, deps({ send: boom }));
    assert.deepEqual([internal.body.exit, internal.isError, internal.body.error?.code], [1, true, 'internal']);
    assert.ok(!internal.text.includes(secret));

    const usage = await tool('open', { url: HOME, name: secret });
    assert.deepEqual([usage.body.exit, usage.isError, usage.body.error?.code], [2, true, 'usage']);
    assert.ok(usage.body.error!.message.length > 0);
    assert.ok(!usage.text.includes(secret), 'a usage error carries the message, never the input value');

    const noKernel = await tool('status', {}, deps({ home: empty.home }));
    assert.deepEqual([noKernel.body.exit, noKernel.isError, noKernel.body.error?.code], [22, true, 'needs-human']);
    assert.match(noKernel.body.error!.next ?? '', /node bin\/e2k\.js start/);
  });

  test('a session that does not exist is exit 2 from the kernel; a failing doctor is exit 22 with its checks', async () => {
    const gone = await tool('step', { session: 's-ffffff', ops: [{ op: 'snapshot' }] });
    assert.deepEqual([gone.body.exit, gone.isError], [2, true]);
    const doc = await tool('doctor', {}, deps({ home: empty.home }));
    assert.deepEqual([doc.body.exit, doc.isError], [22, true]);
    assert.ok(Array.isArray(doc.body.result));
  });

  test('a doctor whose driver cannot be made is an internal error, not a crash', async () => {
    const r = await tool('doctor', {}, deps({ makeDriver: async () => { throw new Error(`no browser ${secret}`); } }));
    assert.deepEqual([r.body.exit, r.isError], [1, true]);
    assert.ok(!r.text.includes(secret));
  });
});

describe('bad tool calls', () => {
  test('an unknown tool name is a usage error result, not a JSON-RPC error, and the name is not echoed', async () => {
    for (const name of [secret, 'login', 'approve', 'rule_set', '']) {
      const r = await tool(name, {});
      assert.deepEqual([r.body.exit, r.isError, r.body.error?.code], [2, true, 'usage'], name);
      assert.ok(!r.text.includes(secret));
    }
  });

  test('extra argument keys are usage errors for every tool, and the key is not echoed', async () => {
    const good: Record<string, unknown> = {
      open: { url: HOME }, step: { session: 's-aaaaaa', ops: [] }, close: { session: 's-aaaaaa' }, run: { file: '/none.json' },
      save_case: { session: 's-aaaaaa', out: '/x.json' }, status: {}, doctor: {}, rule_list: {},
    };
    for (const t of TOOLS) {
      const r = await tool(t.name, { ...(good[t.name] as object), [secret]: 1 });
      assert.deepEqual([r.body.exit, r.isError, r.body.error?.code], [2, true, 'usage'], t.name);
      assert.ok(!r.text.includes(secret), t.name);
    }
  });

  test('missing or wrongly typed arguments are usage errors that never reach the kernel', async () => {
    let sent = 0;
    const send = async (): Promise<never> => { sent++; throw new Error('should not be called'); };
    const d = deps({ send });
    const cases: [string, unknown][] = [
      ['open', {}], ['open', { url: 5 }], ['open', { url: 'ftp://x' }], ['open', { url: HOME, touch: 'yes' }], ['open', { url: HOME, viewport: { width: 1 } }],
      ['step', { session: 's-aaaaaa' }], ['step', { session: 's-aaaaaa', ops: 'x' }], ['step', { session: 's-aaaaaa', ops: [1] }], ['step', { ops: [] }],
      ['close', {}], ['close', { session: 's-aaaaaa', because: 'x' }], ['close', { session: 's-aaaaaa', verdict: 5 }], ['close', { session: 's-aaaaaa', verdict: 'maybe' }],
      ['run', {}], ['run', { file: 5 }], ['run', { file: '' }],
      ['save_case', { session: 's-aaaaaa' }], ['save_case', { out: '/x.json' }], ['save_case', { session: 's-aaaaaa', out: '/x.json', steps: 'a' }],
      ['status', { a: 1 }], ['doctor', { a: 1 }], ['rule_list', { a: 1 }],
      ['status', []], ['open', null], ['open', 'x'],
    ];
    for (const [name, args] of cases) {
      const r = await tool(name, args, d);
      assert.deepEqual([r.body.exit, r.isError, r.body.error?.code], [2, true, 'usage'], `${name} ${JSON.stringify(args)}`);
    }
    assert.equal(sent, 0);
  });

  test('step ops over the same byte limit as the CLI are refused before anything is sent', async () => {
    let sent = 0;
    const big = [{ op: 'eval', expression: 'x'.repeat(1_000_100) }];
    const r = await tool('step', { session: 's-aaaaaa', ops: big }, deps({ send: async () => { sent++; return {}; } }));
    assert.deepEqual([r.body.exit, r.isError, sent], [2, true, 0]);
  });

  test('a run of a missing or malformed case file is refused with usage and the path is not echoed', async () => {
    const bad = join(work, `bad-${secret}.json`);
    writeFileSync(bad, '{"nope":1}');
    for (const file of [join(work, `absent-${secret}.json`), bad]) {
      const r = await tool('run', { file });
      assert.deepEqual([r.body.exit, r.isError], [2, true], file);
      assert.ok(!r.text.includes(secret));
    }
  });
});

// ---- startMcp：整条线 ----

interface McpRig { input: PassThrough; io: Io; done: Promise<number> }
function mcpRig(env: NodeJS.ProcessEnv = kernelTmp.env): McpRig {
  const input = new PassThrough();
  const t = cliIo(env, { input } as Partial<Io>);
  const done = startMcp(t);
  return { input, io: t, done };
}
const rpc = (o: Record<string, unknown>): string => `${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`;

describe('startMcp', () => {
  test('stdout carries only JSON-RPC lines, whatever comes in; diagnostics never go to stdout', async () => {
    const r = mcpRig();
    const t = r.io as Io & { outText(): string; errText(): string };
    r.input.write(rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    r.input.write(rpc({ method: 'notifications/initialized' }));
    r.input.write('garbage {\n');
    r.input.write('[1,2]\n');
    r.input.write(rpc({ id: 2, method: 'tools/list' }));
    r.input.write(rpc({ id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } }));
    r.input.write(rpc({ id: 4, method: 'tools/call', params: { name: 'nope' } }));
    r.input.write(rpc({ id: 5, method: 'tools/call', params: { name: 'open', arguments: { url: HOME, name: 'via-mcp' } } }));
    r.input.write(rpc({ id: 6, method: 'ping' }));
    r.input.end();
    assert.equal(await r.done, 0);
    const lines = t.outText().split('\n');
    assert.equal(lines.length, 8, 'one line per request and per bad line, none for the notification');
    const msgs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const m of msgs) {
      assert.equal(m.jsonrpc, '2.0');
      assert.ok('result' in m || 'error' in m);
    }
    const byId = (id: number): Record<string, unknown> => msgs.find((m) => m.id === id)!;
    const toolResult = (id: number): { isError: boolean; content: { text: string }[] } => byId(id).result as { isError: boolean; content: { text: string }[] };
    assert.equal(JSON.parse(toolResult(3).content[0]!.text).exit, 0);
    assert.equal(toolResult(4).isError, true);
    assert.equal(JSON.parse(toolResult(5).content[0]!.text).exit, 0);
    assert.deepEqual(msgs.filter((m) => m.id === null).map((m) => (m.error as { code: number }).code).sort(), [-32700, -32600].sort());
  });

  test('odd input from a client does not stop the server: bad params, missing params, an over-long line, then a good call', async () => {
    const r = mcpRig();
    const t = r.io as Io & { outText(): string };
    r.input.write(rpc({ id: 1, method: 'tools/call' }));
    r.input.write(rpc({ id: 2, method: 'tools/call', params: [] }));
    r.input.write(rpc({ id: 3, method: 'tools/call', params: { name: 5 } }));
    r.input.write(rpc({ id: 4, method: 'tools/call', params: { arguments: {} } }));
    r.input.write(rpc({ id: 5, method: 'tools/call', params: { name: 'status', arguments: [] } }));
    r.input.write(rpc({ id: 6, method: 'tools/call', params: { name: 'status', arguments: null } }));
    r.input.write(rpc({ id: 7, method: 'tools/call', params: { name: 'status', extra: 1 } }));
    r.input.write(rpc({ id: 8, method: 'tools/call', params: { name: 'status' } }));
    r.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping', params: { pad: 'x'.repeat(2 * 1024 * 1024 + 10) } })}\n`);
    r.input.write(rpc({ id: 10, method: 'tools/call', params: { name: 'status', arguments: {} } }));
    r.input.end();
    assert.equal(await r.done, 0);
    const msgs = t.outText().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const code = (id: number): number | undefined => (msgs.find((m) => m.id === id)?.error as { code: number } | undefined)?.code;
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(code), [-32602, -32602, -32602, -32602, -32602, -32602, -32602]);
    assert.equal(code(8), undefined, 'a missing arguments is {}');
    assert.ok('result' in msgs.find((m) => m.id === 8)!);
    assert.deepEqual(msgs.find((m) => m.id === null)!.error, { code: -32600, message: 'Invalid Request' });
    assert.equal(msgs.find((m) => m.id === 9), undefined);
    assert.ok('result' in msgs.find((m) => m.id === 10)!);
  });

  test('two slow-ish calls at once each come back whole', async () => {
    const r = mcpRig();
    const t = r.io as Io & { outText(): string };
    for (let i = 1; i <= 6; i++) r.input.write(rpc({ id: i, method: 'tools/call', params: { name: i % 2 ? 'doctor' : 'status', arguments: {} } }));
    r.input.end();
    await r.done;
    const lines = t.outText().split('\n');
    assert.equal(lines.length, 6);
    assert.deepEqual(lines.map((l) => (JSON.parse(l) as { id: number }).id).sort(), [1, 2, 3, 4, 5, 6]);
  });
});

describe('e2k mcp', () => {
  test('mcp takes no arguments or options; extra ones are a usage error on stderr and nothing on stdout', async () => {
    for (const args of [['mcp', 'x'], ['mcp', '--json'], ['mcp', '--name', 'a']]) {
      const t = cliIo(kernelTmp.env, { input: new PassThrough() } as Partial<Io>);
      assert.equal(await main(args, t), 2, args.join(' '));
      assert.equal(t.outText(), '');
      assert.match(t.errText(), /./);
    }
  });

  test('mcp serves stdin until it closes and exits 0; help lists it', async () => {
    const input = new PassThrough();
    const t = cliIo(kernelTmp.env, { input } as Partial<Io>);
    const done = main(['mcp'], t);
    input.write(rpc({ id: 1, method: 'ping' }));
    input.end();
    assert.equal(await done, 0);
    assert.deepEqual(JSON.parse(t.outText()), { jsonrpc: '2.0', id: 1, result: {} });
    const h = cliIo();
    await main(['help'], h);
    assert.match(h.outText(), /^\s+mcp\b/m);
  });
});
