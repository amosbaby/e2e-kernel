import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { main } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/main.ts';
import { startKernel } from '../../src/kernel/server.ts';
import type { KernelHandle } from '../../src/kernel/server.ts';
import type { Driver } from '../../src/driver/types.ts';
import { call } from '../../src/shared/client.ts';
import { E2kError } from '../../src/shared/errors.ts';
import type { Home } from '../../src/shared/paths.ts';
import { MAX_OPS_BYTES } from '../../src/shared/protocol.ts';
import type { OpenResult } from '../../src/shared/protocol.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

// 一个不能出现在任何输出里的值：运行时拼出来，不写成字面量。
const secret = ['pw', 'Zq7', 'x91', 'Lk'].join('-');

const HOME_PAGE: FakePageSpec = {
  snapshot: '- button "Add" [ref=e2]',
  elements: { e2: {}, '#status': { text: 'Added' }, '#gone': { failWith: 'not-found' }, '#pw': { password: true } },
};

function pages(): Record<string, FakePageSpec> {
  return {
    'http://localhost:5173/': HOME_PAGE,
    'http://localhost:5173/down': { gotoFailWith: 'timeout' },
    'http://localhost:5173/login-down': { gotoFailWith: 'other' },
  };
}

const kernelTmp = makeTmpHome();                 // 这个文件的内核用的 home
const empty = makeTmpHome();                 // 没有内核在跑的 home
const freshTmp = makeTmpHome();              // 给 start 用的 home
const env = kernelTmp.env;
const emptyEnv = empty.env;
const freshEnv = freshTmp.env;
const fresh: Home = freshTmp.home;
const fake = new FakeDriver({ pages: pages() });
let k: KernelHandle;

before(async () => {
  k = await startKernel({ home: kernelTmp.home, driver: fake });
});

after(async () => {
  await k.stop();
  for (const t of [kernelTmp, empty, freshTmp]) t.cleanup();
});

interface TestIo extends Io { outText(): string; errText(): string; fireStopSignal(): void }

// 收集输出的测试替身。stdinText 不给时，读标准输入得到空串。
function io(o: { env?: NodeJS.ProcessEnv; isTTY?: boolean; stdinText?: string; makeDriver?: () => Promise<Driver>;
  readAll?: (maxBytes: number) => Promise<string> } = {}): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  const stops: (() => void)[] = [];
  const text = o.stdinText ?? '';
  return {
    out: (s) => { out.push(s); },
    err: (s) => { err.push(s); },
    env: o.env ?? env,
    selfCmd: 'node bin/e2k.js',
    stdin: {
      isTTY: o.isTTY ?? true,
      readLine: async () => text.split('\n')[0] ?? '',
      readAll: o.readAll ?? (async (maxBytes) => {
        if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new E2kError('usage', 'standard input is too long');
        return text;
      }),
    },
    makeDriver: o.makeDriver ?? (async () => new FakeDriver({ pages: pages() })),
    onStopSignal: (cb) => { stops.push(cb); },
    outText: () => out.join('\n'),
    errText: () => err.join('\n'),
    fireStopSignal: () => { for (const cb of stops) cb(); },
  };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

test('kernel not running: exit 22 and the exact command a human should run', async () => {
  const t = io({ env: emptyEnv });
  assert.equal(await main(['open', 'http://localhost:5173/'], t), 22);
  assert.match(t.errText(), /node bin\/e2k\.js start/);
});

test('--version and help', async () => {
  const v = io(); assert.equal(await main(['--version'], v), 0); assert.equal(v.outText(), '0.1.0');
  const h = io(); assert.equal(await main(['help'], h), 0); assert.match(h.outText(), /open <url>/);
  assert.ok(!/approve|save-case/.test(h.outText()));
  assert.equal(await main([], io()), 2);
});

test('open prints the session id and snapshot; --json prints one JSON object', async () => {
  const t = io(); assert.equal(await main(['open', 'http://localhost:5173/', '--viewport', '1280x800', '--name', 'orders'], t), 0);
  assert.match(t.outText(), /s-[0-9a-f]{6}/); assert.ok(t.outText().includes('[ref=e2]'));
  const j = io(); await main(['open', 'http://localhost:5173/', '--json'], j);
  assert.equal(JSON.parse(j.outText()).mode, 'default');
});

test('open exits 11 when the first navigation fails', async () => {
  assert.equal(await main(['open', 'http://localhost:5173/down'], io()), 11);
});

test('--json errors are one JSON line with the error', async () => {
  const t = io(); assert.equal(await main(['open', 'http://localhost:5173/down', '--json'], t), 11);
  const lines = t.outText().split('\n');
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0] as string).error.code, 'action-failed');
  const n = io({ env: emptyEnv }); assert.equal(await main(['status', '--json'], n), 22);
  assert.match(JSON.parse(n.outText()).error.next, /node bin\/e2k\.js start/);
});

describe('with a session', () => {
  let sid: string;
  beforeEach(async () => {
    const r = await call(kernelTmp.home, 'open', { url: 'http://localhost:5173/' });
    assert.ok(r.ok); sid = (r.result as OpenResult).session;
  });

  test('step exit codes: 0, 10 on mismatch, 11 on execution failure, 11 wins', async () => {
    assert.equal(await main(['step', sid, '[{"op":"click","target":"e2"}]'], io()), 0);
    const t = io(); assert.equal(await main(['step', sid, '[{"op":"assert","kind":"text","target":"#status","cmp":"eq","expected":"Nope"}]'], t), 10);
    assert.match(t.outText(), /不符 实测=Added 期望=Nope/);
    assert.equal(await main(['step', sid, '[{"op":"assert","kind":"text","target":"#status","cmp":"eq","expected":"Nope"},{"op":"click","target":"#gone"},{"op":"snapshot"}]'], io()), 11);
  });

  test('step text output: tallies line, one line per op, read output indented', async () => {
    const t = io();
    assert.equal(await main(['step', sid, '[{"op":"snapshot"},{"op":"click","target":"#gone"},{"op":"click","target":"e2"}]'], t), 11);
    const lines = t.outText().split('\n');
    assert.equal(lines[0], `${sid} 相符 0 / 不符 0 / 执行失败 1 / 未执行 1`);
    assert.equal(lines[1], '#1 snapshot 完成');
    assert.equal(lines[2], '  - button "Add" [ref=e2]');
    assert.match(lines[3] as string, /^#2 click 执行失败 \S.* shots\/\d\d\.jpg$/);
    assert.equal(lines[4], '#3 click 未执行');
  });

  test('step --stdin reads the ops; oversized or ambiguous input is a usage error', async () => {
    assert.equal(await main(['step', sid, '--stdin'], io({ stdinText: '[{"op":"snapshot"}]' })), 0);
    assert.equal(await main(['step', sid, '--stdin'], io({ stdinText: '[' + ' '.repeat(MAX_OPS_BYTES) + ']' })), 2);
    assert.equal(await main(['step', sid, '[' + ' '.repeat(MAX_OPS_BYTES) + ']'], io()), 2);
    assert.equal(await main(['step', sid, '[{"op":"snapshot"}]', '--stdin'], io({ stdinText: '[]' })), 2);
    assert.equal(await main(['step', sid], io()), 2);
  });

  test('MAX_OPS_BYTES is enforced by the CLI itself and nothing reaches the kernel', async () => {
    const before = fake.calls.length;
    // 不守约定的标准输入：超长也照样交回来。CLI 自己还要再查一遍长度。
    const sloppy = io({ readAll: async () => '[' + ' '.repeat(MAX_OPS_BYTES) + '{"op":"snapshot"}]' });
    assert.equal(await main(['step', sid, '--stdin'], sloppy), 2);
    assert.match(sloppy.errText(), new RegExp(String(MAX_OPS_BYTES)));
    const multiByte = '[{"op":"fill","target":"e2","value":"' + 'é'.repeat(MAX_OPS_BYTES / 2) + '"}]';   // 字符数不超、字节数超
    assert.equal(await main(['step', sid, multiByte], io()), 2);
    assert.equal(fake.calls.length, before);
  });

  test('close passes the verdict; undetermined needs --because', async () => {
    assert.equal(await main(['close', sid, '--verdict', 'undetermined'], io()), 2);
    const t = io(); assert.equal(await main(['close', sid, '--verdict', 'exists', '--because', '复现了', '--not-done', '["没查分页"]'], t), 0);
    assert.match(t.outText(), /report\.html/);
  });

  test('close reports a verdict that conflicts with the record', async () => {
    assert.equal(await main(['step', sid, '[{"op":"assert","kind":"text","target":"#status","cmp":"eq","expected":"Nope"}]'], io()), 10);
    const t = io(); assert.equal(await main(['close', sid, '--verdict', 'pass', '--findings', '[{"claim":"a","basis":"b"}]'], t), 10);
    assert.match(t.outText(), /结论与记录不一致/);
  });

  test('a refused password fill is an execution failure (11) and the value is never printed', async () => {
    const ops = JSON.stringify([{ op: 'fill', target: '#pw', value: secret }]);
    const t = io(); assert.equal(await main(['step', sid, ops], t), 11);
    const j = io(); assert.equal(await main(['step', sid, ops, '--json'], j), 11);
    for (const x of [t, j]) assert.ok(!(x.outText() + x.errText()).includes(secret));
  });

  test('usage errors exit 2', async () => {
    for (const argv of [['nope'], ['open'], ['open', 'ftp://localhost/'], ['open', 'http://localhost/', '--viewport', '10x10'],
      ['step', sid, 'not json'], ['step', 'bad-id', '[]'], ['open', 'http://localhost/', '--allow', 'POST /x']])
      assert.equal(await main(argv, io()), 2, argv.join(' '));
  });

  test('usage errors never echo what was given', async () => {
    const cases: string[][] = [
      ['step', sid, `[{"op":"fill","target":"e2","value":"${secret}"`],                // 不是合法 JSON
      ['step', sid, secret],                                                            // JSON.parse 的消息会带上原文
      ['close', sid, '--not-done', secret],
      ['step', sid, `[{"op":"fill","target":"e2","value":"${secret}","extra":1}]`],
      ['open', `http://user:${secret}@localhost/`],
      ['open', 'http://localhost/', `--${secret}=1`],
      ['open', 'http://localhost/', '--name', secret.toUpperCase()],
      ['status', secret],
      [secret],
      ['close', sid, '--findings', `[{"claim":"${secret}"`],
    ];
    for (const argv of cases) {
      const t = io(); assert.equal(await main(argv, t), 2, argv.join(' '));
      const all = t.outText() + t.errText();
      assert.ok(!all.includes(secret) && !all.includes(secret.toUpperCase()), argv.join(' '));
      assert.ok(t.errText().length > 0);
    }
  });
});

test('this build has no approve, rule, run or save-case command', async () => {
  for (const c of ['approve', 'rule', 'run', 'save-case']) assert.equal(await main([c], io()), 2, c);
});

test('start and login refuse to run without a terminal', async () => {
  let built = 0;
  const s = io({ isTTY: false, env: freshEnv, makeDriver: async () => { built++; throw new Error('no driver without a terminal'); } });
  assert.equal(await main(['start'], s), 22); assert.ok(!existsSync(fresh.socket)); assert.match(s.errText(), /终端/);
  assert.equal(built, 0);
  const before = fake.calls.length;
  assert.equal(await main(['login', 'http://localhost:5173/login.html'], io({ isTTY: false })), 22);
  assert.equal(fake.calls.length, before);
});

test('login waits for Enter, then closes the login page', async () => {
  const before = fake.openPages().length;
  const t = io({ isTTY: true, stdinText: '\n' });
  assert.equal(await main(['login', 'http://localhost:5173/login.html'], t), 0);
  assert.equal(fake.openPages().length, before); assert.match(t.outText(), /按回车/);
});

test('status and doctor', async () => {
  assert.equal(await main(['status'], io()), 0); assert.equal(await main(['doctor'], io()), 0);
  const t = io({ makeDriver: async () => new FakeDriver({ checks: [{ name: 'chromium-installed', ok: false, detail: '缺', fix: 'npx playwright install chromium' }] }) });
  assert.equal(await main(['doctor'], t), 22); assert.ok(t.outText().includes('npx playwright install chromium'));
});

test('doctor without a kernel says how to start one', async () => {
  const t = io({ env: emptyEnv });
  assert.equal(await main(['doctor', '--json'], t), 22);
  const checks = JSON.parse(t.outText()) as { name: string; ok: boolean; fix?: string }[];
  const running = checks.find((c) => c.name === 'kernel-running');
  assert.equal(running?.ok, false); assert.equal(running?.fix, 'node bin/e2k.js start');
  assert.equal(checks.find((c) => c.name === 'kernel-version')?.ok, true);
  assert.deepEqual(checks.map((c) => c.name),
    ['node-version', 'platform', 'home-permissions', 'socket-path-length', 'fake', 'kernel-running', 'kernel-version']);
});

test('start runs until the stop signal and cleans up', async () => {
  const t = io({ env: freshEnv }); const done = main(['start'], t);
  await until(() => existsSync(fresh.socket)); t.fireStopSignal();
  assert.equal(await done, 0); assert.ok(!existsSync(fresh.socket)); assert.ok(!existsSync(fresh.pidFile));
  assert.match(t.outText(), /Ctrl-C/);
});

test('start refuses a second kernel on the same home (exit 2)', async () => {
  const t = io();
  assert.equal(await main(['start'], t), 2);
  assert.match(t.errText(), /内核已在运行/);
});

// 用真正的 realIo() 跑一次 main：标准输入是管道，不是终端。
function runReal(argv: string[], o: { env: NodeJS.ProcessEnv; stdin: string }): Promise<{ code: number | null; out: string; err: string }> {
  const script = `import { main, realIo } from './src/cli/main.ts';\nprocess.exitCode = await main(${JSON.stringify(argv)}, realIo());\n`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (s: string) => { out += s; });
  child.stderr.setEncoding('utf8').on('data', (s: string) => { err += s; });
  child.stdin.on('error', () => { /* 子进程不读完就退出：EPIPE */ });
  child.stdin.end(o.stdin);
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);   // 挂住（比如真把内核起来了）就算失败
  return new Promise((resolve) => { child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); }); });
}

test('realIo: start refuses when standard input is a pipe', async () => {
  const r = await runReal(['start'], { env: freshEnv, stdin: '' });
  assert.equal(r.code, 22); assert.match(r.err, /start 需要人在终端里运行/); assert.ok(!existsSync(fresh.socket));
});

test('realIo: an oversized --stdin is refused before it is parsed', async () => {
  const r = await runReal(['step', 's-000000', '--stdin'], { env: emptyEnv, stdin: '[' + ' '.repeat(MAX_OPS_BYTES) + ']' });
  assert.equal(r.code, 2); assert.match(r.err, new RegExp(`标准输入最多 ${MAX_OPS_BYTES} 字节`));
});
