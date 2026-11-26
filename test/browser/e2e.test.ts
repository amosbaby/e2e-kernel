import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createPlaywrightDriver } from '../../src/drivers/playwright/driver.ts';
import { startKernel } from '../../src/kernel/server.ts';
import type { KernelHandle } from '../../src/kernel/server.ts';
import { call } from '../../src/shared/client.ts';
import { startFixtureServer } from '../support/fixture-server.ts';
import type { FixtureServer } from '../support/fixture-server.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

// 端到端验收：真浏览器（有头 Chromium）、真 fixture 服务、测试进程内的内核，CLI 走 bin/e2k.js 子进程。
// 这份文件里的测试按书写顺序执行，共用模块级的 sid 和 ref。
// CLI 子进程必须异步等待：内核就在本进程里，同步等子进程会把内核的事件循环一起卡死。
const REPO = join(import.meta.dirname, '..', '..');
const BIN = join(REPO, 'bin', 'e2k.js');
const tmp = makeTmpHome();
const home = tmp.home;
let server: FixtureServer;
let origin: string;
let kernel: KernelHandle;
let sid = '';
let ref = '';

interface Run { code: number | null; out: string; err: string }

// 参数固定、不经 shell；input 给了就作为标准输入。
function e2kIn(input: string | undefined, ...args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: REPO, env: { ...process.env, E2K_HOME: home.root }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out, err }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

function e2k(...args: string[]): Promise<Run> {
  return e2kIn(undefined, ...args);
}

function allFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? allFilesUnder(p) : [p];
  });
}

before(async () => {
  server = await startFixtureServer();
  origin = server.origin;
  kernel = await startKernel({ home, driver: createPlaywrightDriver() });
});

after(async () => {
  try {
    await kernel.stop();   // 幂等；测试中途失败时也要收掉浏览器
  } finally {
    await server.close();
    tmp.cleanup();
  }
});

test('a page opened by login leaves its cookie for later sessions', { timeout: 180_000 }, async () => {
  const begin = await call(home, 'login.begin', { url: origin + '/login.html' });
  assert.ok(begin.ok);
  await call(home, 'login.end', (begin as { result: unknown }).result);
  const open = JSON.parse((await e2k('open', origin + '/index.html', '--name', 'cookie', '--json')).out);
  const asserted = await e2k('step', open.session, JSON.stringify([{ op: 'assert', kind: 'text', target: '#login-state', cmp: 'eq', expected: 'signed-in' }]));
  assert.equal(asserted.code, 0);
  assert.equal((await e2k('close', open.session)).code, 0);
});

test('open, act by ref and by selector, assert, screenshot', { timeout: 180_000 }, async () => {
  const open = JSON.parse((await e2k('open', origin + '/index.html', '--name', 'items', '--json')).out);
  sid = open.session;
  ref = /button "Add" \[ref=(e\d+)\]/.exec(open.snapshot)![1]!;
  const r = await e2k('step', sid, JSON.stringify([
    { op: 'fill', target: 'role=textbox[name="New item"]', value: 'Gamma' },
    { op: 'click', target: ref },
    { op: 'wait', for: { text: 'Added' } },
    { op: 'assert', kind: 'count', target: '#list li', cmp: 'eq', expected: 3 },
    { op: 'assert', kind: 'css', target: '#styled', property: 'color', cmp: 'eq', expected: '#008000' },
    { op: 'assert', kind: 'text', target: '#status', cmp: 'eq', expected: 'Nope' },
    { op: 'screenshot' },
  ]));
  assert.equal(r.code, 10);
  assert.match(r.out, /相符 2 \/ 不符 1 \/ 执行失败 0 \/ 未执行 0/);
  assert.ok(server.hits.some((h) => h.method === 'POST' && h.path === '/api/items'));   // 「默认」模式：写放行
});

test('page secrets and markup never reach the output; a failed action stops the batch', { timeout: 180_000 }, async () => {
  const ops = [{ op: 'goto', url: origin + '/tricky.html' }, { op: 'snapshot' }, { op: 'text' }, { op: 'console' },
    { op: 'eval', js: 'document.querySelector("#leak").textContent' }, { op: 'click', target: '#nope' }, { op: 'snapshot' }];
  const r = await e2kIn(JSON.stringify(ops), 'step', sid, '--stdin');
  assert.equal(r.code, 11);
  assert.match(r.out, /未执行 1/);
  for (const s of [server.fake.jwt, server.fake.bearer]) assert.ok(!r.out.includes(s) && !r.err.includes(s));
  // 内核自己的值没有被脱敏弄坏：会话 id 和失败截图的路径原样在
  assert.ok(r.out.includes(sid));
  assert.match(r.out, /shots\/\d+\.jpg/);
});

test('the kernel refuses to type into a password field', { timeout: 180_000 }, async () => {
  const r = await e2k('step', sid, JSON.stringify([{ op: 'goto', url: origin + '/login.html' }, { op: 'fill', target: '#pw', value: 'not-a-real-password' }]));
  assert.equal(r.code, 11);
  assert.match(r.out, /password-field/);
  assert.ok(!r.out.includes('not-a-real-password') && !r.err.includes('not-a-real-password'));
});

test('close writes a report with evidence, writes, a replayable record, and no secrets', { timeout: 180_000 }, async () => {
  const closed = await e2k('close', sid, '--verdict', 'pass', '--because', '列表多了一项', '--json');
  const close = JSON.parse(closed.out);
  assert.equal(close.exit, 10);
  assert.equal(close.consistency, 'conflict');
  const result = JSON.parse(readFileSync(close.resultPath, 'utf8'));
  assert.deepEqual(result.actions[1].target, { given: ref, stable: { selector: '[data-testid="add"]', via: 'testid' } });
  const post = result.writes.allowed.find((w: any) => w.method === 'POST' && w.url.endsWith('/api/items'));
  // 填值：只有确认不是密码框的才留值，被拒绝的密码框那条记成 [REDACTED]
  assert.equal(result.actions[0].op.value, 'Gamma');
  assert.equal(result.actions.at(-1).op.value, '[REDACTED]');
  assert.equal(post.status, 200);
  assert.equal(post.decision, 'allowed');
  assert.deepEqual(result.hosts[0], { host: '127.0.0.1', mode: 'default' });
  assert.ok(readdirSync(join(close.runDir, 'shots')).some((f: string) => f.endsWith('.jpg')));
  for (const f of allFilesUnder(close.runDir).filter((p) => !p.endsWith('.jpg'))) {
    const text = readFileSync(f, 'utf8');
    for (const s of [server.fake.jwt, server.fake.bearer, server.fake.password, 'not-a-real-password']) assert.ok(!text.includes(s), `${f} leaks`);
    assert.ok(!text.includes('<script>window.pwned=1</script>'), `${f} carries page markup verbatim`);
  }
  const html = readFileSync(close.reportPath, 'utf8');
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('这次动了什么'));
  assert.ok(html.includes('结论与记录不一致'));
});

test('a first navigation that fails leaves no session behind', { timeout: 180_000 }, async () => {
  assert.equal((await e2k('open', 'http://127.0.0.1:9/')).code, 11);
  assert.deepEqual(JSON.parse((await e2k('status', '--json')).out).sessions, []);
});

test('permissions and shutdown', { timeout: 180_000 }, async () => {
  assert.equal(statSync(home.root).mode & 0o777, 0o700);
  assert.equal(statSync(home.socket).mode & 0o777, 0o600);
  assert.equal(statSync(join(home.profilesDir, 'default')).mode & 0o777, 0o700);
  await kernel.stop();
  assert.ok(!existsSync(home.socket));
  assert.equal((await e2k('status')).code, 22);
});
