import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { main } from '../../src/cli/main.ts';
import { formatClose } from '../../src/cli/format.ts';
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
import { hangingDriver } from '../support/hanging-driver.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

// 一个不能出现在任何输出里的值：运行时拼出来，不写成字面量。
const secret = ['pw', 'Zq7', 'x91', 'Lk'].join('-');

const HOME_PAGE: FakePageSpec = {
  snapshot: '- button "Add" [ref=e2]',
  elements: { e2: {}, '#status': { text: 'Added' }, '#gone': { failWith: 'not-found' }, '#pw': { password: true },
    '#amb': { failWith: 'other', hints: ['2 matches', `1) 可写 #amb >> nth=0 · button @(1,2 3x4) "Save${String.fromCharCode(0x1b)}[2K"`] } },
};

// 页面能控制的文字里夹带终端控制序列：ESC[2K ESC[1A（清行并上移）、OSC 52（写剪贴板，以 BEL 结尾）、C1 的单字符 CSI。
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
const REPAINT = `fake${ESC}[2K${ESC}[1A${C1_CSI}31m`;
const OSC52 = `${ESC}]52;c;aGk=${BEL}`;
const HOSTILE_PAGE: FakePageSpec = {
  title: `title${ESC}[2K`,
  snapshot: `- text "snap${ESC}[1A"`,
  elements: { '#status': { text: REPAINT } },
  console: [{ level: 'log', text: `clip${OSC52}` }],
};

function pages(): Record<string, FakePageSpec> {
  return {
    'http://localhost:5173/hostile': HOSTILE_PAGE,
    'http://localhost:5173/': HOME_PAGE,
    'http://localhost:5173/down': { gotoFailWith: 'timeout' },
    'http://localhost:5173/login-down': { gotoFailWith: 'other' },
    'http://localhost:5173/wall': { snapshot: '- textbox "Password"', passwordField: true,
      elements: { '#status': { text: 'Added' }, '#gone': { failWith: 'not-found' } } },
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

interface TestIo extends Io { outText(): string; errText(): string; fireStopSignal(): void; exits: number[] }

// 收集输出的测试替身。stdinText 不给时，读标准输入得到空串。
function io(o: { env?: NodeJS.ProcessEnv; isTTY?: boolean; stdinText?: string; makeDriver?: () => Promise<Driver>;
  readAll?: (maxBytes: number) => Promise<string> } = {}): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  const stops: (() => void)[] = [];
  const exits: number[] = [];
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
    exit: (code) => { exits.push(code); },
    exits,
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

test('kernel not running: exit 22 and the command that starts the kernel', async () => {
  const t = io({ env: emptyEnv });
  assert.equal(await main(['open', 'http://localhost:5173/'], t), 22);
  assert.match(t.errText(), /node bin\/e2k\.js start/);
});

test('--version and help', async () => {
  const v = io(); assert.equal(await main(['--version'], v), 0); assert.equal(v.outText(), '0.1.0');
  const h = io(); assert.equal(await main(['help'], h), 0); assert.match(h.outText(), /open <url>/); assert.match(h.outText(), /step .*--keep-going/);
  assert.ok(!/approve|save-case/.test(h.outText()));
  assert.match(h.outText(), /退出码：.*10 .*11 .*20 .*22/);   // 退出码一行要列到 20 和 22
  assert.equal(await main([], io()), 2);
});

test('open prints the session id and snapshot; --json prints one JSON object', async () => {
  const t = io(); assert.equal(await main(['open', 'http://localhost:5173/', '--viewport', '1280x800', '--name', 'orders'], t), 0);
  assert.match(t.outText(), /s-[0-9a-f]{6}/); assert.ok(t.outText().includes('[ref=e2]'));
  const j = io(); await main(['open', 'http://localhost:5173/', '--json'], j);
  assert.equal(JSON.parse(j.outText()).mode, 'default');
});

test('open --touch goes through, and the help text lists it', async () => {
  const t = io(); assert.equal(await main(['open', 'http://localhost:5173/', '--touch', '--json'], t), 0);
  assert.equal(JSON.parse(t.outText()).mode, 'default');
  const h = io(); assert.equal(await main(['help'], h), 0); assert.match(h.outText(), /open <url> .*--touch/);
});

test('open exits 20 on a login wall and prints the full hint; a normal page exits 0', async () => {
  const t = io(); assert.equal(await main(['open', 'http://localhost:5173/wall'], t), 20);
  assert.match(t.outText(), /^等登录：页面停在登录页（有可见的密码框）：请人运行 login http:\/\/localhost:5173\/wall 登录后重试；若这是预期页面（如修改密码页）可忽略。会话仍开着，用完请 close$/m);
  const j = io(); assert.equal(await main(['open', 'http://localhost:5173/wall', '--json'], j), 20);
  assert.equal(JSON.parse(j.outText()).blocked, 'login');
  assert.equal(await main(['open', 'http://localhost:5173/'], io()), 0);
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

  test('step exit 20 on a login wall beats 11 and 10, and the output says what to do', async () => {
    const wall = await call(kernelTmp.home, 'open', { url: 'http://localhost:5173/wall' });
    assert.ok(wall.ok); const wsid = (wall.result as OpenResult).session;
    const t = io(); assert.equal(await main(['step', wsid, '[{"op":"snapshot"}]'], t), 20);
    assert.match(t.outText(), /等登录：页面停在登录页（有可见的密码框）：请人运行 login http:\/\/localhost:5173\/wall 登录后重试；若这是预期页面（如修改密码页）可忽略。会话仍开着，用完请 close/);
    const mismatch = io();
    assert.equal(await main(['step', wsid, '[{"op":"assert","kind":"text","target":"#status","cmp":"eq","expected":"Nope"}]'], mismatch), 20);
    assert.match(mismatch.outText(), /不符 1/);
    const mixed = io();
    assert.equal(await main(['step', wsid, '[{"op":"assert","kind":"text","target":"#status","cmp":"eq","expected":"Nope"},{"op":"click","target":"#gone"},{"op":"snapshot"}]'], mixed), 20);
    assert.match(mixed.outText(), /执行失败 1/);
  });

  test('step text output: tallies line, one line per op, read output indented', async () => {
    const t = io();
    assert.equal(await main(['step', sid, '[{"op":"snapshot"},{"op":"click","target":"#gone"},{"op":"click","target":"e2"}]'], t), 11);
    const lines = t.outText().split('\n');
    assert.equal(lines[0], `${sid} 相符 0 / 不符 0 / 执行失败 1 / 未执行 1`);
    assert.match(lines[1] as string, /^#1 序号\d+ snapshot 完成$/);
    assert.equal(lines[2], '  - button "Add" [ref=e2]');
    assert.match(lines[3] as string, /^#2 序号\d+ click 执行失败 \S.* shots\/\d\d\.jpg$/);
    assert.match(lines[4] as string, /^#3 序号\d+ click 未执行$/);
    const seqs = lines.map((l) => /^#\d 序号(\d+) /.exec(l)?.[1]).filter((x) => x !== undefined).map(Number);
    assert.deepEqual(seqs, [seqs[0], seqs[0]! + 1, seqs[0]! + 2]);
  });

  test('step --keep-going is passed to the kernel: later ops still run after a failure; without it they do not', async () => {
    const ops = '[{"op":"click","target":"#gone"},{"op":"snapshot"},{"op":"click","target":"e2"}]';
    const t = io(); assert.equal(await main(['step', sid, ops, '--keep-going'], t), 11);
    assert.match(t.outText().split('\n')[0] as string, /执行失败 1 \/ 未执行 0$/);
    assert.ok(!t.outText().includes('未执行 click'));
    const j = io(); assert.equal(await main(['step', sid, ops, '--keep-going', '--json'], j), 11);
    assert.deepEqual((JSON.parse(j.outText()).results as { outcome: string }[]).map((r) => r.outcome), ['failed', 'ok', 'ok']);
    const d = io(); assert.equal(await main(['step', sid, ops, '--json'], d), 11);
    assert.deepEqual((JSON.parse(d.outText()).results as { outcome: string }[]).map((r) => r.outcome), ['failed', 'not-run', 'not-run']);
    assert.equal(await main(['step', sid, '--stdin', '--keep-going'], io({ stdinText: ops })), 11);
    assert.equal(await main(['step', sid, ops, '--keep-going=1'], io()), 2);
  });

  test('step text output: hints of a failed op follow it, indented, one per line', async () => {
    const t = io();
    assert.equal(await main(['step', sid, '[{"op":"click","target":"#amb"},{"op":"click","target":"e2"}]'], t), 11);
    const lines = t.outText().split('\n');
    assert.match(lines[1] as string, /^#1 序号\d+ click 执行失败 /);
    assert.equal(lines[2], '  2 matches'); assert.equal(lines[3], '  1) 可写 #amb >> nth=0 · button @(1,2 3x4) "Save\\x1b[2K"');
    assert.match(lines[4] as string, /^#2 序号\d+ click 未执行$/);
    assert.ok(!t.outText().includes(ESC), 'a control character in a hint is shown, not sent to the terminal');
  });

  test('a step on a session that is busy exits 2 (busy)', async () => {
    const first = main(['step', sid, '[{"op":"wait","for":{"ms":300}}]'], io());
    await sleep(50);
    const t = io();
    assert.equal(await main(['step', sid, '[{"op":"snapshot"}]'], t), 2);
    assert.match(t.errText(), /错误（busy）/);
    assert.equal(await first, 0);
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
    const t = io(); assert.equal(await main(['close', sid, '--verdict', 'pass', '--findings', '[{"claim":"a","basis":"b"}]', '--not-done', '["x"]'], t), 10);
    assert.match(t.outText(), /结论与记录不一致\n原因：有不符的断言；agent 自己列了没做的事$/);
  });

  test('close --json carries the conflict reasons', async () => {
    assert.equal(await main(['step', sid, '[{"op":"assert","kind":"text","target":"#status","cmp":"eq","expected":"Nope"}]'], io()), 10);
    const j = io(); assert.equal(await main(['close', sid, '--verdict', 'pass', '--json'], j), 10);
    assert.deepEqual(JSON.parse(j.outText()).conflicts, ['mismatch']);
  });

  test('close with no conflict prints no reason line', async () => {
    const t = io(); assert.equal(await main(['close', sid, '--verdict', 'pass'], t), 0);
    assert.ok(!t.outText().includes('原因'));
  });

  test('close --superseded is passed through: recovered failures do not make a pass conflict', async () => {
    assert.equal(await main(['step', sid, '[{"op":"click","target":"#gone"},{"op":"click","target":"e2"}]', '--keep-going'], io()), 11);
    const t = io(); const out = await main(['close', sid, '--verdict', 'pass', '--superseded', '[{"failed":1,"by":2}]'], t);
    assert.equal(out, 0, t.errText()); assert.ok(!/结论与记录不一致/.test(t.outText()));
  });

  test('close --superseded with a pair the record does not support is a usage error and the session stays open', async () => {
    assert.equal(await main(['step', sid, '[{"op":"click","target":"e2"}]'], io()), 0);
    const t = io(); assert.equal(await main(['close', sid, '--superseded', '[{"failed":1,"by":2}]'], t), 2);
    assert.ok(t.errText().length > 0);
    const again = io(); assert.equal(await main(['close', sid, '--verdict', 'pass'], again), 0);
  });

  test('a finding with verdict fail under a pass verdict is reported as a conflict', async () => {
    const t = io();
    assert.equal(await main(['close', sid, '--verdict', 'pass', '--findings', '[{"claim":"a","basis":"b","verdict":"fail"}]'], t), 0);
    assert.match(t.outText(), /结论与记录不一致\n原因：有一条结论的判定是不通过$/);
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
      ['close', sid, '--superseded', `[{"failed":"${secret}"`],                       // 不是合法 JSON
      ['close', sid, '--superseded', secret],
      ['close', sid, '--superseded', `[{"failed":1,"by":"${secret}","extra":3}]`],            // 多余的键
      ['close', sid, '--superseded', `{"failed":1,"by":"${secret}"}`],                  // 不是数组
      ['close', sid, '--findings', `[{"claim":"a","basis":"b","verdict":"${secret}"}]`],
    ];
    for (const argv of cases) {
      const t = io(); assert.equal(await main(argv, t), 2, argv.join(' '));
      const all = t.outText() + t.errText();
      assert.ok(!all.includes(secret) && !all.includes(secret.toUpperCase()), argv.join(' '));
      assert.ok(t.errText().length > 0);
    }
  });
});

test('formatClose prints a fixed text for a reason it does not know, never the raw value', () => {
  const base = { session: 's-a41f00', runDir: '/r', reportPath: '/r/report.html', resultPath: '/r/result.json',
    tallies: { ok: 0, match: 0, mismatch: 1, failed: 0, notRun: 0 }, consistency: 'conflict' as const, exit: 10 as const };
  const odd = [secret, 'constructor', 'toString', 7] as unknown as NonNullable<Parameters<typeof formatClose>[0]['conflicts']>;
  const out = formatClose({ ...base, conflicts: odd });
  assert.ok(out.endsWith('原因：未知原因；未知原因；未知原因；未知原因'), out);
  assert.ok(!out.includes(secret));
  assert.ok(!formatClose({ ...base, conflicts: [] }).includes('原因'));
  assert.ok(!formatClose({ ...base }).includes('原因'));
});

test('this build has no approve, rule, run or save-case command', async () => {
  for (const c of ['approve', 'rule', 'run', 'save-case']) assert.equal(await main([c], io()), 2, c);
});

test('start without a terminal runs until the stop signal', async () => {
  const t = io({ isTTY: false, env: freshEnv }); const done = main(['start'], t);
  await until(() => existsSync(fresh.socket)); t.fireStopSignal();
  assert.equal(await done, 0); assert.ok(!existsSync(fresh.socket)); assert.ok(!existsSync(fresh.pidFile));
});

test('login without a terminal is refused (22)', async () => {
  const before = fake.calls.length;
  const t = io({ isTTY: false });
  assert.equal(await main(['login', 'http://localhost:5173/login.html'], t), 22);
  assert.match(t.errText(), /终端/);
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

type DocCheck = { name: string; ok: boolean; detail: string; fix?: string };
async function doctorChecks(e: NodeJS.ProcessEnv): Promise<{ code: number; checks: DocCheck[] }> {
  const t = io({ env: e }); const code = await main(['doctor', '--json'], t);
  return { code, checks: JSON.parse(t.outText()) as DocCheck[] };
}

test('doctor on a fresh home: profile-default is ok, creates nothing, and does not add its own exit 22', async () => {
  const h = makeTmpHome();
  try {
    rmSync(h.home.root, { recursive: true });
    const { checks } = await doctorChecks(h.env);
    const p = checks.find((c) => c.name === 'profile-default');
    assert.equal(p?.ok, true); assert.match(p?.detail ?? '', /从没用 login 登录过/);
    assert.ok(!existsSync(h.home.root));                              // doctor 不建任何东西
  } finally { h.cleanup(); }
});

test('doctor: a profile that only holds browser files still says nobody logged in with login; a record shows time and host', async () => {
  const h = makeTmpHome();
  try {
    mkdirSync(join(h.home.profilesDir, 'default'), { recursive: true, mode: 0o700 });
    writeFileSync(join(h.home.profilesDir, 'default', 'Local State'), '{}');
    let p = (await doctorChecks(h.env)).checks.find((c) => c.name === 'profile-default');
    assert.equal(p?.ok, true); assert.match(p?.detail ?? '', /用过；从没用 login 登录过（会话窗口里手动登录不会记在这里）/);
    writeFileSync(join(h.home.profilesDir, 'default.login.json'), JSON.stringify({ schema: 1, at: '2026-11-26T08:09:10.000Z', host: 'app.example.com' }));
    p = (await doctorChecks(h.env)).checks.find((c) => c.name === 'profile-default');
    assert.equal(p?.ok, true); assert.ok((p?.detail ?? '').includes('2026-11-26T08:09:10.000Z app.example.com'), p?.detail);
    assert.deepEqual(readdirSync(h.home.profilesDir).sort(), ['default', 'default.login.json']);
  } finally { h.cleanup(); }
});

test('doctor: the host from the login record is redacted before it is printed', async () => {
  const h = makeTmpHome();
  try {
    mkdirSync(h.home.profilesDir, { recursive: true, mode: 0o700 });
    const label = 'Ab1'.repeat(14);
    writeFileSync(join(h.home.profilesDir, 'default.login.json'), JSON.stringify({ schema: 1, at: '2026-11-26T08:09:10.000Z', host: `${label}.example.com` }));
    const t = io({ env: h.env }); await main(['doctor'], t);
    assert.ok(!t.outText().includes(label)); assert.match(t.outText(), /\[REDACTED\]\.example\.com/);
  } finally { h.cleanup(); }
});

test('doctor: a profiles directory others can enter fails the profile check (the same state-directory rule as home), and nothing is changed', async () => {
  const h = makeTmpHome();
  try {
    mkdirSync(h.home.profilesDir, { mode: 0o755 }); chmodSync(h.home.profilesDir, 0o755);
    const { code, checks } = await doctorChecks(h.env);
    const p = checks.find((c) => c.name === 'profile-default');
    assert.equal(p?.ok, false); assert.equal(code, 22);
    assert.equal(statSync(h.home.profilesDir).mode & 0o777, 0o755);
  } finally { h.cleanup(); }
});

test('status prints a profile line; --json carries profiles[0].state and lastLogin', async () => {
  const j = io(); assert.equal(await main(['status', '--json'], j), 0);
  const r = JSON.parse(j.outText()) as { profiles: { name: string; state: string; lastLogin: unknown }[] };
  assert.equal(r.profiles[0]?.name, 'default'); assert.ok(['missing', 'never-launched', 'launched'].includes(r.profiles[0]?.state ?? ''));
  const t = io(); assert.equal(await main(['status'], t), 0);
  assert.match(t.outText(), /^profile default (?:目录还不存在|没启动过|用过)，最近一次 login (?:无|\S+ \S+)$/m);
});

test('doctor without a kernel says how to start one', async () => {
  const t = io({ env: emptyEnv });
  assert.equal(await main(['doctor', '--json'], t), 22);
  const checks = JSON.parse(t.outText()) as { name: string; ok: boolean; fix?: string }[];
  const running = checks.find((c) => c.name === 'kernel-running');
  assert.equal(running?.ok, false); assert.equal(running?.fix, 'node bin/e2k.js start');
  assert.equal(checks.find((c) => c.name === 'kernel-version')?.ok, true);
  assert.deepEqual(checks.map((c) => c.name),
    ['node-version', 'platform', 'home-permissions', 'socket-path-length', 'profile-default', 'fake', 'kernel-running', 'kernel-version']);
});

test('start runs until the stop signal and cleans up', async () => {
  const t = io({ env: freshEnv }); const done = main(['start'], t);
  await until(() => existsSync(fresh.socket)); t.fireStopSignal();
  assert.equal(await done, 0); assert.ok(!existsSync(fresh.socket)); assert.ok(!existsSync(fresh.pidFile));
  assert.match(t.outText(), /Ctrl-C/);
});

test('a second stop signal while stopping exits at once with 1 instead of waiting for the deadline', async () => {
  const h = hangingDriver(pages(), { hangStop: true });
  const t = io({ env: freshEnv, makeDriver: async () => h.driver });
  const done = main(['start'], t);
  await until(() => existsSync(fresh.socket));
  void call(fresh, 'open', { url: 'http://localhost:5173/' }).catch(() => undefined);
  await until(() => h.opened());
  t.fireStopSignal();
  await until(() => t.outText().includes('正在停止内核'));
  assert.deepEqual(t.exits, []);                                 // 第一次信号：只是开始收尾
  const t0 = Date.now();
  t.fireStopSignal();
  assert.equal(await done, 1);
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(t.exits, [1]);
  assert.ok(h.stops() >= 1);
  assert.ok(!existsSync(fresh.socket)); assert.ok(!existsSync(fresh.pidFile));
  assert.ok(!t.outText().includes('内核已停止'));
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

// 起一个真实内核子进程，读到「内核已启动」后销毁父端的 stdout 读流（之后子进程再写就是 EPIPE），再发信号。
async function stopRealKernelAfterStdoutClosed(signal: NodeJS.Signals): Promise<{ code: number | null; err: string }> {
  const script = `import { main, realIo } from './src/cli/main.ts';\nprocess.exitCode = await main(['start'], realIo());\n`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: freshEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);   // 挂住就算失败
  let err = '';
  child.stderr.setEncoding('utf8').on('data', (s: string) => { err += s; });
  const closed = new Promise<number | null>((resolve) => { child.on('close', (code) => { clearTimeout(timer); resolve(code); }); });
  child.stdin.on('error', () => { /* 子进程先退出：EPIPE */ });
  child.stdin.end('');
  let seen = '';
  const started = new Promise<void>((resolve) => {
    child.stdout.setEncoding('utf8').on('data', (s: string) => { seen += s; if (seen.includes('内核已启动')) resolve(); });
  });
  try {
    await until(() => existsSync(fresh.socket));
    await started;
  } catch (e) { child.kill('SIGKILL'); throw e; }
  child.stdout.destroy();
  child.kill(signal);
  return { code: await closed, err };
}

test('realIo: start with piped stdin runs until SIGTERM', async () => {
  const script = `import { main, realIo } from './src/cli/main.ts';\nprocess.exitCode = await main(['start'], realIo());\n`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: freshEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);   // 挂住就算失败
  const closed = new Promise<number | null>((resolve) => { child.on('close', (code) => { clearTimeout(timer); resolve(code); }); });
  child.stdin.on('error', () => { /* 子进程先退出：EPIPE */ });
  child.stdin.end('');
  try {
    await until(() => existsSync(fresh.socket));
  } catch (e) { child.kill('SIGKILL'); throw e; }
  child.kill('SIGTERM');
  assert.equal(await closed, 0); assert.ok(!existsSync(fresh.socket)); assert.ok(!existsSync(fresh.pidFile));
});

test('realIo: SIGTERM after the stdout reader is gone still stops cleanly (no EPIPE crash)', async () => {
  const r = await stopRealKernelAfterStdoutClosed('SIGTERM');
  assert.equal(r.code, 0); assert.doesNotMatch(r.err, /EPIPE|Unhandled/);
  assert.ok(!existsSync(fresh.socket)); assert.ok(!existsSync(fresh.pidFile));
});

test('realIo: SIGHUP takes the same clean-up path', async () => {
  const r = await stopRealKernelAfterStdoutClosed('SIGHUP');
  assert.equal(r.code, 0); assert.doesNotMatch(r.err, /EPIPE|Unhandled/);
  assert.ok(!existsSync(fresh.socket)); assert.ok(!existsSync(fresh.pidFile));
});

test('realIo: an oversized --stdin is refused before it is parsed', async () => {
  const r = await runReal(['step', 's-000000', '--stdin'], { env: emptyEnv, stdin: '[' + ' '.repeat(MAX_OPS_BYTES) + ']' });
  assert.equal(r.code, 2); assert.match(r.err, new RegExp(`标准输入最多 ${MAX_OPS_BYTES} 字节`));
});

describe('terminal control characters from the page never reach the terminal', () => {
  const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

  test('a CSI sequence in a mismatch actual and an OSC 52 sequence in console text are escaped', async () => {
    const r = await call(kernelTmp.home, 'open', { url: 'http://localhost:5173/hostile', name: 'hostile' });
    assert.ok(r.ok); const hostileSid = (r.result as OpenResult).session;
    const t = io();
    const ops = '[{"op":"assert","kind":"text","target":"#status","cmp":"eq","expected":"Nope"},{"op":"console"}]';
    assert.equal(await main(['step', hostileSid, ops], t), 10);
    const text = t.outText();
    assert.ok(!text.includes(ESC), 'no raw ESC byte in the output');
    assert.ok(!RAW_CONTROL.test(text), 'no raw control character other than the line break');
    assert.ok(text.includes('实测=fake\\x1b[2K\\x1b[1A\\x9b31m'));
    assert.ok(text.includes('clip\\x1b]52;c;aGk=\\x07'));
    assert.equal(text.split('\n').length, 4);           // 汇总、不符、console 标题、console 内容：页面没能多出一行
    await call(kernelTmp.home, 'close', { session: hostileSid });
  });

  test('open escapes the title and the snapshot', async () => {
    const t = io();
    assert.equal(await main(['open', 'http://localhost:5173/hostile', '--name', 'hostile2'], t), 0);
    const text = t.outText();
    assert.ok(!text.includes(ESC) && !RAW_CONTROL.test(text));
    assert.ok(text.includes('标题 title\\x1b[2K'));
    assert.ok(text.includes('- text "snap\\x1b[1A"'));
  });
});
