import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Approvals, checkDialogText, noDialog, osascriptDialog, pendingError } from '../../src/kernel/approval.ts';
import type { DialogRequest, DialogResult, ExecFn } from '../../src/kernel/approval.ts';
import type { E2kError } from '../../src/shared/errors.ts';
import { exitCodeFor, parseRequest } from '../../src/shared/protocol.ts';
import { fakeDialog } from '../support/fake-dialog.ts';

const isUsage = (e: E2kError): boolean => e.code === 'usage';
const sleepTick = (): Promise<void> => new Promise((r) => { setImmediate(r); });

function req(over: Partial<DialogRequest> = {}): DialogRequest {
  return { title: '一个标题', lines: ['第一行', '第二行'], buttons: ['不允许', '允许'], defaultButton: '不允许', timeoutSec: 30, ...over };
}

// ---- osascriptDialog ----

interface Call { file: string; args: string[]; timeout: number }

function dialogWith(reply: (c: Call) => string | Error, managerName: string | null = 'Aqua') {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args, o) => {
    const c = { file, args, timeout: o.timeout };
    calls.push(c);
    const r = reply(c);
    if (r instanceof Error) throw r;
    return { stdout: r };
  };
  let asked = 0;
  const dialog = osascriptDialog({ exec, managerName: async () => { asked++; return managerName; } });
  return { dialog, calls, asked: () => asked };
}

test('osascriptDialog: a click comes back as that button; stdout ends with one newline', async () => {
  const d = dialogWith(() => 'button returned:允许, gave up:false\n');
  assert.deepEqual(await d.dialog.show(req()), { kind: 'button', button: '允许' });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0]!.file, 'osascript');
});

test('osascriptDialog: giving up is a timeout', async () => {
  const d = dialogWith(() => 'button returned:, gave up:true\n');
  assert.deepEqual(await d.dialog.show(req()), { kind: 'timeout' });
});

test('osascriptDialog: a button name with a comma is read whole, and only if it is one of the buttons', async () => {
  const d = dialogWith(() => 'button returned:好的, 允许, gave up:false\n');
  assert.deepEqual(await d.dialog.show(req({ buttons: ['不允许', '好的, 允许'], defaultButton: '不允许' })), { kind: 'button', button: '好的, 允许' });
  const e = dialogWith(() => 'button returned:允许,允许, gave up:false\n');
  assert.equal((await e.dialog.show(req())).kind, 'unavailable');
});

test('osascriptDialog: anything but the exact shape is unavailable', async () => {
  const bad: (string | Error)[] = [
    'button returned:允许, gave up:false\nextra\n',
    'button returned:允许, gave up:false\n\n',
    'button returned:允许, gave up:false\r\n',
    ' button returned:允许, gave up:false\n',
    'button returned:允许, gave up:maybe\n',
    'button returned:别的, gave up:false\n',
    'button returned:, gave up:false\n',
    '',
    'extra\nbutton returned:允许, gave up:false\n',
    Object.assign(new Error('Command failed'), { code: 1 }),
    Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL' }),
  ];
  for (const reply of bad) {
    const d = dialogWith(() => reply);
    assert.equal((await d.dialog.show(req())).kind, 'unavailable', String(reply instanceof Error ? reply.message : JSON.stringify(reply)));
  }
});

test('osascriptDialog: the same text without a trailing newline is accepted (only one newline is stripped, none is required)', async () => {
  const d = dialogWith(() => 'button returned:允许, gave up:false');
  assert.deepEqual(await d.dialog.show(req()), { kind: 'button', button: '允许' });
});

test('osascriptDialog: the dialog text goes through argv, never into the script lines', async () => {
  const body = ['正文 "引号" \\ 反斜杠', '`反引号` $(x)'];
  const r = req({ title: '标题 with "quote"', lines: body, buttons: ['按钮甲', '按钮乙', '按钮丙'], defaultButton: '按钮乙', timeoutSec: 42 });
  const d = dialogWith(() => 'button returned:按钮甲, gave up:false\n');
  await d.dialog.show(r);
  const args = d.calls[0]!.args;
  const scriptLines = args.flatMap((a, i) => (args[i - 1] === '-e' ? [a] : []));
  assert.ok(scriptLines.length >= 3);
  assert.equal(scriptLines[0], 'on run argv');
  for (const secret of [...body, r.title, ...r.buttons, '42', '按钮', '正文', '标题']) {
    assert.ok(!scriptLines.some((l) => l.includes(secret)), `script mentions ${secret}`);
  }
  const rest = args.slice(args.indexOf('--') + 1);
  assert.deepEqual(rest, [body.join('\n'), r.title, '按钮乙', '42', '按钮甲', '按钮乙', '按钮丙']);
  assert.ok(scriptLines.every((l) => l.includes('argv') || l === 'end run'));
});

test('osascriptDialog: the kill timeout is the dialog timeout plus 15 seconds', async () => {
  const d = dialogWith(() => 'button returned:允许, gave up:false\n');
  await d.dialog.show(req({ timeoutSec: 20 }));
  assert.equal(d.calls[0]!.timeout, 35_000);
});

test('osascriptDialog: outside an Aqua session it is unavailable and never runs osascript', async () => {
  for (const name of ['Background', 'System', '', null]) {
    const d = dialogWith(() => 'button returned:允许, gave up:false\n', name);
    assert.equal((await d.dialog.show(req())).kind, 'unavailable');
    assert.equal((await d.dialog.show(req())).kind, 'unavailable');
    assert.equal(d.calls.length, 0);
    assert.equal(d.asked(), 1, 'launchctl is asked once');
  }
});

test('osascriptDialog: a failing launchctl lookup is unavailable', async () => {
  const calls: Call[] = [];
  const dialog = osascriptDialog({ exec: async (file, args, o) => { calls.push({ file, args, timeout: o.timeout }); return { stdout: '' }; }, managerName: async () => { throw new Error('x'); } });
  assert.equal((await dialog.show(req())).kind, 'unavailable');
  assert.equal(calls.length, 0);
});

test('osascriptDialog: a malformed request is unavailable and runs nothing', async () => {
  const d = dialogWith(() => 'button returned:允许, gave up:false\n');
  for (const r of [req({ buttons: [], defaultButton: 'x' }), req({ buttons: ['a', 'b', 'c', 'd'], defaultButton: 'a' }), req({ defaultButton: '没有' }),
    req({ buttons: ['a', 'a'], defaultButton: 'a' }), req({ buttons: ['a\nb'], defaultButton: 'a\nb' }), req({ timeoutSec: 0 }), req({ timeoutSec: 1.5 })]) {
    assert.equal((await d.dialog.show(r)).kind, 'unavailable');
  }
  assert.equal(d.calls.length, 0);
});

test('noDialog is always unavailable', async () => {
  assert.deepEqual(await noDialog.show(req()), { kind: 'unavailable', why: '内核以 --no-dialogs 启动' });
});

// ---- checkDialogText ----

test('checkDialogText: 200 characters per line and 1500 for the body', () => {
  checkDialogText(req({ lines: ['a'.repeat(200)] }));
  assert.throws(() => { checkDialogText(req({ lines: ['a'.repeat(201)] })); }, (e: E2kError) => isUsage(e) && /内容太长/.test(e.message) && e.next === '拆开再来');
  checkDialogText(req({ lines: Array.from({ length: 5 }, () => 'a'.repeat(200)) }));   // 5*200 + 4 个换行 = 1004
  assert.throws(() => { checkDialogText(req({ lines: Array.from({ length: 8 }, () => 'a'.repeat(200)) })); }, isUsage);   // 8*200 + 7 = 1607
  assert.throws(() => { checkDialogText(req({ lines: Array.from({ length: 1501 }, () => 'a') })); }, isUsage);
});

// ---- Approvals ----

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// 一个由测试手动放行的框：show 返回的 promise 在 release 时才结束。
function manualDialog() {
  const waiting: { r: DialogRequest; settle: (x: DialogResult) => void; fail: (e: unknown) => void }[] = [];
  const seen: DialogRequest[] = [];
  return {
    seen, waiting,
    dialog: { show: (r: DialogRequest) => new Promise<DialogResult>((settle, fail) => { seen.push(r); waiting.push({ r, settle, fail }); }) },
    async release(x: DialogResult): Promise<void> { waiting.shift()!.settle(x); await sleepTick(); },
  };
}

const APPROVE = ['允许'];

test('Approvals: asking the same key three times shows one dialog, with one id, and the title carries the id', async () => {
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: clock().now });
  const first = a.ask('k', 'rules', req(), APPROVE);
  assert.equal(first.status, 'pending');
  const id = first.status === 'pending' ? first.id : '';
  assert.match(id, /^a-[0-9a-f]{6}$/);
  assert.deepEqual(a.ask('k', 'rules', req(), APPROVE), { status: 'pending', id });
  assert.deepEqual(a.ask('k', 'rules', req(), APPROVE), { status: 'pending', id });
  assert.equal(m.seen.length, 1);
  assert.equal(m.seen[0]!.title, `一个标题（请求 ${id}）`);
  assert.deepEqual(m.seen[0]!.lines, ['第一行', '第二行']);
  await m.release({ kind: 'button', button: '允许' });
  assert.deepEqual(a.ask('k', 'rules', req(), APPROVE), { status: 'approved', button: '允许' });
});

test('Approvals: two keys at once show one dialog; the second comes up only after the first is done', async () => {
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: clock().now });
  const one = a.ask('one', 'rules', req({ title: '甲' }), APPROVE);
  const two = a.ask('two', 'writes', req({ title: '乙' }), APPROVE);
  assert.equal(one.status, 'pending'); assert.equal(two.status, 'pending');
  assert.notDeepEqual(one, two);
  assert.deepEqual(m.seen.map((r) => r.title.slice(0, 1)), ['甲']);
  await m.release({ kind: 'button', button: '允许' });
  assert.deepEqual(m.seen.map((r) => r.title.slice(0, 1)), ['甲', '乙']);
  assert.deepEqual(a.ask('one', 'rules', req({ title: '甲' }), APPROVE), { status: 'approved', button: '允许' });
  assert.equal(a.ask('two', 'writes', req({ title: '乙' }), APPROVE).status, 'pending');
  await m.release({ kind: 'timeout' });
  assert.equal(m.seen.length, 2);
});

test('Approvals: queued dialogs are shown first come first served', async () => {
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: clock().now });
  for (const [k, kind] of [['a', 'rules'], ['b', 'writes'], ['c', 'login']] as const) a.ask(k, kind, req({ title: k }), APPROVE);
  await m.release({ kind: 'timeout' });
  await m.release({ kind: 'timeout' });
  assert.deepEqual(m.seen.map((r) => r.title.slice(0, 1)), ['a', 'b', 'c']);
});

test('Approvals: a click on another button is a denial; the same kind is then refused for 60 s without a dialog', async () => {
  const c = clock();
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: c.now });
  a.ask('k1', 'rules', req(), APPROVE);
  await m.release({ kind: 'button', button: '不允许' });
  assert.deepEqual(a.ask('k1', 'rules', req(), APPROVE), { status: 'denied', cooling: false });
  c.advance(59_000);
  assert.deepEqual(a.ask('k2', 'rules', req(), APPROVE), { status: 'denied', cooling: true });
  assert.equal(m.seen.length, 1);
  assert.equal(a.ask('k3', 'writes', req(), APPROVE).status, 'pending');   // 别的类不受影响
  await m.release({ kind: 'timeout' });
  c.advance(2_000);   // 距离拒绝 61 秒
  assert.equal(a.ask('k2', 'rules', req(), APPROVE).status, 'pending');
  assert.equal(m.seen.length, 3);
  await m.release({ kind: 'button', button: '允许' });
  assert.deepEqual(a.ask('k1', 'rules', req(), APPROVE).status, 'pending');   // k1 自己的拒绝也过了冷却，是新的一件事
});

test('Approvals: the seventh dialog within 10 minutes is unavailable; the window slides', async () => {
  const c = clock();
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: c.now });
  for (let i = 0; i < 6; i++) {
    assert.equal(a.ask(`k${i}`, 'rules', req(), APPROVE).status, 'pending');
    await m.release({ kind: 'button', button: '允许' });
    c.advance(10_000);
  }
  assert.deepEqual(a.ask('k6', 'rules', req(), APPROVE), { status: 'unavailable', why: '弹框太频繁，请人看一下' });
  assert.equal(m.seen.length, 6);
  c.advance(10 * 60_000);
  assert.equal(a.ask('k6', 'rules', req(), APPROVE).status, 'pending');
  assert.equal(m.seen.length, 7);
});

test('Approvals: an approval stays until forget, then the same key is a new question', async () => {
  const c = clock();
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: c.now });
  a.ask('k', 'writes', req(), APPROVE);
  await m.release({ kind: 'button', button: '允许' });
  c.advance(60 * 60_000);
  for (let i = 0; i < 3; i++) assert.deepEqual(a.ask('k', 'writes', req(), APPROVE), { status: 'approved', button: '允许' });
  assert.equal(m.seen.length, 1);
  a.forget('k');
  assert.equal(a.ask('k', 'writes', req(), APPROVE).status, 'pending');
  assert.equal(m.seen.length, 2);
});

test('Approvals: only the buttons the caller listed approve', async () => {
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: clock().now });
  a.ask('k', 'login', req({ buttons: ['取消', '默认', '只读'], defaultButton: '取消' }), ['默认', '只读']);
  await m.release({ kind: 'button', button: '只读' });
  assert.deepEqual(a.ask('k', 'login', req(), ['默认', '只读']), { status: 'approved', button: '只读' });
});

test('Approvals: a timeout forgets the key, so asking again shows a new dialog', async () => {
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: clock().now });
  a.ask('k', 'rules', req(), APPROVE);
  await m.release({ kind: 'timeout' });
  assert.equal(a.ask('k', 'rules', req(), APPROVE).status, 'pending');
  assert.equal(m.seen.length, 2);
});

test('Approvals: unavailable or a throwing dialog is logged, never thrown, and everything after is unavailable', async () => {
  for (const how of ['unavailable', 'throws'] as const) {
    const logs: string[] = [];
    const dialog = how === 'unavailable'
      ? fakeDialog(() => ({ kind: 'unavailable', why: '没有桌面' }))
      : fakeDialog(() => { throw new Error('boom /secret/path'); });
    const a = new Approvals(dialog, (l) => { logs.push(l); }, { now: clock().now });
    assert.equal(a.ask('k', 'rules', req(), APPROVE).status, 'pending');
    assert.equal(a.ask('queued', 'writes', req(), APPROVE).status, 'pending');
    await sleepTick(); await sleepTick();
    assert.equal(logs.length, 1);
    assert.ok(!logs[0]!.includes('/secret/path'));
    assert.equal(a.ask('k', 'rules', req(), APPROVE).status, 'unavailable');
    assert.equal(a.ask('queued', 'writes', req(), APPROVE).status, 'unavailable');
    assert.equal(a.ask('other', 'login', req(), APPROVE).status, 'unavailable');
    assert.equal(dialog.requests.length, 1, 'no further dialog is shown');
  }
});

test('Approvals: a 201-character line throws usage and shows nothing', () => {
  const dialog = fakeDialog(() => ({ kind: 'button', button: '允许' }));
  const a = new Approvals(dialog, () => {}, { now: clock().now });
  assert.throws(() => a.ask('k', 'rules', req({ lines: ['x'.repeat(201)] }), APPROVE), isUsage);
  assert.equal(dialog.requests.length, 0);
  assert.equal(a.ask('k', 'rules', req(), APPROVE).status, 'pending');   // 没留下半截状态
});

test('Approvals: a colliding id is drawn again', async () => {
  const ids = ['a-000001', 'a-000001', 'a-000002'];
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: clock().now, newId: () => ids.shift()! });
  assert.deepEqual(a.ask('x', 'rules', req(), APPROVE), { status: 'pending', id: 'a-000001' });
  assert.deepEqual(a.ask('y', 'writes', req(), APPROVE), { status: 'pending', id: 'a-000002' });
});

test('Approvals: a request dropped from the queue by the rate limit is unavailable when asked again', async () => {
  const c = clock();
  const m = manualDialog();
  const a = new Approvals(m.dialog, () => {}, { now: c.now });
  for (let i = 0; i < 5; i++) { a.ask(`k${i}`, 'rules', req(), APPROVE); await m.release({ kind: 'button', button: '允许' }); }
  a.ask('six', 'writes', req(), APPROVE);                                   // 第 6 个，正在弹
  assert.equal(a.ask('seven', 'login', req(), APPROVE).status, 'pending');   // 排在后面
  await m.release({ kind: 'timeout' });
  assert.equal(m.seen.length, 6, 'the seventh is not shown');
  assert.equal(a.ask('seven', 'login', req(), APPROVE).status, 'unavailable');
});

test('pendingError is exit 21 with a retry hint', () => {
  const e = pendingError('a-1b2c3d', '改规则');
  assert.equal(e.code, 'wait-approval');
  assert.equal(exitCodeFor(e.code), 21);
  assert.equal(e.message, '等人在弹框里批准：改规则（请求 a-1b2c3d）');
  assert.equal(e.next, '人点完以后，原样重试这条命令');
});

// ---- 没有经协议批准的路 ----

test('the protocol has no approval method', () => {
  const src = readFileSync(new URL('../../src/shared/protocol.ts', import.meta.url), 'utf8');
  const methods = [...src.matchAll(/^(?:export type Method =|const METHODS[^=]*=)(.*)$/gm)].map((m) => m[1]!);
  assert.equal(methods.length, 2);
  for (const line of methods) assert.ok(!/approv/i.test(line), line);
  for (const name of ['approve', 'approvals', 'approval.grant', 'approvals.approve', 'approve.begin']) {
    assert.throws(() => parseRequest(JSON.stringify({ v: 1, id: 'a1', method: name, params: {} })), isUsage, name);
  }
});
