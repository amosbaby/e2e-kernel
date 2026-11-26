import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { KernelLog, listenerErrorLogger, startKernel } from '../../src/kernel/server.ts';
import { SessionManager } from '../../src/kernel/sessions.ts';
import type { KernelHandle, KernelOptions, StatusResult } from '../../src/kernel/server.ts';
import { call } from '../../src/shared/client.ts';
import { E2kError } from '../../src/shared/errors.ts';
import type { Home } from '../../src/shared/paths.ts';
import type { CloseResult, OpenResult, StepResult } from '../../src/shared/protocol.ts';
import { isSensitiveKey } from '../../src/shared/redact.ts';
import { FakeDriver } from '../support/fake-driver.ts';
import type { FakePageSpec } from '../support/fake-driver.ts';
import { hangingDriver } from '../support/hanging-driver.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

// 长得像 token 的串在运行时拼出来，不写成字面量。
const jwt = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NSJ9', 'c2lnbmF0dXJl' + 'LXZhbHVlLWZvci10ZXN0'].join('.');

const HOME_PAGE: FakePageSpec = {
  snapshot: '- button "Add" [ref=e2]',
  elements: { e2: {}, '#status': { text: 'Added' }, '#gone': { failWith: 'not-found' },
    '#amb': { failWith: 'other', hints: ['2 matches', `1) 可写 #amb >> nth=0 · button @(1,2 3x4) "Save ${jwt}"`] } },
};

function pages(): Record<string, FakePageSpec> {
  return {
    'http://localhost:5173/': HOME_PAGE,
    'http://localhost:5173/down': { gotoFailWith: 'timeout' },
    'http://localhost:5173/login-down': { gotoFailWith: 'other' },
    'http://localhost:5173/wall': { snapshot: '- textbox "Password"', passwordField: true },
    'http://localhost:5173/leak?token=abc123': {
      title: `<b>${jwt}</b>`,
      elements: { '#leak': { text: jwt }, '#markup': { text: `<img src=x onerror=alert(1)><b>${jwt}</b>` } },
    },
  };
}

let home: Home;
let k: KernelHandle;
const cleanups: (() => void | Promise<void>)[] = [];

function tmpHome(): Home {
  const t = makeTmpHome();
  cleanups.push(t.cleanup);
  return t.home;
}

// 测试里另起的内核：断言失败时也由 afterEach 停掉，不让测试进程挂住。
async function started(o: KernelOptions): Promise<KernelHandle> {
  const handle = await startKernel(o);
  cleanups.push(() => handle.stop());
  return handle;
}

beforeEach(async () => {
  home = tmpHome();
  k = await startKernel({ home, driver: new FakeDriver({ pages: pages() }) });
});

afterEach(async () => {
  await k.stop();
  for (const c of cleanups.splice(0).reverse()) await c();
});

function firstLine(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) resolve(buf.slice(0, nl));
    });
    stream.on('error', reject);
    stream.on('end', () => { reject(new Error('stream ended before a full line')); });
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => { resolve(); });
  });
}

// 直接往内核的 socket 写 text，读回一行解析成对象。
type RawReply = { v: number; id: string; ok: boolean; error: { code: string; message: string } };
function raw(text: string): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(home.socket);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => { sock.write(text); });
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        sock.destroy();
        resolve(JSON.parse(buf.slice(0, nl)) as RawReply);
      }
    });
    sock.on('error', reject);
    sock.on('close', () => { reject(new Error('closed without a reply')); });
  });
}

// 写完 text 后等对端关闭；对端在写的过程中就断开也算。
function rawExpectClosed(text: string): Promise<'closed'> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(home.socket);
    sock.on('connect', () => { sock.write(text); });
    sock.on('data', () => { reject(new Error('unexpected reply')); });
    sock.on('error', () => { /* EPIPE / ECONNRESET：对端已经断开 */ });
    sock.on('close', () => { resolve('closed'); });
  });
}

function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (typeof v === 'object' && v !== null) {
    for (const [key, val] of Object.entries(v)) {
      out.push(key);
      keysOf(val, out);
    }
  }
  return out;
}

test('serves status; socket and pid file are 0600 inside a 0700 home', async () => {
  const r = await call(home, 'status', {});
  assert.ok(r.ok); const s = r.result as StatusResult;
  assert.equal(s.version, '0.1.0'); assert.equal(s.instance, 'stopped'); assert.equal(s.home, home.root);
  assert.equal(statSync(home.root).mode & 0o777, 0o700); assert.equal(statSync(home.socket).mode & 0o777, 0o600);
  assert.equal(statSync(home.pidFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(home.pidFile, 'utf8').trim(), String(process.pid));
});

test('status reports pid, driver and sessions, and no key in it is a sensitive key', async () => {
  const open = await call(home, 'open', { url: 'http://localhost:5173/', name: 'orders' });
  assert.ok(open.ok);
  const r = await call(home, 'status', {});
  assert.ok(r.ok); const s = r.result as StatusResult;
  assert.equal(s.pid, process.pid); assert.equal(s.instance, 'running');
  assert.equal(s.driver.name, 'fake'); assert.equal(s.driver.capabilities.selectorDialect, 'playwright');
  assert.deepEqual(s.sessions.map((x) => x.name), ['orders']);
  assert.deepEqual(s.profiles, [{ name: 'default', state: 'never-launched', lastLogin: null }]);
  const lb = await call(home, 'login.begin', { url: 'http://localhost:5173/' });
  assert.ok(lb.ok); assert.ok((await call(home, 'login.end', { loginId: (lb.result as { loginId: string }).loginId })).ok);
  const after = await call(home, 'status', {});
  assert.ok(after.ok);
  const login = (after.result as StatusResult).profiles[0]!.lastLogin;
  assert.equal(login?.host, 'localhost'); assert.match(login?.at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  const keys = keysOf(after);
  assert.ok(keys.includes('idleSec') && keys.includes('networkInterception'));
  assert.ok(['profiles', 'state', 'lastLogin', 'at', 'host'].every((k) => keys.includes(k)), keys.join());
  assert.deepEqual(keys.filter(isSensitiveKey), []);
  assert.equal(statSync(home.logFile).mode & 0o777, 0o600);
});

test('status reports the rules state, rereads the file first, and its keys are not sensitive', async () => {
  const h = tmpHome();
  await started({ home: h, driver: new FakeDriver() });
  const rules = async (): Promise<StatusResult['rules']> => {
    const r = await call(h, 'status', {}); assert.ok(r.ok); return (r.result as StatusResult).rules;
  };
  assert.deepEqual(await rules(), { count: 0, hash: null, error: null });
  writeFileSync(h.rulesFile, '{"version":1,"rules":[{"match":"*.example.com","mode":"readonly"}]}');
  const good = await rules();
  assert.equal(good.count, 1); assert.match(good.hash ?? '', /^sha256:[0-9a-f]{16}$/); assert.equal(good.error, null);
  writeFileSync(h.rulesFile, '{"version":1,"rules":null}');
  const bad = await rules();
  assert.equal(bad.count, 1); assert.equal(bad.hash, good.hash); assert.match(bad.error ?? '', /rules must be an array/);
  const raw = await call(h, 'status', {});
  assert.deepEqual(keysOf(raw).filter(isSensitiveKey), []);
});

test('a second start on the same home is refused while the first is alive', async () => {
  await assert.rejects(startKernel({ home, driver: new FakeDriver() }), /内核已在运行/);
  assert.ok((await call(home, 'status', {})).ok);                       // 第一个不受影响
  assert.equal(readFileSync(home.pidFile, 'utf8').trim(), String(process.pid));
});

test('leftovers of a killed kernel do not block start', async () => {
  const stale = tmpHome();
  const child = spawn(process.execPath, ['test/support/stale-kernel.ts', stale.root]);
  cleanups.push(() => { child.kill('SIGKILL'); });
  assert.equal(await firstLine(child.stdout), 'ready');                // 等它打印 ready
  child.kill('SIGKILL'); await exited(child);
  assert.ok(existsSync(stale.pidFile)); assert.ok(existsSync(stale.socket));   // 被强杀，来不及清理
  const k2 = await started({ home: stale, driver: new FakeDriver() });
  assert.ok((await call(stale, 'status', {})).ok);
  assert.equal(readFileSync(stale.pidFile, 'utf8').trim(), String(process.pid));
  await k2.stop();
});

test('a pid file pointing at a live process without a socket needs a human', async () => {
  const lonely = tmpHome();
  writeFileSync(lonely.pidFile, String(process.pid));                   // 活着的进程（测试自己），但没有 socket
  await assert.rejects(startKernel({ home: lonely, driver: new FakeDriver() }), (e: E2kError) => e.code === 'needs-human');
  assert.ok(existsSync(lonely.pidFile));                                // 不自动删
});

test('call() without a kernel says the kernel is not running', async () => {
  const emptyHome = tmpHome();
  await assert.rejects(call(emptyHome, 'status', {}), (e: E2kError) => e.code === 'needs-human');
});

test('bad requests get a usage error and the server stays up', async () => {
  assert.deepEqual([(await raw('not json\n')).error.code, (await raw('not json\n')).id], ['usage', '-']);
  assert.equal((await raw('{"v":1,"id":"a","method":"approve","params":{}}\n')).error.code, 'usage');
  assert.equal((await raw('{"v":1,"id":"a","method":"status","params":{"x":1}}\n')).id, 'a');
  assert.equal(await rawExpectClosed('x'.repeat(2 * 1024 * 1024)), 'closed');
  assert.ok((await call(home, 'status', {})).ok);
});

test('open, step, close round trip writes the report', async () => {
  const open = await call(home, 'open', { url: 'http://localhost:5173/' });
  assert.ok(open.ok); const session = (open.result as OpenResult).session;
  const step = await call(home, 'step', { session, ops: [{ op: 'click', target: 'e2' }] });
  const close = await call(home, 'close', { session, verdict: { value: 'pass' } });
  assert.ok(step.ok && close.ok); assert.ok(existsSync((close.result as CloseResult).reportPath));
  const log = readFileSync(home.logFile, 'utf8');
  for (const method of ['open', 'step', 'close']) assert.match(log, new RegExp(`^\\S+ ${method} [0-9a-f-]{36} ok \\d+ms$`, 'm'));
  assert.ok(!log.includes('localhost:5173'));                            // 不记参数和响应内容
});

test('a login wall comes back as blocked + next, and neither key is sensitive', async () => {
  const open = await call(home, 'open', { url: 'http://localhost:5173/wall' });
  assert.ok(open.ok); const o = open.result as OpenResult;
  assert.equal(o.blocked, 'login'); assert.match(o.next ?? '', /^页面停在登录页.*login http:\/\/localhost:5173\/wall 登录后重试；若这是预期页面（如修改密码页）可忽略。会话仍开着，用完请 close$/);
  const step = await call(home, 'step', { session: o.session, ops: [{ op: 'snapshot' }] });
  assert.ok(step.ok); const r = step.result as StepResult;
  assert.deepEqual([r.exit, r.blocked], [20, 'login']);
  const keys = [...keysOf(open), ...keysOf(step)];
  assert.ok(keys.includes('blocked') && keys.includes('next'));
  for (const key of keys) assert.ok(!isSensitiveKey(key), key);
});

test('a failed action comes back with redacted hints, and the key is not sensitive', async () => {
  const open = await call(home, 'open', { url: 'http://localhost:5173/' });
  assert.ok(open.ok);
  const step = await call(home, 'step', { session: (open.result as OpenResult).session, ops: [{ op: 'click', target: '#amb' }] });
  assert.ok(step.ok); const r = (step.result as StepResult).results[0]!;
  assert.equal(r.outcome, 'failed'); assert.equal(r.hints?.length, 2); assert.equal(r.hints?.[0], '2 matches');
  assert.ok(r.hints?.[1]?.includes('>> nth=0')); assert.ok(!JSON.stringify(step).includes(jwt));
  const keys = keysOf(step);
  assert.ok(keys.includes('hints') && keys.includes('seq')); for (const key of keys) assert.ok(!isSensitiveKey(key), key);
});

test('step keepGoing travels over the socket: the batch goes on after a failure, and seq/keepGoing are not sensitive keys', async () => {
  const open = await call(home, 'open', { url: 'http://localhost:5173/' });
  assert.ok(open.ok); const session = (open.result as OpenResult).session;
  const params = { session, ops: [{ op: 'click', target: '#gone' }, { op: 'snapshot' }], keepGoing: true };
  const step = await call(home, 'step', params);
  assert.ok(step.ok); const r = step.result as StepResult;
  assert.deepEqual(r.results.map((x) => x.outcome), ['failed', 'ok']); assert.equal(r.exit, 11);
  assert.equal(r.results[1]!.seq, r.results[0]!.seq + 1);
  for (const key of [...keysOf(step), ...Object.keys(params)]) assert.ok(!isSensitiveKey(key), key);
  const bad = await call(home, 'step', { ...params, keepGoing: 'yes' });
  assert.equal(bad.ok, false);
});

test('open touch travels over the socket, a non-boolean is refused, and touch is not a sensitive key', async () => {
  const params = { url: 'http://localhost:5173/', touch: true };
  const open = await call(home, 'open', params);
  assert.ok(open.ok);
  for (const key of [...keysOf(open), ...Object.keys(params)]) assert.ok(!isSensitiveKey(key), key);
  const bad = await call(home, 'open', { url: 'http://localhost:5173/', touch: 'yes' });
  assert.equal(bad.ok, false);
});

test('responses are redacted but kernel identifiers survive', async () => {
  const open = await call(home, 'open', { url: 'http://localhost:5173/leak?token=abc123', name: 'a'.repeat(40) });
  assert.ok(open.ok); const o = open.result as OpenResult;
  assert.equal(o.name, 'a'.repeat(40)); assert.ok(existsSync(o.runDir)); assert.ok(!o.url.includes('abc123'));
  assert.ok(!o.title.includes(jwt));
  const step = await call(home, 'step', { session: o.session,
    ops: [{ op: 'text', target: '#leak' }, { op: 'text', target: '#markup' }, { op: 'screenshot' }] });
  assert.ok(step.ok); assert.ok(!JSON.stringify(step).includes(jwt));
  const results = (step.result as StepResult).results;
  assert.match(String(results[1]?.output), /^<img src=x onerror=alert\(1\)><b>\[REDACTED\]<\/b>$/);
  assert.ok(existsSync(join(o.runDir, String(results[2]?.shot))));      // 内核给的路径原样保留
  const status = await call(home, 'status', {});
  assert.ok(status.ok); assert.ok(!JSON.stringify(status).includes('abc123'));
  assert.deepEqual((status.result as StatusResult).sessions.map((x) => x.name), ['a'.repeat(40)]);
});

test('error messages are redacted on the way out too', async () => {
  const other = tmpHome();
  const k2 = await started({ home: other,
    driver: new FakeDriver({ failOpenWith: new E2kError('action-failed', `could not open <a href="/x?token=abc123">${jwt}</a>`) }) });
  const r = await call(other, 'open', { url: 'http://localhost:5173/' });
  assert.ok(!r.ok); assert.equal(r.error.code, 'action-failed');
  assert.equal(r.error.message, 'could not open <a href="/x?token=[REDACTED]">[REDACTED]</a>');
  await k2.stop();
});

test('a failed first navigation comes back as action-failed', async () => {
  const r = await call(home, 'open', { url: 'http://localhost:5173/down' });   // gotoFailWith: 'timeout'
  assert.ok(!r.ok && r.error.code === 'action-failed');
});

test('internal errors do not leak details to the client', async () => {
  const other = tmpHome();
  const k2 = await started({ home: other, driver: new FakeDriver({ failOpenWith: new Error(`boom at /private/path ${jwt}`) }) });
  const r = await call(other, 'open', { url: 'http://localhost:5173/' });
  assert.ok(!r.ok); assert.deepEqual(r.error, { code: 'internal', message: '内核内部错误，详见 kernel.log' });
  const log = readFileSync(other.logFile, 'utf8');
  assert.ok(log.includes('boom')); assert.ok(!log.includes(jwt));
  await k2.stop();
});

test('stop() closes sessions, stops the browser and removes socket and pid file', async () => {
  const open = await call(home, 'open', { url: 'http://localhost:5173/' });
  assert.ok(open.ok); const runDir = (open.result as OpenResult).runDir;
  await k.stop();
  assert.ok(!existsSync(home.socket)); assert.ok(!existsSync(home.pidFile));
  assert.equal(JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')).closedBy, 'kernel-shutdown');
});

test('a second stop() just returns', async () => {
  await k.stop();
  await k.stop();
  assert.ok(!existsSync(home.pidFile));
  await assert.rejects(call(home, 'status', {}), (e: E2kError) => e.code === 'needs-human');
});

test('stop() has its own deadline: a drain that never settles still stops the browser and exits', async () => {
  const slow = tmpHome();
  const h = hangingDriver(pages());
  const k2 = await started({ home: slow, driver: h.driver, stopDeadlineMs: 300 });
  const pending = call(slow, 'open', { url: 'http://localhost:5173/' }).catch((e: unknown) => e);
  while (!h.opened()) await sleep(10);
  const stopping = k2.stop();
  const during = await call(slow, 'open', { url: 'http://localhost:5173/' });       // 关停开始后的调用：busy 原样转回
  assert.ok(!during.ok); assert.equal(during.error.code, 'busy'); assert.equal(during.error.message, '内核正在关停');
  await stopping;
  assert.equal(h.stops(), 1);
  assert.ok(!existsSync(slow.socket)); assert.ok(!existsSync(slow.pidFile));
  assert.match(readFileSync(slow.logFile, 'utf8'), /关停超过 300 毫秒/);
  assert.equal(((await pending) as E2kError).code, 'internal');                  // 没等到回话的连接被断开
});

test('stop() is bounded by the deadline plus a short grace even when the browser instance never stops', async () => {
  const slow = tmpHome();
  const h = hangingDriver(pages(), { hangStop: true });
  const k2 = await started({ home: slow, driver: h.driver, stopDeadlineMs: 2000 });
  void call(slow, 'open', { url: 'http://localhost:5173/' }).catch(() => undefined);
  while (!h.opened()) await sleep(10);
  const t0 = Date.now();
  await k2.stop();
  const took = Date.now() - t0;
  assert.ok(took >= 1900, `stop() should wait for the drain deadline first (${took} ms)`);
  assert.ok(took < 3500, `stop() took ${took} ms: more than the deadline plus the grace`);   // 以前约是期限的 2 倍（4000 毫秒）
  assert.equal(h.stops(), 1);
  assert.ok(!existsSync(slow.socket)); assert.ok(!existsSync(slow.pidFile));
});

test('abort() cuts the shutdown short: the instance is stopped, connections dropped, files removed', async () => {
  const slow = tmpHome();
  const h = hangingDriver(pages(), { hangStop: true });
  const k2 = await started({ home: slow, driver: h.driver });   // 默认期限 45 秒：不靠它
  void call(slow, 'open', { url: 'http://localhost:5173/' }).catch(() => undefined);
  while (!h.opened()) await sleep(10);
  const stopping = k2.stop();
  await sleep(50);
  const t0 = Date.now();
  await k2.abort();
  await stopping;
  assert.ok(Date.now() - t0 < 1500, 'abort() must not wait for the deadline');
  assert.ok(h.stops() >= 1);
  assert.ok(!existsSync(slow.socket)); assert.ok(!existsSync(slow.pidFile));
});

test('a rejected sessions.shutdown() is logged and treated as not drained: the instance is stopped directly', async () => {
  const bad = tmpHome();
  const h = hangingDriver(pages());
  const k2 = await started({ home: bad, driver: h.driver, stopDeadlineMs: 300 });
  void call(bad, 'open', { url: 'http://localhost:5173/' }).catch(() => undefined);
  while (!h.opened()) await sleep(10);
  const m = mock.method(SessionManager.prototype, 'shutdown', () => Promise.reject(new Error(`drain blew up ${jwt}`)));
  try {
    await k2.stop();
  } finally {
    m.mock.restore();
  }
  const log = readFileSync(bad.logFile, 'utf8');
  assert.match(log, /关停收尾失败：Error: drain blew up/);
  assert.equal(log.split('\n').filter((l) => l.includes('关停收尾失败')).length, 1);   // 带 stack 的失败也只占一行
  assert.ok(!log.includes(jwt));
  assert.equal(h.stops(), 1);                                   // 按没 drain 完处理：直接停了实例
  assert.ok(!existsSync(bad.socket)); assert.ok(!existsSync(bad.pidFile));
});

test('KernelLog.write keeps every entry on one line: CR and LF become spaces', () => {
  const quiet = tmpHome();
  const log = new KernelLog(quiet.logFile);
  log.write('a\nb\rc\r\nd');
  log.close();
  const lines = readFileSync(quiet.logFile, 'utf8').split('\n');
  assert.equal(lines.length, 2); assert.equal(lines[1], '');    // 一行加结尾换行
  assert.ok(!lines[0]!.includes('\r'));
  assert.ok(lines[0]!.endsWith(' a b c  d'));
});

test('listenerErrorLogger writes one redacted line to a 0600 kernel.log', () => {
  const quiet = tmpHome();
  listenerErrorLogger(quiet)(new Error(`listener failed at http://localhost:5173/x?token=abc123\nnext line ${jwt}`));
  const log = readFileSync(quiet.logFile, 'utf8');
  assert.equal(log.split('\n').filter((l) => l !== '').length, 1);
  assert.ok(log.includes('listener failed')); assert.ok(!log.includes(jwt)); assert.ok(!log.includes('abc123'));
  assert.equal(statSync(quiet.logFile).mode & 0o777, 0o600);
});
