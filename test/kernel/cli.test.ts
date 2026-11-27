import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { main } from '../../src/cli/main.ts';
import { formatClose, formatOpen, formatStatus, formatStep } from '../../src/cli/format.ts';
import type { Io } from '../../src/cli/main.ts';
import { noDialog } from '../../src/kernel/approval.ts';
import { startKernel } from '../../src/kernel/server.ts';
import type { KernelHandle, StatusResult } from '../../src/kernel/server.ts';
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
import { approving, denying, fakeDialog } from '../support/fake-dialog.ts';
import { approveRulesFile } from '../support/approve-rules.ts';

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
  k = await startKernel({ home: kernelTmp.home, driver: fake, dialog: fakeDialog() });
});

after(async () => {
  await k.stop();
  for (const t of [kernelTmp, empty, freshTmp]) t.cleanup();
});

interface TestIo extends Io { outText(): string; errText(): string; fireStopSignal(): void; exits: number[] }

// 收集输出的测试替身。stdinText 不给时，读标准输入得到空串。
function io(o: { env?: NodeJS.ProcessEnv; isTTY?: boolean; stdinText?: string; makeDriver?: () => Promise<Driver>; startKernel?: Io['startKernel'];
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
    startKernel: o.startKernel ?? ((ko) => startKernel({ dialog: fakeDialog(), ...ko })),   // start 命令也不用真的对话框
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

test('open --readonly is passed to the kernel (mode read-only), shown in the text output, and listed in help', async () => {
  const j = io(); assert.equal(await main(['open', 'http://localhost:5173/', '--readonly', '--json'], j), 0);
  const r = JSON.parse(j.outText()) as OpenResult; assert.equal(r.mode, 'readonly');
  const t = io(); assert.equal(await main(['open', 'http://localhost:5173/', '--readonly'], t), 0);
  assert.match(t.outText(), /模式 readonly/);
  assert.equal(await main(['open', 'http://localhost:5173/', '--readonly=1'], io()), 2);
  const h = io(); assert.equal(await main(['help'], h), 0); assert.match(h.outText(), /open <url> .*--readonly/);
  await call(kernelTmp.home, 'close', { session: r.session });
});

test('step text output prints each notice on its own line; a reply without notices (older kernel) prints none', () => {
  const base = { session: 's-aaaaaa', results: [], tallies: { ok: 0, match: 0, mismatch: 0, failed: 0, notRun: 0 }, exit: 0 as const, blocked: null, next: null };
  const out = formatStep({ ...base, writesBlocked: 2, notices: ['本批被拦 2 条写（只读模式），详见报告', '规则文件有错：甲\n乙'] });
  assert.deepEqual(out.split('\n').slice(1), ['提示：本批被拦 2 条写（只读模式），详见报告', '提示：规则文件有错：甲\\n乙']);
  assert.ok(!formatStep(base as never).includes('提示'));
});

test('open on a broken rules file is refused with exit 2 and a pointer to rule list; fixing the file lets it through', async () => {
  await withRules(GOOD_RULES, async (h) => {
    const dialog = fakeDialog(approving);
    const kk = await startKernel({ home: h.home, driver: new FakeDriver({ pages: pages() }), dialog });
    try {
      writeFileSync(h.home.rulesFile, '{"version":1,"rules":null}');
      const t = io({ env: h.env }); assert.equal(await main(['open', 'http://localhost:5173/'], t), 2);
      assert.match(t.errText(), /规则文件有错/); assert.match(t.errText(), /rule list/);
      assert.equal(dialog.requests.length, 0, 'a broken file never reaches the approval dialog');
      writeFileSync(h.home.rulesFile, GOOD_RULES);
      const first = io({ env: h.env }); assert.equal(await main(['open', 'http://localhost:5173/'], first), 21);   // 改过的规则要人批准
      assert.match(first.errText(), /等人在弹框里批准：域名规则的改动/);
      assert.equal(await main(['open', 'http://localhost:5173/'], io({ env: h.env })), 0);   // 人点了批准，原样重试
      assert.equal(dialog.requests.length, 1);
    } finally { await kk.stop(); }
  });
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

test('there is no approve command, and no start option that approves anything', async () => {
  const t = io();
  assert.equal(await main(['approve'], t), 2);
  assert.equal(await main(['approve', 'a-123456'], t), 2);
  for (const opt of ['--approve', '--auto-approve', '--yes', '--dialogs']) assert.equal(await main(['start', opt], io({ env: freshEnv })), 2, opt);
  const help = io(); await main(['help'], help);
  assert.ok(!/approve/i.test(help.outText()));
  assert.match(help.outText(), /start \[--no-dialogs\]/);
  assert.match(help.outText(), /21 等人在弹框里批准（原样重试）/);
});

test('start --no-dialogs hands the kernel noDialog; plain start leaves the default dialog alone', async () => {
  for (const flag of [true, false]) {
    const seen: Parameters<NonNullable<Io['startKernel']>>[0][] = [];
    const t = io({ env: freshEnv, startKernel: async (ko) => { seen.push(ko); return startKernel({ dialog: fakeDialog(), ...ko }); } });
    const done = main(flag ? ['start', '--no-dialogs'] : ['start'], t);
    await until(() => existsSync(fresh.socket)); t.fireStopSignal();
    assert.equal(await done, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.dialog, flag ? noDialog : undefined);
    assert.equal(/--no-dialogs/.test(t.outText()), flag);
    assert.ok(!existsSync(fresh.socket));
  }
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

// 在一个带 rules.json 的独立内核里跑 login：人按回车之前，页面发出 posts 条写（被只读规则拦下几条，收尾就报几条）。
async function loginWithBlockedWrites(posts: number): Promise<string> {
  const h = makeTmpHome();
  const f = new FakeDriver({ pages: pages() });
  writeFileSync(h.home.rulesFile, JSON.stringify({ version: 1, rules: [{ match: 'app.example.com', mode: 'readonly' }], loginHosts: ['sso.example.com'] }));
  const kernel = await startKernel({ home: h.home, driver: f, dialog: fakeDialog(approving) });
  try {
    assert.equal(await main(['login', 'http://app.example.com/login'], io({ env: h.env, isTTY: true })), 21);   // 规则文件是新的：先要人批准，再原样重试
    const t = io({ env: h.env, isTTY: true });
    t.stdin.readLine = async () => {
      const pageId = f.openPages().at(-1)!;
      for (let i = 0; i < posts; i++) {
        const d = await f.emitRequest({ pageId, method: 'POST', url: 'http://app.example.com/api', topUrl: 'http://app.example.com/' });
        assert.equal(d.action, 'fulfill');
      }
      return '';
    };
    assert.equal(await main(['login', 'http://app.example.com/login'], t), 0);
    return t.outText();
  } finally { await kernel.stop(); h.cleanup(); }
}

test('open and login on changed rules: denied is exit 2, a kernel started without dialogs is exit 22, and neither opens a page', async () => {
  for (const [dialog, want] of [[fakeDialog(denying), 2], [noDialog, 22]] as const) {
    await withRules(GOOD_RULES, async (h) => {
      const f = new FakeDriver({ pages: pages() });
      const kk = await startKernel({ home: h.home, driver: f, dialog });
      try {
        assert.equal(await main(['open', 'http://localhost:5173/'], io({ env: h.env })), 21);
        await sleep(5);
        const open = io({ env: h.env }); assert.equal(await main(['open', 'http://localhost:5173/'], open), want);
        const login = io({ env: h.env, isTTY: true }); assert.equal(await main(['login', 'http://localhost:5173/login.html'], login), want);
        assert.equal(f.openPages().length, 0);
        if (want === 2) assert.match(open.errText(), /人拒绝了这次规则改动/);
        else assert.match(open.errText(), /规则改了但弹不出批准框/);
      } finally { await kk.stop(); }
    });
  }
});

test('login prints the loginHosts hint when read-only rules blocked writes during the login, and nothing when none were blocked', async () => {
  const hinted = await loginWithBlockedWrites(2);
  assert.match(hinted, /登录过程中有 2 条写被只读规则拦下：身份提供方（SSO、SAML、OIDC）的主机可能没列进 rules\.json 的 loginHosts/);
  assert.ok(!(await loginWithBlockedWrites(0)).includes('loginHosts'));
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

test('doctor: one profile check per profile (default first), including slots, and a linked directory is not listed', async () => {
  const h = makeTmpHome();
  try {
    for (const n of ['admin', 'admin@t1']) mkdirSync(join(h.home.profilesDir, n), { recursive: true, mode: 0o700 });
    symlinkSync(h.home.root, join(h.home.profilesDir, 'linked'));
    writeFileSync(join(h.home.profilesDir, 'admin@t1' + '.login.json'), JSON.stringify({ schema: 1, at: '2026-11-26T08:09:10.000Z', host: 'app.example.com' }));
    const { checks } = await doctorChecks(h.env);
    assert.deepEqual(checks.filter((c) => c.name.startsWith('profile-')).map((c) => [c.name, c.ok]),
      [['profile-default', true], ['profile-admin', true], ['profile-admin@t1', true]]);
    const slot = checks.find((c) => c.name === 'profile-admin@t1');
    assert.match(slot?.detail ?? '', /^profiles\/admin@t1 没启动过；最近一次 login 2026-11-26T08:09:10.000Z app.example.com$/);
    assert.deepEqual(readdirSync(h.home.profilesDir).sort(), ['admin', 'admin@t1', 'admin@t1' + '.login.json', 'linked']);
  } finally { h.cleanup(); }
});

test('doctor: a profile directory others can enter fails only that profile\'s check', async () => {
  const h = makeTmpHome();
  try {
    mkdirSync(join(h.home.profilesDir, 'admin'), { recursive: true, mode: 0o755 }); chmodSync(join(h.home.profilesDir, 'admin'), 0o755);
    mkdirSync(join(h.home.profilesDir, 'other'), { mode: 0o700 });
    const { code, checks } = await doctorChecks(h.env);
    assert.deepEqual(checks.filter((c) => c.name.startsWith('profile-')).map((c) => [c.name, c.ok]),
      [['profile-default', true], ['profile-admin', false], ['profile-other', true]]);
    assert.equal(code, 22);
    assert.equal(statSync(join(h.home.profilesDir, 'admin')).mode & 0o777, 0o755);
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

const GOOD_RULES = JSON.stringify({ version: 1, rules: [{ match: '*.example.com', mode: 'readonly' }, { match: 'app.example.com', mode: 'default' }], loginHosts: ['sso.example.com'] });

async function withRules(text: string | null, fn: (h: ReturnType<typeof makeTmpHome>) => Promise<void>): Promise<void> {
  const h = makeTmpHome();
  try {
    if (text !== null) writeFileSync(h.home.rulesFile, text);
    await fn(h);
  } finally { h.cleanup(); }
}

test('rule list without a rules file: says every host is default, exit 0, and creates nothing', async () => {
  await withRules(null, async (h) => {
    rmSync(h.home.root, { recursive: true });
    const t = io({ env: h.env }); assert.equal(await main(['rule', 'list'], t), 0);
    assert.equal(t.outText(), '没有 rules.json，所有域名都是默认模式');
    assert.ok(!existsSync(h.home.root));
    const j = io({ env: h.env }); assert.equal(await main(['rule', 'list', '--json'], j), 0);
    assert.deepEqual(JSON.parse(j.outText()), { path: h.home.rulesFile, rules: [], loginHosts: [], groups: [], hash: null, error: null, approved: true, pending: false, approvals: 'absent' });
  });
});

test('rule list shows groups with host lists and counts only, not endpoint paths or the identity probe', async () => {
  const withGroup = JSON.stringify({ version: 1, rules: [], loginHosts: ['sso.example.org'], groups: [{
    name: 'admin', hosts: ['admin.example.com'], loginHosts: ['sso.example.org'],
    readPosts: [{ method: 'POST', url: 'https://admin.example.com/v1/secret-path' }], logout: [{ url: 'https://admin.example.com/logout' }],
    identity: { selector: '#tenant', expect: 'Test Tenant' } }] });
  await withRules(withGroup, async (h) => {
    const t = io({ env: h.env }); assert.equal(await main(['rule', 'list'], t), 0);
    assert.match(t.outText(), /^组 admin {2}hosts admin\.example\.com {2}loginHosts sso\.example\.org {2}readPosts 1 {2}persistedQueries 0 {2}logout 1 {2}identity 有 {2}（未批准）$/m);
    assert.ok(!t.outText().includes('secret-path') && !t.outText().includes('Test Tenant'));
    const j = io({ env: h.env }); assert.equal(await main(['rule', 'list', '--json'], j), 0);
    const r = JSON.parse(j.outText()) as { groups: unknown[] };
    assert.deepEqual(r.groups, [{ name: 'admin', hosts: ['admin.example.com'], loginHosts: ['sso.example.org'], readPosts: 1, persistedQueries: 0, logout: 1, identity: true, approved: false }]);
    assert.ok(!j.outText().includes('secret-path') && !j.outText().includes('Test Tenant'));
    approveRulesFile(h.home);
    const t2 = io({ env: h.env }); assert.equal(await main(['rule', 'list'], t2), 0);
    assert.match(t2.outText(), /identity 有 {2}（已批准）$/m);
    const j2 = io({ env: h.env }); await main(['rule', 'list', '--json'], j2);
    assert.deepEqual((JSON.parse(j2.outText()) as { groups: { approved: boolean }[] }).groups.map((g) => g.approved), [true]);
  });
});

test('rule list prints one line per rule with its approval, the login hosts and the hash; says when there are unapproved changes; does not need the kernel', async () => {
  await withRules(GOOD_RULES, async (h) => {
    const t = io({ env: h.env }); assert.equal(await main(['rule', 'list'], t), 0);
    const out = t.outText();
    assert.match(out, /^\*\.example\.com {2}readonly {2}（未批准）$/m); assert.match(out, /^app\.example\.com {2}default {2}（未批准）$/m);
    assert.match(out, /^loginHosts {2}sso\.example\.com$/m); assert.match(out, /^hash {2}sha256:[0-9a-f]{16}$/m);
    assert.match(out, /^有未批准的改动（rule diff 查看）$/m);
    const j = io({ env: h.env }); assert.equal(await main(['rule', 'list', '--json'], j), 0);
    const r = JSON.parse(j.outText()) as { path: string; rules: unknown[]; loginHosts: string[]; hash: string; error: null; approved: boolean; pending: boolean; approvals: string };
    assert.equal(r.path, h.home.rulesFile);
    assert.deepEqual(r.rules, [{ match: '*.example.com', mode: 'readonly', approved: false }, { match: 'app.example.com', mode: 'default', approved: false }]);
    assert.deepEqual(r.loginHosts, ['sso.example.com']); assert.match(r.hash, /^sha256:[0-9a-f]{16}$/); assert.equal(r.error, null);
    assert.deepEqual([r.approved, r.pending, r.approvals], [false, true, 'absent']);
    assert.ok(out.includes(r.hash));
    approveRulesFile(h.home);
    const t2 = io({ env: h.env }); assert.equal(await main(['rule', 'list'], t2), 0);
    assert.match(t2.outText(), /^\*\.example\.com {2}readonly {2}（已批准）$/m); assert.ok(!t2.outText().includes('未批准') && !t2.outText().includes('rule diff'));
    const j2 = io({ env: h.env }); await main(['rule', 'list', '--json'], j2);
    const r2 = JSON.parse(j2.outText()) as { rules: { approved: boolean }[]; approved: boolean; pending: boolean; approvals: string };
    assert.deepEqual([r2.approved, r2.pending, r2.approvals, r2.rules.map((x) => x.approved)], [true, false, 'ok', [true, true]]);
    writeFileSync(h.home.rulesFile, GOOD_RULES.replace('"readonly"', '"default"'));   // 改一条：已批准的快照里没有它
    const t3 = io({ env: h.env }); await main(['rule', 'list'], t3);
    assert.match(t3.outText(), /^\*\.example\.com {2}default {2}（未批准）$/m); assert.match(t3.outText(), /^app\.example\.com {2}default {2}（已批准）$/m);
    assert.match(t3.outText(), /rule diff/);
  });
});

test('rule list when the approvals file is unreadable: every rule is unapproved and it says so; a deleted rules.json with approved rules is a pending change', async () => {
  await withRules(GOOD_RULES, async (h) => {
    writeFileSync(h.home.approvalsFile, '{broken');
    const t = io({ env: h.env }); assert.equal(await main(['rule', 'list'], t), 0);
    assert.match(t.outText(), /^批准记录读不了：现有规则全部要重新批准$/m); assert.match(t.outText(), /（未批准）/);
    const j = io({ env: h.env }); await main(['rule', 'list', '--json'], j);
    const r = JSON.parse(j.outText()) as { approved: boolean; approvals: string };
    assert.deepEqual([r.approved, r.approvals], [false, 'unreadable']);
  });
  await withRules(null, async (h) => {   // 没有 rules.json、批准记录读不了：顶层 approved 仍是 false
    writeFileSync(h.home.approvalsFile, '{broken');
    const j = io({ env: h.env }); assert.equal(await main(['rule', 'list', '--json'], j), 0);
    const r = JSON.parse(j.outText()) as { approved: boolean; pending: boolean; approvals: string };
    assert.deepEqual([r.approved, r.pending, r.approvals], [false, false, 'unreadable']);
    const t = io({ env: h.env }); await main(['rule', 'list'], t);
    assert.match(t.outText(), /^批准记录读不了：现有规则全部要重新批准$/m);
  });
  await withRules(GOOD_RULES, async (h) => {
    approveRulesFile(h.home);
    rmSync(h.home.rulesFile);
    const t = io({ env: h.env }); assert.equal(await main(['rule', 'list'], t), 0);
    assert.match(t.outText(), /^没有 rules\.json，但批准记录里还有规则/m); assert.match(t.outText(), /^有未批准的改动（rule diff 查看）$/m);
    const j = io({ env: h.env }); await main(['rule', 'list', '--json'], j);
    assert.deepEqual([(JSON.parse(j.outText()) as { approved: boolean }).approved], [false]);
  });
});

test('rule diff prints the pending file hash first, then the whole difference, relaxing lines before tightening ones', async () => {
  const base = { version: 1, rules: [{ match: 'app.example.com', mode: 'default' }] };
  await withRules(JSON.stringify(base), async (h) => {
    approveRulesFile(h.home);
    const none = io({ env: h.env }); assert.equal(await main(['rule', 'diff'], none), 0); assert.equal(none.outText(), '没有未批准的改动');
    const next = { version: 1, rules: [{ match: 'app.example.com', mode: 'readonly' }, { match: 'new.example.com', mode: 'default' }],
      loginHosts: ['sso.example.org'] };
    writeFileSync(h.home.rulesFile, JSON.stringify(next));
    const t = io({ env: h.env }); assert.equal(await main(['rule', 'diff'], t), 0);
    const lines = t.outText().split('\n');
    assert.match(lines[0]!, /^待批文件 sha256:[0-9a-f]{12}$/);
    assert.deepEqual(lines.slice(1), ['+ 顶层登录主机：sso.example.org', '+ 规则 new.example.com（默认）', '~ 规则 app.example.com：默认→只读']);
    const j = io({ env: h.env }); assert.equal(await main(['rule', 'diff', '--json'], j), 0);
    const r = JSON.parse(j.outText()) as { path: string; approvals: string; pending: boolean; hash: string; lines: string[]; error: null };
    assert.deepEqual([r.path, r.approvals, r.pending, r.error], [h.home.rulesFile, 'ok', true, null]);
    assert.ok(`待批文件 ${r.hash.slice(0, 19)}` === lines[0]); assert.equal(r.lines.length, 3);
  });
});

test('rule diff is not truncated at 12 lines; a deleted rules.json, a bad file and unreadable approvals each have their own output', async () => {
  const many = { version: 1, rules: Array.from({ length: 15 }, (_, i) => ({ match: `h${i}.example.com`, mode: 'readonly' })) };
  await withRules(JSON.stringify(many), async (h) => {
    const t = io({ env: h.env }); assert.equal(await main(['rule', 'diff'], t), 0);
    assert.equal(t.outText().split('\n').length, 1 + 15);
    approveRulesFile(h.home);
    rmSync(h.home.rulesFile);
    const d = io({ env: h.env }); assert.equal(await main(['rule', 'diff'], d), 0);
    assert.deepEqual(d.outText().split('\n'), ['待批文件 无（文件被删了）', '规则文件被删了：所有规则失效']);
    writeFileSync(h.home.rulesFile, '{"version":1,"rules":null}');
    const b = io({ env: h.env }); assert.equal(await main(['rule', 'diff'], b), 2);
    assert.match(b.outText(), /规则文件格式有误：rules must be an array/);
    const bj = io({ env: h.env }); assert.equal(await main(['rule', 'diff', '--json'], bj), 2);
    assert.match((JSON.parse(bj.outText()) as { error: string }).error, /rules must be an array/);
    writeFileSync(h.home.rulesFile, JSON.stringify(many)); writeFileSync(h.home.approvalsFile, 'garbage');
    const u = io({ env: h.env }); assert.equal(await main(['rule', 'diff'], u), 0);
    assert.match(u.outText(), /^批准记录读不了：现有规则全部要重新批准$/m); assert.equal(u.outText().split('\n').length, 1 + 1 + 15);
  });
});

test('rule diff reads the files itself and writes nothing: no approvals.json appears, and it takes no extra arguments', async () => {
  await withRules(GOOD_RULES, async (h) => {
    assert.equal(await main(['rule', 'diff'], io({ env: h.env })), 0);
    assert.ok(!existsSync(h.home.approvalsFile));
    assert.equal(await main(['rule', 'diff', 'x'], io({ env: h.env })), 2);
    assert.equal(await main(['rule', 'approve'], io({ env: h.env })), 2);
  });
});

test('rule list on a bad file: prints the parse error and exits 2; --json carries it in error', async () => {
  await withRules('{"version":1,"rules":null}', async (h) => {
    const t = io({ env: h.env }); assert.equal(await main(['rule', 'list'], t), 2);
    assert.match(t.outText(), /规则文件格式有误：rules must be an array/);
    const j = io({ env: h.env }); assert.equal(await main(['rule', 'list', '--json'], j), 2);
    const r = JSON.parse(j.outText()) as { rules: unknown[]; hash: unknown; error: string };
    assert.match(r.error, /rules must be an array/); assert.deepEqual(r.rules, []); assert.equal(r.hash, null);
  });
  await withRules('not json', async (h) => { assert.equal(await main(['rule', 'list'], io({ env: h.env })), 2); });
});

test('rule: needs the list or diff subcommand and takes no extra arguments; help lists them', async () => {
  assert.equal(await main(['rule'], io()), 2);
  assert.equal(await main(['rule', 'add'], io()), 2);
  assert.equal(await main(['rule', 'list', 'x'], io()), 2);
  const h = io(); assert.equal(await main(['help'], h), 0); assert.match(h.outText(), /rule list \[--json\]/); assert.match(h.outText(), /rule diff \[--json\]/);
});

test('a token-shaped key in a bad rules file is redacted in rule list (text and --json) and in doctor', async () => {
  const label = 'Ab1'.repeat(13);   // 39 个字符：未知键名会被 usage 报错带出来，且长得像 token
  await withRules(JSON.stringify({ version: 1, rules: [], [label]: 1 }), async (h) => {
    const t = io({ env: h.env }); assert.equal(await main(['rule', 'list'], t), 2);
    assert.ok(!t.outText().includes(label)); assert.match(t.outText(), /unexpected key/);
    const j = io({ env: h.env }); assert.equal(await main(['rule', 'list', '--json'], j), 2);
    assert.ok(!j.outText().includes(label)); assert.match((JSON.parse(j.outText()) as { error: string }).error, /unexpected key/);
    const d = io({ env: h.env }); await main(['doctor'], d);
    assert.ok(!d.outText().includes(label)); assert.match(d.outText(), /unexpected key/);
    const dj = await doctorChecks(h.env);
    assert.ok(!JSON.stringify(dj.checks).includes(label));
  });
});

test('status text prints one line per profile, slots included; "running" means any instance is up', () => {
  const st = { version: '0.1.0', pid: 1, home: '/x', driver: { name: 'fake', capabilities: { networkInterception: true, crossProcessIframes: 'yes', nativeFormSubmit: 'yes', selectorDialect: 'playwright' } },
    instance: 'running', sessions: [], profiles: [{ name: 'default', state: 'missing', lastLogin: null },
      { name: 'admin@t1', state: 'launched', lastLogin: { at: '2026-11-26T08:09:10.000Z', host: 'app.example.com' } }] } as unknown as StatusResult;
  const out = formatStatus(st);
  assert.match(out, /^浏览器 在运行$/m);
  assert.match(out, /^profile default 目录还不存在，最近一次 login 无$/m);
  assert.match(out, /^profile admin@t1 用过，最近一次 login 2026-11-26T08:09:10\.000Z app\.example\.com$/m);
});

test('status from an older kernel (no rules field) still formats', () => {
  const old = { version: '0.1.0', pid: 1, home: '/x', driver: { name: 'fake', capabilities: { networkInterception: true, crossProcessIframes: 'yes', nativeFormSubmit: 'yes', selectorDialect: 'playwright' } },
    instance: 'stopped', sessions: [], profiles: [] } as unknown as StatusResult;
  assert.doesNotThrow(() => formatStatus(old));
  assert.ok(!formatStatus(old).includes('规则'));
});

test('status carries rules (the approved ones); the text format adds a line for a broken file, for unapproved changes and when approvals.json was changed from outside', async () => {
  await withRules(GOOD_RULES, async (h) => {
    const kk = await startKernel({ home: h.home, driver: new FakeDriver({ pages: pages() }), dialog: fakeDialog(approving) });
    try {
      assert.equal(await main(['open', 'http://localhost:5173/'], io({ env: h.env })), 21);   // 批准走弹框：第一次 open 得 21，人点批准后重试
      const opened = io({ env: h.env }); assert.equal(await main(['open', 'http://localhost:5173/', '--json'], opened), 0);
      assert.equal((await call(h.home, 'close', { session: (JSON.parse(opened.outText()) as { session: string }).session })).ok, true);
      const j = io({ env: h.env }); assert.equal(await main(['status', '--json'], j), 0);
      const r = JSON.parse(j.outText()) as { rules: { count: number; hash: string; error: unknown; pending: unknown; approvals: string; approvalsChanged: boolean } };
      assert.equal(r.rules.count, 2); assert.match(r.rules.hash, /^sha256:[0-9a-f]{16}$/); assert.equal(r.rules.error, null);
      assert.deepEqual([r.rules.pending, r.rules.approvals, r.rules.approvalsChanged], [null, 'ok', false]);
      const t = io({ env: h.env }); await main(['status'], t);
      assert.match(t.outText(), /^规则 2 条 sha256:[0-9a-f]{16}$/m); assert.ok(!t.outText().includes('规则文件有错') && !t.outText().includes('未批准'));
      writeFileSync(h.home.rulesFile, GOOD_RULES.replace('"readonly"', '"default"'));   // status 之前会先重读文件
      const pend = io({ env: h.env }); assert.equal(await main(['status'], pend), 0);
      assert.match(pend.outText(), /^规则文件有未批准的改动：.*rule diff 查看/m); assert.match(pend.outText(), /^规则 2 条 sha256:/m);
      const pj = io({ env: h.env }); await main(['status', '--json'], pj);
      const pr = JSON.parse(pj.outText()) as { rules: { count: number; hash: string; pending: { hash: string; tooLong: boolean } } };
      assert.equal(pr.rules.count, 2); assert.equal(pr.rules.hash, r.rules.hash); assert.match(pr.rules.pending.hash, /^sha256:[0-9a-f]{16}$/); assert.equal(pr.rules.pending.tooLong, false);
      writeFileSync(h.home.rulesFile, '{"version":1,"rules":null}');
      const bad = io({ env: h.env }); assert.equal(await main(['status'], bad), 0);
      assert.match(bad.outText(), /^规则文件有错，open 会被拒绝：规则文件格式有误：rules must be an array$/m);
      const bj = io({ env: h.env }); await main(['status', '--json'], bj);
      const br = JSON.parse(bj.outText()) as { rules: { count: number; hash: string; error: string; pending: unknown } };
      assert.equal(br.rules.count, 2); assert.match(br.rules.error, /rules must be an array/); assert.equal(br.rules.pending, null);   // 仍用批准的那份，坏文件不进待批
      writeFileSync(h.home.rulesFile, GOOD_RULES);
      rmSync(h.home.approvalsFile);                                                  // 运行中被删：内存里的批准不降级，只报提示
      const gone = io({ env: h.env }); await main(['status'], gone);
      assert.match(gone.outText(), /^批准记录文件被外部改过/m); assert.match(gone.outText(), /^规则 2 条 sha256:/m);
      const gj = io({ env: h.env }); await main(['status', '--json'], gj);
      const gr = JSON.parse(gj.outText()) as { rules: { count: number; approvalsChanged: boolean; pending: unknown } };
      assert.deepEqual([gr.rules.count, gr.rules.approvalsChanged, gr.rules.pending], [2, true, null]);
    } finally { await kk.stop(); }
  });
});

test('status without a rules file says there are none', async () => {
  const t = io(); assert.equal(await main(['status'], t), 0);
  assert.match(t.outText(), /^规则 0 条$/m);
});

test('doctor reports the domain rules even when the kernel is not running: none, unapproved changes, approved, unreadable approvals', async () => {
  await withRules(null, async (h) => {
    const { code, checks } = await doctorChecks(h.env);
    const c = checks.find((x) => x.name === 'rules');
    assert.equal(c?.ok, true); assert.match(c?.detail ?? '', /没有规则/); assert.equal(code, 22);   // 22 只来自内核没在跑
  });
  await withRules(GOOD_RULES, async (h) => {
    const c = (await doctorChecks(h.env)).checks.find((x) => x.name === 'rules');
    assert.equal(c?.ok, true); assert.equal(c?.detail, '2 条，有未批准的改动（node bin/e2k.js rule diff 查看）');
    approveRulesFile(h.home);
    const d = (await doctorChecks(h.env)).checks.find((x) => x.name === 'rules');
    assert.equal(d?.ok, true); assert.equal(d?.detail, '2 条，已批准');
    writeFileSync(h.home.rulesFile, GOOD_RULES.replace('"readonly"', '"default"'));
    assert.equal((await doctorChecks(h.env)).checks.find((x) => x.name === 'rules')?.detail, '2 条，有未批准的改动（node bin/e2k.js rule diff 查看）');
    writeFileSync(h.home.approvalsFile, '{broken');
    const { code, checks } = await doctorChecks(h.env);
    const u = checks.find((x) => x.name === 'rules');
    assert.equal(u?.ok, false); assert.equal(u?.detail, '批准记录读不了：现有规则全部要重新批准'); assert.match(u?.fix ?? '', /approvals\.json/); assert.equal(code, 22);
  });
});

test('doctor fails the rules check on a bad file, with a fix that points at rule list', async () => {
  await withRules('{"version":1,"rules":null}', async (h) => {
    const { code, checks } = await doctorChecks(h.env);
    const c = checks.find((x) => x.name === 'rules');
    assert.equal(c?.ok, false); assert.match(c?.detail ?? '', /rules must be an array/);
    assert.equal(c?.fix, '改好 $E2K_HOME/rules.json，或运行 node bin/e2k.js rule list 看错误'); assert.equal(code, 22);
  });
});

test('doctor without a kernel says how to start one', async () => {
  const t = io({ env: emptyEnv });
  assert.equal(await main(['doctor', '--json'], t), 22);
  const checks = JSON.parse(t.outText()) as { name: string; ok: boolean; fix?: string }[];
  const running = checks.find((c) => c.name === 'kernel-running');
  assert.equal(running?.ok, false); assert.equal(running?.fix, 'node bin/e2k.js start');
  assert.equal(checks.find((c) => c.name === 'kernel-version')?.ok, true);
  assert.deepEqual(checks.map((c) => c.name),
    ['node-version', 'platform', 'home-permissions', 'socket-path-length', 'profile-default', 'rules', 'fake', 'kernel-running', 'kernel-version']);
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

// ---- --profile：按域名组选 profile、借用（M2b 任务 6） ----

const PROFILE_RULES = JSON.stringify({ version: 1, rules: [{ match: 'a.example.com', mode: 'readonly' }], loginHosts: [],
  groups: [{ name: 'a', hosts: ['a.example.com'], loginHosts: ['sso.example.org'] }, { name: 'b', hosts: ['b.example.com'] }] });

// 规则先批准好（走解析器的 approvePending，和内核同一条路径），再起一个独立的内核。
async function withGroupKernel(fn: (h: ReturnType<typeof makeTmpHome>, f: FakeDriver) => Promise<void>): Promise<void> {
  const h = makeTmpHome();
  const f = new FakeDriver({ pages: pages() });
  writeFileSync(h.home.rulesFile, PROFILE_RULES);
  approveRulesFile(h.home);
  const kernel = await startKernel({ home: h.home, driver: f, dialog: fakeDialog() });
  try { await fn(h, f); } finally { await kernel.stop(); h.cleanup(); }
}

test('open --profile: the domain\'s own group and slot, borrowing on an unlisted host, and the usage errors never echo what was given', async () => {
  await withGroupKernel(async (h, f) => {
    const run = async (args: string[]) => { const t = io({ env: h.env }); const code = await main(['open', ...args, '--json'], t); return { code, t }; };
    const own = await run(['http://a.example.com/']);
    assert.equal(own.code, 0); assert.deepEqual([JSON.parse(own.t.outText()).profile, JSON.parse(own.t.outText()).borrowed], ['a', false]);
    const slot = await run(['http://a.example.com/', '--profile', 'a/t1']);
    assert.equal(slot.code, 0); assert.equal(JSON.parse(slot.t.outText()).profile, 'a@t1');
    assert.deepEqual(f.launched.map((l) => l.name), ['a', 'a@t1']);
    const borrowed = await run(['http://localhost:5173/', '--profile', 'a']);
    assert.equal(borrowed.code, 0); assert.deepEqual([JSON.parse(borrowed.t.outText()).profile, JSON.parse(borrowed.t.outText()).borrowed], ['a', true]);
    const text = io({ env: h.env });
    assert.equal(await main(['open', 'http://localhost:5173/', '--profile', 'a'], text), 0);
    assert.ok(text.outText().split('\n').includes('借用组 a 的登录：发往 a 的写按那边的模式判；不核对账号'));
    const plain = io({ env: h.env }); assert.equal(await main(['open', 'http://localhost:5173/'], plain), 0);
    assert.ok(!plain.outText().includes('借用'));
    for (const args of [['http://a.example.com/', '--profile', 'b'], ['http://localhost:5173/', '--profile', 'nope'], ['http://localhost:5173/', '--profile', 'a/t1']]) {
      const bad = await run(args); assert.equal(bad.code, 2, args.join(' ')); assert.ok(!bad.t.outText().includes('nope'));
    }
    const shape = io({ env: h.env });
    assert.equal(await main(['open', 'http://localhost:5173/', '--profile', 'Not Valid Zq7x91'], shape), 2);
    assert.ok(!shape.errText().includes('Zq7x91'));
    assert.equal(await main(['open', 'http://localhost:5173/', '--profile'], io({ env: h.env })), 2);   // 缺值
    const help = io(); assert.equal(await main(['help'], help), 0);
    assert.match(help.outText(), /open <url> .*--profile <组>\[\/<槽>\]/); assert.match(help.outText(), /login <url> \[--profile <组>\[\/<槽>\]\]/);
  });
});

test('login --profile: the login window borrows or uses the group, and the record goes to that profile', async () => {
  await withGroupKernel(async (h, f) => {
    const t = io({ env: h.env, isTTY: true });
    assert.equal(await main(['login', 'http://localhost:5173/login.html', '--profile', 'a'], t), 0);
    assert.deepEqual(f.launched.map((l) => l.name), ['a']);
    assert.ok(existsSync(join(h.home.profilesDir, 'a.login.json')) && !existsSync(join(h.home.profilesDir, 'default.login.json')));
    assert.equal(await main(['login', 'http://a.example.com/login', '--profile', 'b'], io({ env: h.env, isTTY: true })), 2);
    assert.equal(await main(['login', 'http://localhost:5173/login.html', '--profile', 'a/t1'], io({ env: h.env, isTTY: true })), 2);
    assert.equal(f.launches, 1);
  });
});

test('formatOpen: the borrowed line is only printed for borrowed:true; an older kernel\'s reply (no borrowed) prints none', () => {
  const base = { session: 's-aaaaaa', name: 'session', url: 'http://localhost/', title: 't', mode: 'default' as const, runDir: '/r', snapshot: '', blocked: null, next: null };
  assert.ok(formatOpen({ ...base, profile: 'a', borrowed: true }).includes('借用组 a 的登录'));
  assert.ok(!formatOpen({ ...base, profile: 'a', borrowed: false }).includes('借用'));
  assert.ok(!formatOpen(base as never).includes('借用'));
  assert.ok(formatOpen({ ...base, profile: 'a@t1', borrowed: true }).includes('借用组 a 的登录'));
});

test('login end: cross-group navigations that were blocked get their own sentence and are not blamed on the read-only rules; read-only blocks keep theirs', async () => {
  await withGroupKernel(async (h, f) => {
    const run = async (profile: string[], act: (pageId: string) => Promise<void>): Promise<string> => {
      const t = io({ env: h.env, isTTY: true });
      t.stdin.readLine = async () => { await act(f.openPages().at(-1)!); return ''; };
      assert.equal(await main(['login', 'http://localhost:5173/login.html', ...profile], t), 0);
      return t.outText();
    };
    const navTo = (pageId: string, url: string) => f.emitRequest({ pageId, method: 'GET', url, topUrl: url, isNavigation: true, topFrame: true });
    const postTo = (pageId: string, url: string) => f.emitRequest({ pageId, method: 'POST', url, topUrl: 'http://localhost:5173/login.html', body: '{}', contentType: 'application/json' });
    // 只有跨组导航被拦：没有「只读规则」那句
    const onlyCross = await run([], async (p) => { assert.equal((await navTo(p, 'http://b.example.com/')).action, 'fulfill'); });
    assert.match(onlyCross, /1 次跳到别的组的导航被拦：这个登录窗口只能用本组的域名和 loginHosts 里的主机/);
    assert.ok(!onlyCross.includes('只读规则拦下'));
    // 两样都有：借用 a 的登录，本地页面写只读的 a 主机（拦），再跳去 b（拦）
    const both = await run(['--profile', 'a'], async (p) => {
      assert.equal((await postTo(p, 'http://a.example.com/api')).action, 'fulfill');
      assert.equal((await navTo(p, 'http://b.example.com/')).action, 'fulfill');
      assert.equal((await navTo(p, 'http://b.example.com/2')).action, 'fulfill');
    });
    assert.match(both, /1 条写被只读规则拦下/); assert.match(both, /2 次跳到别的组的导航被拦/);
    // 什么都没拦：两句都没有
    const none = await run([], async () => {});
    assert.ok(!none.includes('只读规则拦下') && !none.includes('跳到别的组'));
  });
});
