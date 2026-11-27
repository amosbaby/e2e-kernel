import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { BROWSER_SWITCHES, browserArgs, pipeTransport, startBrowser } from '../../src/drivers/playwright/browser-process.ts';

// ---- 启动参数 ----

test('browserArgs controls the browser over a pipe: no TCP debugging port, no start page, no sandbox opt-out', () => {
  const args = browserArgs('/tmp/profile-x');
  assert.ok(args.includes('--remote-debugging-pipe'));
  assert.ok(args.includes('--no-startup-window'), '没有启动窗口：开浏览器不抢前台');
  assert.ok(args.includes('--user-data-dir=/tmp/profile-x'));
  // 调试端口没有认证，本机任何进程都能连：一个都不许出现（任何写法）。
  assert.deepEqual(args.filter((a) => /remote-debugging-(port|address)/i.test(a)), []);
  assert.deepEqual(args.filter((a) => /debugging-port|inspect|devtools-port/i.test(a)), []);
  // 不带 - 的参数会被当成启动页，开出窗口抢前台。
  assert.deepEqual(args.filter((a) => !a.startsWith('-')), []);
  assert.ok(!args.includes('--no-sandbox'), '保留浏览器自己的沙箱');
  assert.equal(args.filter((a) => a.startsWith('--user-data-dir')).length, 1);
});

test('browserArgs keeps the Playwright switches the profile and the page behaviour depend on', () => {
  for (const need of ['--use-mock-keychain', '--password-store=basic',   // 已有 profile 的 cookie 加密方式
    '--disable-popup-blocking', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-back-forward-cache', '--no-first-run', '--no-default-browser-check'])
    assert.ok(BROWSER_SWITCHES.includes(need), need);
  const disabled = BROWSER_SWITCHES.find((a) => a.startsWith('--disable-features='));
  assert.ok(disabled?.includes('HttpsUpgrades'), 'http 不被自动升级，请求才都走路由');
});

test('browserArgs passes the profile directory as one argv element, whatever it contains', () => {
  const odd = '/tmp/a b;c$(x)\'"`\n/p';
  assert.ok(browserArgs(odd).includes(`--user-data-dir=${odd}`));
});

// ---- 管道传输 ----

function pipes(): { write: PassThrough; read: PassThrough; sent: () => string } {
  const write = new PassThrough();
  const read = new PassThrough();
  const out: Buffer[] = [];
  write.on('data', (d: Buffer) => out.push(d));
  return { write, read, sent: () => Buffer.concat(out).toString('utf8') };
}

// 每条消息一个任务，几条消息就要几轮：多等几轮。
const tick = async (): Promise<void> => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

test('pipeTransport sends each message as JSON followed by a NUL byte', async () => {
  const { write, read, sent } = pipes();
  const t = pipeTransport(write, read);
  t.send({ id: 1, method: 'A.b' });
  t.send({ id: 2, method: 'C.d', params: { x: '汉' } });
  await tick();
  assert.equal(sent(), '{"id":1,"method":"A.b"}\0{"id":2,"method":"C.d","params":{"x":"汉"}}\0');
});

test('pipeTransport splits what it reads on NUL, across chunks and inside one chunk, and keeps multi-byte text whole', async () => {
  const { write, read } = pipes();
  const t = pipeTransport(write, read);
  const got: object[] = [];
  t.onmessage = (m) => { got.push(m); };
  const bytes = Buffer.from('{"id":1,"r":"汉字"}\0{"id":2}\0{"id":3,"r":"x"}\0', 'utf8');
  read.write(bytes.subarray(0, 12));       // 在多字节字符中间切开
  read.write(bytes.subarray(12, 30));
  read.write(bytes.subarray(30));
  await tick();
  assert.deepEqual(got, [{ id: 1, r: '汉字' }, { id: 2 }, { id: 3, r: 'x' }]);
});

test('pipeTransport hands over each message in its own task, so a promise continuation of one message runs before the next message', async () => {
  const { write, read } = pipes();
  const t = pipeTransport(write, read);
  const order: string[] = [];
  t.onmessage = (m) => {
    const id = (m as { id: number }).id;
    order.push(`message ${id}`);
    void Promise.resolve().then(() => { order.push(`continuation ${id}`); });
  };
  read.write('{"id":1}\0{"id":2}\0{"id":3}\0');   // 一口气到的三条
  await tick();
  assert.deepEqual(order, ['message 1', 'continuation 1', 'message 2', 'continuation 2', 'message 3', 'continuation 3']);
});

test('pipeTransport tells onclose after the messages that were already received', async () => {
  const { write, read } = pipes();
  const t = pipeTransport(write, read);
  const order: string[] = [];
  t.onmessage = () => { order.push('message'); };
  t.onclose = () => { order.push('close'); };
  read.write('{"id":1}\0{"id":2}\0');
  read.end();
  await tick();
  assert.deepEqual(order, ['message', 'message', 'close']);
});

test('pipeTransport reports onclose once when the browser side goes away, and send afterwards does nothing', async () => {
  const { write, read, sent } = pipes();
  const t = pipeTransport(write, read);
  const reasons: (string | undefined)[] = [];
  t.onclose = (r) => { reasons.push(r); };
  read.end();
  await tick();
  t.close();
  assert.equal(reasons.length, 1);
  t.send({ id: 9 });
  await tick();
  assert.equal(sent(), '');
});

test('pipeTransport close() ends the write side (the browser sees the pipe close) and tells the listener once', async () => {
  const { write, read } = pipes();
  const t = pipeTransport(write, read);
  let ended = false;
  write.on('end', () => { ended = true; });
  const reasons: (string | undefined)[] = [];
  t.onclose = (r) => { reasons.push(r); };
  write.resume();
  t.close();
  t.close();
  await tick();
  assert.equal(ended, true);
  assert.equal(reasons.length, 1);
});

test('pipeTransport treats a malformed message as a broken pipe: it closes instead of guessing', async () => {
  const { write, read } = pipes();
  const t = pipeTransport(write, read);
  const got: object[] = [];
  const reasons: (string | undefined)[] = [];
  t.onmessage = (m) => { got.push(m); };
  t.onclose = (r) => { reasons.push(r); };
  read.write('{"id":1}\0{not json\0{"id":3}\0');
  await tick();
  assert.deepEqual(got, [{ id: 1 }]);
  assert.equal(reasons.length, 1);
});

// ---- 进程生命周期 ----

class FakeChild extends EventEmitter {
  pid: number | undefined;
  stdio: (PassThrough | null)[] = [null, null, null, new PassThrough(), new PassThrough()];
  constructor(pid: number | undefined) { super(); this.pid = pid; }
  kill(): boolean { return true; }
  exit(code: number | null): void { this.emit('exit', code, null); }
}

interface Rig {
  child: FakeChild;
  signals: [number, string][];
  spawned: { command: string; args: readonly string[]; options: SpawnOptions }[];
  start: () => ReturnType<typeof startBrowser>;
}

// 假的 spawn 和 kill：不起任何真进程，也不发任何真信号。
function rig(pid: number | null = 4242, exitOn?: (sig: string) => boolean): Rig {
  const child = new FakeChild(pid ?? undefined);
  const signals: [number, string][] = [];
  const spawned: Rig['spawned'] = [];
  return {
    child, signals, spawned,
    start: () => startBrowser('/opt/browser/exe', '/tmp/profile-x', {
      spawn: (command, args, options) => { spawned.push({ command, args, options }); return child as unknown as ChildProcess; },
      kill: (p, sig) => { signals.push([p, sig]); if (exitOn?.(sig) === true) child.exit(null); },
    }),
  };
}

test('startBrowser spawns the executable with argv only (no shell), in its own process group, with exactly the two pipes', () => {
  const r = rig();
  r.start();
  assert.equal(r.spawned.length, 1);
  const s = r.spawned[0]!;
  assert.equal(s.command, '/opt/browser/exe');
  assert.deepEqual(s.args, browserArgs('/tmp/profile-x'));
  assert.equal(s.options.shell, false);
  assert.equal(s.options.detached, true);
  assert.deepEqual(s.options.stdio, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
});

test('terminate: closing the pipe is enough when the browser exits by itself — no signal is sent', async () => {
  const r = rig();
  const proc = r.start();
  r.child.stdio[3]!.on('end', () => { setImmediate(() => r.child.exit(0)); });
  r.child.stdio[3]!.resume();
  await proc.terminate(500);
  assert.deepEqual(r.signals, []);
  assert.equal(proc.hasExited(), true);
});

test('terminate escalates to SIGTERM, then SIGKILL, and every signal goes to its own pid (or its own group) only', async () => {
  const r = rig(4242, (sig) => sig === 'SIGKILL');
  const proc = r.start();
  await proc.terminate(20);
  assert.deepEqual(r.signals.map(([, s]) => s), ['SIGTERM', 'SIGKILL', 'SIGKILL']);
  for (const [p] of r.signals) assert.ok(p === 4242 || p === -4242, `signal to ${p}`);
  assert.equal(proc.hasExited(), true);
});

test('terminate sends no signal at all once the process has exited (its pid may belong to someone else by then)', async () => {
  const r = rig();
  const proc = r.start();
  r.child.exit(0);
  await proc.exited;
  await proc.terminate(20);
  await proc.terminate(20);
  assert.deepEqual(r.signals, []);
});

test('terminate never throws, even when sending a signal fails', async () => {
  const child = new FakeChild(4242);
  const proc = startBrowser('/opt/browser/exe', '/tmp/p', {
    spawn: () => child as unknown as ChildProcess,
    kill: () => { throw new Error('ESRCH'); },
  });
  await proc.terminate(10);
  assert.equal(proc.hasExited(), false);
});

test('an unexpected exit resolves exited with the code; a failed spawn resolves it too and reports only the error code', async () => {
  const r = rig();
  const proc = r.start();
  r.child.exit(3);
  assert.equal(await proc.exited, 3);
  assert.equal(proc.spawnErrorCode(), null);

  const bad = rig(null);
  const p2 = bad.start();
  const err: NodeJS.ErrnoException = Object.assign(new Error('spawn /opt/browser/exe ENOENT'), { code: 'ENOENT' });
  bad.child.emit('error', err);
  assert.equal(await p2.exited, null);
  assert.equal(p2.spawnErrorCode(), 'ENOENT');
  assert.equal(p2.hasExited(), true);
  await p2.terminate(10);
  assert.deepEqual(bad.signals, []);
});
