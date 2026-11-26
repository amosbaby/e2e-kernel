import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
// 36 个十六进制字符、运行时生成：够长，脱敏的 hex 规则（32 位以上）若误伤内核自己的值（会话名）就会暴露；不写成字面量。
const NAME = randomBytes(18).toString('hex');
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
  const opened = await e2k('open', origin + '/index.html', '--name', NAME, '--json');
  const open = JSON.parse(opened.out);
  assert.equal(open.name, NAME);
  assert.ok(open.runDir.includes(NAME));
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

test('page tokens never reach the output; a failed action stops the batch', { timeout: 180_000 }, async () => {
  // 命令输出是页面文本的原样输出（给 agent 或终端看，不是 HTML 语境），只有长得像 token 的串会被脱敏；标签不会被转义。
  // 末尾前的那条不符的 assert 让页面里的标签进入 result.json 和 report.html，close 之后在那边验证它们被转义。
  const ops = [{ op: 'goto', url: origin + '/tricky.html' }, { op: 'snapshot' }, { op: 'text' }, { op: 'console' },
    { op: 'assert', kind: 'text', target: '#markup', cmp: 'eq', expected: 'x' },
    { op: 'eval', js: 'document.querySelector("#leak").textContent' }, { op: 'click', target: '#nope' }, { op: 'snapshot' }];
  const r = await e2kIn(JSON.stringify(ops), 'step', sid, '--stdin');
  assert.equal(r.code, 11);
  assert.match(r.out, /未执行 1/);
  for (const s of [server.fake.jwt, server.fake.bearer]) assert.ok(!r.out.includes(s) && !r.err.includes(s));
  assert.ok(r.out.includes('[REDACTED]'), 'the page text carried tokens, so the output must show the redaction marker');
  // 内核自己的值没有被脱敏弄坏：会话 id 和失败截图的路径原样在
  assert.ok(r.out.includes(sid));
  assert.ok((await e2k('status')).out.includes(NAME), 'the session name must survive redaction');
  assert.match(r.out, /shots\/\d+\.jpg/);
});

test('the kernel refuses to type into a password field', { timeout: 180_000 }, async () => {
  const runs = [await e2k('step', sid, JSON.stringify([{ op: 'goto', url: origin + '/login.html' }, { op: 'fill', target: '#pw', value: 'not-a-real-password' }]))];
  // 目标是 label、label 里的文字或文字选择器时，Playwright 会改填 label 的 control，也就是同一个密码框
  for (const target of ['#lab', '#sp', 'text=Password']) runs.push(await e2k('step', sid, JSON.stringify([{ op: 'fill', target, value: 'not-a-real-password' }])));
  for (const r of runs) {
    assert.equal(r.code, 11);
    assert.match(r.out, /password-field/);
    assert.ok(!r.out.includes('not-a-real-password') && !r.err.includes('not-a-real-password'));
  }
  const typed = await e2k('step', sid, JSON.stringify([{ op: 'eval', js: 'document.querySelector("#pw").value.length' }]), '--json');
  assert.equal(JSON.parse(typed.out).results[0].output, '0', 'nothing may have been typed into the password field');
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
  const refused = result.actions.filter((a: any) => a.op.op === 'fill').slice(1);
  assert.deepEqual(refused.map((a: any) => a.op.target), ['#pw', '#lab', '#sp', 'text=Password']);
  for (const a of refused) assert.equal(a.op.value, '[REDACTED]');
  assert.ok(post.body.includes('[REDACTED]'), 'the POST body had a password key, so it must show the marker');
  assert.equal(post.status, 200);
  assert.equal(post.decision, 'allowed');
  assert.deepEqual(result.hosts[0], { host: '127.0.0.1', mode: 'default' });
  assert.ok(readdirSync(join(close.runDir, 'shots')).some((f: string) => f.endsWith('.jpg')));
  // 页面标签确实进了记录（不符的 assert 的 actual），是 JSON 字符串；result.json 以外的文件里不许有它的原样。
  const markup = '<script>window.pwned=1</script>';
  assert.ok(result.actions.some((a: any) => a.actual === markup), 'the mismatching assert must carry the page markup as data');
  for (const f of allFilesUnder(close.runDir).filter((p) => !p.endsWith('.jpg'))) {
    const text = readFileSync(f, 'utf8');
    for (const s of [server.fake.jwt, server.fake.bearer, server.fake.password, 'not-a-real-password']) assert.ok(!text.includes(s), `${f} leaks`);
    if (!f.endsWith('result.json')) assert.ok(!text.includes(markup), `${f} carries page markup verbatim`);
  }
  // 内核自己的值没被脱敏弄坏：会话名（36 位十六进制）原样在命令输出、result.json、报告目录和 report.html 里
  assert.equal(result.name, NAME);
  assert.ok(close.runDir.includes(NAME));
  const html = readFileSync(close.reportPath, 'utf8');
  assert.ok(html.includes(NAME), 'the session name must appear in report.html');
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;window.pwned=1&lt;/script&gt;'), 'page markup must be escaped in report.html');
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
