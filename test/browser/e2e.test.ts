import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPlaywrightDriver } from '../../src/drivers/playwright/driver.ts';
import { startKernel } from '../../src/kernel/server.ts';
import type { KernelHandle } from '../../src/kernel/server.ts';
import { call } from '../../src/shared/client.ts';
import { startFixtureServer } from '../support/fixture-server.ts';
import type { FixtureServer } from '../support/fixture-server.ts';
import { makeTmpHome } from '../support/tmp-home.ts';
import { answeringDeny, approving, choosingMode, denying, fakeDialog } from '../support/fake-dialog.ts';
import type { FakeDialog } from '../support/fake-dialog.ts';
import type { DialogRequest, DialogResult } from '../../src/kernel/approval.ts';
import { noFocus } from '../../src/kernel/focus.ts';

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

// 参数固定、不经 shell；input 给了就作为标准输入；h 是内核的 home（默认是本文件共用的那个）。
function e2kAt(h: typeof home, input: string | undefined, ...args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: REPO, env: { ...process.env, E2K_HOME: h.root }, stdio: ['pipe', 'pipe', 'pipe'],
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

function e2kIn(input: string | undefined, ...args: string[]): Promise<Run> {
  return e2kAt(home, input, ...args);
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
  kernel = await startKernel({ focus: noFocus, home, driver: createPlaywrightDriver(), dialog: fakeDialog(approving) });   // 批准走真路径：21 → 假对话框回「批准」→ 原样重试
});

after(async () => {
  try {
    await kernel.stop();   // 幂等；测试中途失败时也要收掉浏览器
  } finally {
    await server.close();
    tmp.cleanup();
  }
});

// 没列明的主机上第一次登录要问模式（三键框）：用自己的内核和 home，不占共用内核的弹框额度（10 分钟 6 个，已被规则测试用满）。
// 21 → 假对话框回「默认」→ 原样重试；这条路和线上一样，测试从不直接写批准记录。
async function loginAfterChoice(h: typeof home, url: string): Promise<{ loginId: string }> {
  const first = await call(h, 'login.begin', { url });
  assert.ok(!first.ok && first.error.code === 'wait-approval', 'the first login on an unlisted host asks for a mode');
  await settle();
  const again = await call(h, 'login.begin', { url });
  assert.ok(again.ok);
  return (again as { result: { loginId: string } }).result;
}

test('a page opened by login leaves its cookie for later sessions', { timeout: 180_000 }, async () => {
  const own = makeTmpHome();
  const k = await startKernel({ focus: noFocus, home: own.home, driver: createPlaywrightDriver(), dialog: fakeDialog(choosingMode('默认')) });
  try {
    const begin = await loginAfterChoice(own.home, origin + '/login.html');
    assert.ok((await call(own.home, 'login.end', begin)).ok);
    const open = JSON.parse((await e2kAt(own.home, undefined, 'open', origin + '/index.html', '--name', 'cookie', '--json')).out);
    assert.equal(open.mode, 'default', 'the choice was "默认"');
    const asserted = await e2kAt(own.home, JSON.stringify([{ op: 'assert', kind: 'text', target: '#login-state', cmp: 'eq', expected: 'signed-in' }]), 'step', open.session, '--stdin');
    assert.equal(asserted.code, 0);
    assert.equal((await e2kAt(own.home, undefined, 'close', open.session)).code, 0);
  } finally {
    await k.stop();
    own.cleanup();
  }
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

test('step --keep-going runs the rest after a failure, keeps the failure shot, and shows session-wide sequence numbers', { timeout: 180_000 }, async () => {
  const s0 = (JSON.parse((await e2k('step', sid, JSON.stringify([{ op: 'snapshot' }]), '--json')).out) as { results: { seq: number }[] }).results[0]!.seq;
  const r = await e2k('step', sid, JSON.stringify([{ op: 'click', target: '#nope' }, { op: 'snapshot' }]), '--keep-going', '--json');
  assert.equal(r.code, 11);
  const out = JSON.parse(r.out) as { tallies: { notRun: number }; results: { outcome: string; seq: number; shot?: string }[] };
  assert.deepEqual(out.results.map((x) => x.outcome), ['failed', 'ok']); assert.equal(out.tallies.notRun, 0);
  assert.match(out.results[0]!.shot ?? '', /shots\/\d+\.jpg/); assert.deepEqual(out.results.map((x) => x.seq), [s0 + 1, s0 + 2]);   // 序号跨批次连续
  const text = await e2k('step', sid, JSON.stringify([{ op: 'snapshot' }]));
  assert.match(text.out, new RegExp(`^#1 序号${s0 + 3} snapshot 完成$`, 'm'));
});

test('the kernel refuses to type into a password field', { timeout: 180_000 }, async () => {
  const runs = [await e2k('step', sid, JSON.stringify([{ op: 'goto', url: origin + '/login.html' }, { op: 'fill', target: '#pw', value: 'not-a-real-password' }]))];
  // 目标是 label、label 里的文字或文字选择器时，Playwright 会改填 label 的 control，也就是同一个密码框
  for (const target of ['#lab', '#sp', 'text=Password']) runs.push(await e2k('step', sid, JSON.stringify([{ op: 'fill', target, value: 'not-a-real-password' }])));
  for (const r of runs) {
    assert.equal(r.code, 20, 'a login wall (20) beats the refused fill (11)');
    assert.match(r.out, /password-field/);
    assert.ok(!r.out.includes('not-a-real-password') && !r.err.includes('not-a-real-password'));
  }
  const typed = await e2k('step', sid, JSON.stringify([{ op: 'eval', js: 'document.querySelector("#pw").value.length' }]), '--json');
  assert.equal(JSON.parse(typed.out).results[0].output, '0', 'nothing may have been typed into the password field');
  // eval 自己把假密码塞进密码框再读出来：agent 的 step 回应照旧拿得到，但这页有密码框，所以记录里不留这个返回值（只留哈希）
  const read = await e2kIn(JSON.stringify([{ op: 'eval', js: `document.querySelector('#pw').value = ${JSON.stringify(server.fake.password)}; document.querySelector('#pw').value` }]), 'step', sid, '--stdin', '--json');
  assert.equal(JSON.parse(read.out).results[0].output, JSON.stringify(server.fake.password), 'the agent still sees what eval returned');
  // 抛错的消息也可能带着页面值：agent 看得到，记录里只有固定文字（最后那次全文件扫描兜住假密码）
  const thrown = await e2kIn(JSON.stringify([{ op: 'eval', js: `throw new Error(document.querySelector('#pw').value)` }]), 'step', sid, '--stdin', '--json');
  assert.equal(JSON.parse(thrown.out).results[0].outcome, 'failed');
  assert.ok(JSON.parse(thrown.out).results[0].error.includes(server.fake.password), 'the agent sees the error text');
});

test('requests from a page with a password field leave no body; other pages are recorded as before', { timeout: 180_000 }, async () => {
  const { email, password, formToken } = server.fake;
  // 跨主机的 sso 页：假账号密码经 stdin 填进去（不进 argv），再提交原生表单。这一步之后的退出码不是本测试要断言的，只看记录。
  assert.equal((await e2kIn(JSON.stringify([{ op: 'goto', url: server.altOrigin + '/sso.html' }]), 'step', sid, '--stdin')).code, 20, 'a visible password field is a login wall');
  const fill = [{ op: 'click', target: '#send-ids' },
    { op: 'eval', js: `document.querySelector('#user').value = ${JSON.stringify(email)}; document.querySelector('#pw').value = ${JSON.stringify(password)}; document.querySelector('#sso').requestSubmit(); 'submitted'` }];
  await e2kIn(JSON.stringify(fill), 'step', sid, '--stdin');
  for (let i = 0; i < 50 && !server.hits.some((h) => h.path === '/api/sso'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(server.hits.some((h) => h.path === '/api/sso' && h.body.includes(encodeURIComponent(password))), 'the form really was submitted');
  // 没有密码框的页面发同样的表单体：照旧记录（脱敏后）
  await e2kIn(JSON.stringify([{ op: 'goto', url: origin + '/profile.html' }, { op: 'click', target: '#send-ids' }]), 'step', sid, '--stdin');
  for (let i = 0; i < 50 && server.hits.filter((h) => h.path === '/api/ids').length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(server.hits.filter((h) => h.path === '/api/ids').length, 2);
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
  // eval：普通页面记脱敏后的返回值和源码哈希；有密码框的页面不记返回值；源码从不进记录
  const evals = result.actions.filter((a: any) => a.op.op === 'eval');
  assert.ok(evals.length >= 3);
  for (const a of evals) { assert.equal(a.op.js, '[REDACTED]'); assert.match(a.jsHash, /^sha256:[0-9a-f]{16}$/); }
  const leak = evals.find((a: any) => typeof a.output === 'string' && a.output.includes('[REDACTED]'));
  assert.ok(leak !== undefined, 'the eval on a page without a password field records its redacted result');
  const threw = evals.filter((a: any) => a.outcome === 'failed');
  assert.ok(threw.length >= 1);
  for (const a of threw) assert.equal(a.error, 'other: eval 抛错（消息未记录）');
  const omitted = evals.filter((a: any) => a.outputOmitted === true);
  assert.ok(omitted.length >= 2, 'evals on the password page record no result');
  for (const a of omitted) assert.equal('output' in a, false);
  assert.equal(post.bodyOmitted, false);
  // 登录页（有密码框）发出的写只记方法、URL、状态；没有密码框的页面发的写照旧记体（脱敏后）
  const allowed: any[] = result.writes.allowed;
  const sso = allowed.find((w) => w.url.endsWith('/api/sso'));
  assert.ok(sso !== undefined && sso.body === null && sso.bodyOmitted === true, 'the native form post from the password page must have no body');
  const ids = allowed.filter((w) => w.url.endsWith('/api/ids'));
  assert.equal(ids.length, 2);
  const fromSso = ids.find((w) => w.pageUrl.endsWith('/sso.html'));
  const fromProfile = ids.find((w) => w.pageUrl.endsWith('/profile.html'));
  assert.ok(fromSso.body === null && fromSso.bodyOmitted === true);
  assert.ok(typeof fromProfile.body === 'string' && fromProfile.body.startsWith('ids=') && fromProfile.bodyOmitted === false);
  assert.equal(post.status, 200);
  assert.equal(post.decision, 'allowed');
  assert.deepEqual(result.hosts[0], { host: '127.0.0.1', mode: 'default' });
  assert.ok(readdirSync(join(close.runDir, 'shots')).some((f: string) => f.endsWith('.jpg')));
  // 页面标签确实进了记录（不符的 assert 的 actual），是 JSON 字符串；result.json 以外的文件里不许有它的原样。
  const markup = '<script>window.pwned=1</script>';
  assert.ok(result.actions.some((a: any) => a.actual === markup), 'the mismatching assert must carry the page markup as data');
  for (const f of allFilesUnder(close.runDir).filter((p) => !p.endsWith('.jpg'))) {
    const text = readFileSync(f, 'utf8');
    for (const s of [server.fake.jwt, server.fake.bearer, server.fake.password, server.fake.email, server.fake.formToken, 'not-a-real-password']) assert.ok(!text.includes(s), `${f} leaks`);
    if (!f.endsWith('result.json')) assert.ok(!text.includes(markup), `${f} carries page markup verbatim`);
  }
  // 内核自己的值没被脱敏弄坏：会话名（36 位十六进制）原样在命令输出、result.json、报告目录和 report.html 里
  assert.equal(result.name, NAME);
  assert.ok(close.runDir.includes(NAME));
  const html = readFileSync(close.reportPath, 'utf8');
  assert.ok(html.includes(NAME), 'the session name must appear in report.html');
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;window.pwned=1&lt;/script&gt;'), 'page markup must be escaped in report.html');
  assert.ok(html.includes('源码哈希') && html.includes('返回值未记录'), 'the report shows the eval hash and says when a result was withheld');
  assert.ok(html.includes('这次动了什么'));
  assert.ok(html.includes('结论与记录不一致'));
});

test('a first navigation that fails leaves no session behind', { timeout: 180_000 }, async () => {
  assert.equal((await e2k('open', 'http://127.0.0.1:9/')).code, 11);
  assert.deepEqual(JSON.parse((await e2k('status', '--json')).out).sessions, []);
});

test('open --touch gives only that session page a coarse pointer, and the report says so', { timeout: 180_000 }, async () => {
  const touch = JSON.parse((await e2k('open', origin + '/index.html', '--touch', '--name', NAME, '--json')).out);
  const plain = JSON.parse((await e2k('open', origin + '/index.html', '--name', NAME, '--json')).out);
  const probe = JSON.stringify([{ op: 'eval', js: "matchMedia('(pointer: coarse)').matches" }]);
  assert.match(JSON.parse((await e2k('step', touch.session, probe, '--json')).out).results[0].output, /true/);
  assert.match(JSON.parse((await e2k('step', plain.session, probe, '--json')).out).results[0].output, /false/);
  for (const [s, want] of [[touch, true], [plain, false]] as const) {
    const close = JSON.parse((await e2k('close', s.session, '--verdict', 'undetermined', '--because', 'probe', '--json')).out);
    assert.equal(JSON.parse(readFileSync(close.resultPath, 'utf8')).start.touch, want);
    if (want) assert.ok(readFileSync(close.reportPath, 'utf8').includes('触屏模拟 是'));
  }
});

// ---- 只读模式（M2a）：真浏览器、真内核、真 CLI ----

// 改过规则以后第一次 open 要人批准：内核得 21，假对话框回「批准」，原样重试才成功（测试从不直接写批准记录）。
// 已经批准过、或这份改动不进待批（文件有错）时第一次就成功，原样返回。
async function openApproved(...args: string[]): Promise<Run> {
  const first = await e2k('open', ...args);
  return first.code === 21 ? e2k('open', ...args) : first;
}

async function loginBeginApproved(url: string): ReturnType<typeof call> {
  const first = await call(home, 'login.begin', { url });
  return !first.ok && first.error.code === 'wait-approval' ? call(home, 'login.begin', { url }) : first;
}

// 写好 rules.json 再跑 fn，无论成败都删掉，不影响后面按顺序跑的测试。删文件也是待批的改动：
// 收尾时开一个探针会话把「删掉」批准掉，下一个测试从「没有规则」干净地开始。
// 弹框额度是 10 分钟 6 个，每个 withRules 用 2 个（写入、删除）：现在三个有效规则的测试正好用满，再加要先看额度。
// fn 失败时原错误优先：探针的失败只在 fn 成功时才抛，不盖掉 fn 的错误。
async function withRules(rules: unknown, fn: () => Promise<void>): Promise<void> {
  writeFileSync(home.rulesFile, typeof rules === 'string' ? rules : JSON.stringify(rules));
  let failed = false;
  let failure: unknown;
  try {
    await fn();
  } catch (e) {
    failed = true;
    failure = e;
  }
  rmSync(home.rulesFile, { force: true });
  try {
    const probe = await openApproved(origin + '/index.html', '--name', 'rules-probe', '--json');
    assert.equal(probe.code, 0, probe.err);
    assert.equal((await e2k('close', JSON.parse(probe.out).session)).code, 0);
  } catch (e) {
    if (!failed) throw e;
  }
  if (failed) throw failure;
}

const readonlyRules = (host: string, loginHosts: string[] = []): unknown => ({ version: 1, rules: [{ match: host, mode: 'readonly' }], loginHosts });

async function until(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  for (let t = 0; !cond(); t += 50) {
    assert.ok(t < ms, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function sessionCount(): Promise<number> {
  return (JSON.parse((await e2k('status', '--json')).out) as { sessions: unknown[] }).sessions.length;
}

const settle = (ms = 500): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function stepJson(session: string, ops: unknown[]): Promise<{ exit: number; writesBlocked: number; notices: string[]; results: { outcome: string; output?: string }[] }> {
  const r = await e2kIn(JSON.stringify(ops), 'step', session, '--stdin', '--json');
  return JSON.parse(r.out);
}

async function closeResult(session: string): Promise<any> {
  const close = JSON.parse((await e2k('close', session, '--verdict', 'undetermined', '--because', 'e2e probe', '--json')).out);
  return JSON.parse(readFileSync(close.resultPath, 'utf8'));
}

test('read-only host: every write path is blocked, a strict query passes, and each block is on record', { timeout: 180_000 }, async () => {
  await withRules(readonlyRules('127.0.0.1'), async () => {
    const from = server.hits.length;
    const before = await sessionCount();
    const gate = await e2k('open', origin + '/ro.html', '--json');
    assert.equal(gate.code, 21, 'a changed rules.json has to be approved first, even a tightening one');
    assert.equal(await sessionCount(), before, 'no page was opened while it waited');
    const open = JSON.parse((await e2k('open', origin + '/ro.html', '--json')).out);   // 假对话框已经回了「批准」：原样重试
    try {
      assert.equal(open.mode, 'readonly');
      const fired = await stepJson(open.session, [{ op: 'click', target: '#fire' }, { op: 'wait', for: { text: 'all-sent' } },
        ...['get:200', 'fetch:403', 'xhr:403', 'beacon:true', 'query:200', 'mutation:403', 'worker:403']
          .map((expected) => ({ op: 'assert', kind: 'text', target: '#out', cmp: 'contains', expected }))]);
      assert.equal(fired.exit, 0, 'GET passes, the strict query reaches the server, every other write gets a 403 (the beacon is only queued)');
      assert.equal(fired.writesBlocked, 5);
      // 原生表单提交：导航回一张写着原因的 403 页面
      const form = await stepJson(open.session, [{ op: 'click', target: '#submit-form' }, { op: 'wait', for: { text: 'blocked by e2k read-only mode' } }]);
      assert.equal(form.exit, 0);
      assert.equal(form.writesBlocked, 1);
      await settle();
      const reached = server.hits.slice(from);
      assert.deepEqual(reached.map((h) => h.path), ['/api/graphql'], 'only the strict query reached the server: no fetch, XHR, beacon, worker, form or mutation');
      assert.match(reached[0]!.body, /query Q/);
    } finally {
      const result = await closeResult(open.session);
      assert.equal(result.start.readonly, false);
      assert.equal(result.modes[0].mode, 'readonly');
      assert.equal(result.modes[0].reason, 'rule');
      assert.equal(result.rules.count, 1);
      const blocked: any[] = result.writes.blocked;
      const reasonOf = (suffix: string): string | undefined => blocked.find((w) => w.url.endsWith(suffix) && (suffix !== '/api/graphql' || w.graphql === 'mutation'))?.reason;
      for (const suffix of ['/api/fetch', '/api/xhr', '/api/beacon', '/api/worker', '/api/form']) assert.equal(reasonOf(suffix), 'method', suffix);
      assert.equal(reasonOf('/api/graphql'), 'graphql-mutation');
      assert.equal(blocked.length, 6, 'the Worker write is on record too');
      for (const w of blocked) { assert.equal(w.decision, 'blocked'); assert.equal(w.mode, 'readonly'); }
      assert.deepEqual(result.writes.allowed.map((w: any) => [w.url.slice(-12), w.graphql]), [['/api/graphql', 'query']]);
      assert.deepEqual(result.writes.blockedSummary.map((r: any) => [r.method, r.reason, r.count]).sort(), [['POST', 'graphql-mutation', 1], ['POST', 'method', 5]]);
    }
  });
});

test('read-only host: a strict query that answers with a redirect is refused at the first hop', { timeout: 180_000 }, async () => {
  await withRules(readonlyRules('127.0.0.1'), async () => {
    const from = server.hits.length;
    const open = JSON.parse((await openApproved(origin + '/index.html', '--json')).out);
    try {
      assert.equal(open.mode, 'readonly');
      const js = "fetch('/r307', { method: 'POST', body: '{\"query\":\"query{a}\"}', headers: { 'content-type': 'application/json' } }).then((r) => r.status, () => 'refused')";
      await stepJson(open.session, [{ op: 'eval', js }]);
      await settle();
      const mine = server.hits.slice(from);
      assert.equal(mine.filter((h) => h.path === '/r307').length, 1, 'the first hop was sent (it is a strict query)');
      assert.equal(mine.filter((h) => h.path === '/api/sink').length, 0, 'the redirect target never got the write');
    } finally {
      const result = await closeResult(open.session);
      const entry = result.writes.blocked.find((w: any) => w.url.endsWith('/r307'));
      assert.ok(entry !== undefined, 'the refused redirect is recorded as a blocked write');
      assert.equal(entry.reason, 'redirected-write');
    }
  });
});

test('open --readonly forces read-only on a host with no rule and keeps it after a goto to another host name', { timeout: 180_000 }, async () => {
  const from = server.hits.length;
  const open = JSON.parse((await e2k('open', origin + '/write-on-load.html', '--readonly', '--json')).out);
  try {
    assert.equal(open.mode, 'readonly');
    await stepJson(open.session, [{ op: 'goto', url: server.altOrigin + '/write-on-load.html' }, { op: 'assert', kind: 'text', target: '#host', cmp: 'eq', expected: 'localhost' }]);
    await settle();
    assert.deepEqual(server.hits.slice(from).filter((h) => h.path === '/api/auto'), [], 'neither host name saw the write');
  } finally {
    const result = await closeResult(open.session);
    assert.equal(result.start.readonly, true);
    assert.equal(result.modes[0].reason, 'forced');
    assert.equal(result.modes[0].mode, 'readonly');
    const auto: any[] = result.writes.blocked.filter((w: any) => w.url.endsWith('/api/auto'));
    assert.deepEqual(auto.map((w) => new URL(w.url).hostname).sort(), ['127.0.0.1', 'localhost']);
  }
  // 对照：没有 --readonly 也没有规则时，同一页的写照常到达
  const plain = JSON.parse((await e2k('open', origin + '/write-on-load.html', '--json')).out);
  try {
    assert.equal(plain.mode, 'default');
    await until('the default-mode write', () => server.hits.slice(from).some((h) => h.path === '/api/auto'));
  } finally {
    await e2k('close', plain.session);
  }
});

test('a broken rules.json makes open fail with a usage error and rule list print the exact error', { timeout: 180_000 }, async () => {
  const broken = '{"version":1,"rules":[{"match":"*.example.com","mode":"nope"}]}';
  await withRules(broken, async () => {
    const open = await e2k('open', origin + '/index.html');
    assert.equal(open.code, 2);
    assert.ok(open.err.includes('规则文件有错'), open.err);
    assert.deepEqual(JSON.parse((await e2k('status', '--json')).out).sessions, [], 'no session was opened');
    const list = await e2k('rule', 'list');
    assert.equal(list.code, 2);
    assert.ok(list.out.includes('mode'), `rule list names the bad field: ${list.out}${list.err}`);
    const json = JSON.parse((await e2k('rule', 'list', '--json')).out);
    assert.equal(typeof json.error, 'string');
    assert.deepEqual(json.rules, []);
  });
  await withRules('{not json', async () => {
    const list = await e2k('rule', 'list');
    assert.equal(list.code, 2);
    assert.match(list.out + list.err, /JSON|json/);
  });
});

test('login window: a write to a loginHost passes, a write back to the read-only host is blocked and counted', { timeout: 180_000 }, async () => {
  await withRules(readonlyRules('127.0.0.1', ['localhost']), async () => {
    const from = server.hits.length;
    const begin = await loginBeginApproved(origin + '/login-writes.html');
    assert.ok(begin.ok);
    const loginId = (begin as { result: { loginId: string } }).result.loginId;
    try {
      await until('the write to the login host', () => server.hits.slice(from).some((h) => h.path === '/api/login'));
      await settle();
    } finally {
      const end = await call(home, 'login.end', { loginId });
      assert.ok(end.ok);
      assert.equal((end as { result: { writesBlocked: number } }).result.writesBlocked, 1);
    }
    const reached = server.hits.slice(from).map((h) => h.path);
    assert.deepEqual(reached, ['/api/login'], '/api/x went to the read-only host and never arrived');
  });
});

test('a popup opened with noopener by a read-only session page is still read-only', { timeout: 180_000 }, async () => {
  const from = server.hits.length;
  const sinkHits = (): number => server.hits.slice(from).filter((h) => h.path === '/api/sink' && h.query.case === 'popup-fetch').length;
  // 对照：默认模式的会话里，同一个弹窗的写照常到达，说明下面的「没到」不是因为弹窗没发或没等够
  const plain = JSON.parse((await e2k('open', origin + '/popup-noopener.html', '--json')).out);
  try {
    await stepJson(plain.session, [{ op: 'click', target: '#open' }]);
    await until('the popup write in default mode', () => sinkHits() === 1);
  } finally {
    await e2k('close', plain.session);
  }
  const open = JSON.parse((await e2k('open', origin + '/popup-noopener.html', '--readonly', '--json')).out);
  try {
    await stepJson(open.session, [{ op: 'click', target: '#open' }]);
    await settle(2500);
    assert.equal(sinkHits(), 1, 'the read-only popup write never arrived (the default-mode control accounts for the one hit)');
  } finally {
    const result = await closeResult(open.session);
    // 实测：noopener 的弹窗 Playwright 仍然归得到会话，写记在 blocked（不是 unattributed），原因 method
    const popup = result.writes.blocked.find((w: any) => w.url.includes('/api/sink'));
    assert.ok(popup !== undefined, JSON.stringify(result.writes));
    assert.equal(popup.reason, 'method');
    assert.equal(popup.mode, 'readonly');
    assert.deepEqual(result.writes.unattributed, []);
  }
});

// 跨组的重定向：用自己的内核和 home（共用内核的弹框额度——10 分钟 6 个——已被前面的规则测试用满）。
// 组 a 是 127.0.0.1，组 b 是 localhost：点链接经 302 从 a 落到 b。
test('a click that is redirected into another group freezes the session: step exits 22, the session refuses everything afterwards, and result.json records other-group', { timeout: 180_000 }, async () => {
  const own = makeTmpHome();
  writeFileSync(own.home.rulesFile, JSON.stringify({ version: 1, rules: [], loginHosts: [], groups: [{ name: 'a', hosts: ['127.0.0.1'] }, { name: 'b', hosts: ['localhost'] }] }));
  const k = await startKernel({ focus: noFocus, home: own.home, driver: createPlaywrightDriver(), dialog: fakeDialog(approving) });
  const run = (input: string | undefined, ...args: string[]): Promise<Run> => e2kAt(own.home, input, ...args);
  try {
    const gate = await run(undefined, 'open', origin + '/cross-hop.html', '--json');
    assert.equal(gate.code, 21, 'the first rules need an approval');
    const open = JSON.parse((await run(undefined, 'open', origin + '/cross-hop.html', '--json')).out);
    assert.equal(open.profile, 'a');
    const from = server.hits.length;
    const ok = await run(JSON.stringify([{ op: 'assert', kind: 'count', target: '#go', cmp: 'eq', expected: 1 }]), 'step', open.session, '--stdin');
    assert.equal(ok.code, 0, 'a step that stays in the group is fine');
    const click = await run(JSON.stringify([{ op: 'click', target: '#go' }, { op: 'snapshot' }]), 'step', open.session, '--stdin');
    assert.equal(click.code, 22, click.out + click.err);
    assert.ok((click.out + click.err).includes('页面经重定向进了组 b 的域名，会话已冻结'), click.out + click.err);
    assert.ok((click.out + click.err).includes('--profile b'), 'the next step names the profile to use');
    const again = await run(JSON.stringify([{ op: 'snapshot' }]), 'step', open.session, '--stdin');
    assert.equal(again.code, 22, 'a frozen session does nothing');
    assert.equal(server.hits.slice(from).length, 0, 'the fixture server saw no write (it only records writes): this proves nothing else about the frozen session');
    const close = JSON.parse((await run(undefined, 'close', open.session, '--verdict', 'undetermined', '--because', 'e2e probe', '--json')).out);
    const result = JSON.parse(readFileSync(close.resultPath, 'utf8'));
    assert.ok(result.writes.blocked.some((w: any) => w.reason === 'other-group' && w.host === 'localhost'), JSON.stringify(result.writes.blocked));
    assert.ok(result.writes.blocked.every((w: any) => w.reason === 'other-group' && w.decision === 'blocked'));
    assert.deepEqual(result.actions.map((a: any) => [a.op.op, a.outcome]), [['assert', 'match'], ['click', 'ok'], ['snapshot', 'not-run']]);
    assert.ok(!result.hosts.some((h: any) => h.host === 'localhost'), 'the landing host does not count as visited');
  } finally {
    await k.stop();
    own.cleanup();
  }
});

// 登录时选「只读」：这个登录窗口自己发出的写（发往 localhost 的 /api/login，和发回本主机的 /api/x）都被拦，之后开这个主机也是只读。
test('login on an unlisted host answered read-only: the window\'s own writes are blocked and counted, and a later open of that host is read-only with the reason on record', { timeout: 180_000 }, async () => {
  const own = makeTmpHome();
  const k = await startKernel({ focus: noFocus, home: own.home, driver: createPlaywrightDriver(), dialog: fakeDialog(choosingMode('只读')) });
  try {
    const from = server.hits.length;
    const begin = await loginAfterChoice(own.home, server.altOrigin + '/login-writes.html');
    await settle(1500);
    const end = await call(own.home, 'login.end', begin);
    assert.ok(end.ok);
    assert.equal((end as { result: { writesBlocked: number } }).result.writesBlocked, 2, 'both automatic POSTs were blocked');
    assert.deepEqual(server.hits.slice(from).map((h) => h.path), [], 'neither write reached the server');
    const open = JSON.parse((await e2kAt(own.home, undefined, 'open', server.altOrigin + '/index.html', '--json')).out);
    assert.equal(open.mode, 'readonly');
    const close = JSON.parse((await e2kAt(own.home, undefined, 'close', open.session, '--verdict', 'undetermined', '--because', 'e2e probe', '--json')).out);
    assert.equal(JSON.parse(readFileSync(close.resultPath, 'utf8')).modes[0].reason, 'host-choice');
  } finally {
    await k.stop();
    own.cleanup();
  }
});

// ---- 域名组、批准、身份探针（M2b）：每条要弹框的用例起自己的内核和 home ----
// 共用内核每 10 分钟只有 6 个弹框的额度，已被前面的规则测试用满；下面每个内核各用各的额度（每条用例开头注明用了几个）。
// 批准一律走真路径：21 → 假对话框作答 → 原样重试；测试从不直接写 approvals.json。

interface Own { h: typeof home; k: KernelHandle; d: FakeDialog; run: (input: string | undefined, ...args: string[]) => Promise<Run>; stop: () => Promise<void> }

async function startOwn(rules: unknown, script?: (r: DialogRequest) => DialogResult | Promise<DialogResult>): Promise<Own> {
  const tmpOwn = makeTmpHome();
  writeFileSync(tmpOwn.home.rulesFile, JSON.stringify(rules));
  const d = fakeDialog(script);
  const k = await startKernel({ focus: noFocus, home: tmpOwn.home, driver: createPlaywrightDriver(), dialog: d });
  return {
    h: tmpOwn.home, k, d,
    run: (input, ...args) => e2kAt(tmpOwn.home, input, ...args),
    stop: async () => { try { await k.stop(); } finally { tmpOwn.cleanup(); } },
  };
}

// 第一次 open 要批准：内核得 21，等假对话框作答，原样重试。
async function openOwn(o: Own, ...args: string[]): Promise<any> {
  const gate = await o.run(undefined, 'open', ...args, '--json');
  assert.equal(gate.code, 21, `the first open asks for an approval: ${gate.out}${gate.err}`);
  await settle();
  const r = await o.run(undefined, 'open', ...args, '--json');
  assert.equal(r.code, 0, r.out + r.err);
  return JSON.parse(r.out);
}

async function stepOwn(o: Own, session: string, ops: unknown[], ...extra: string[]): Promise<Run> {
  return o.run(JSON.stringify(ops), 'step', session, '--stdin', '--json', ...extra);
}

async function closeOwn(o: Own, session: string): Promise<any> {
  const close = JSON.parse((await o.run(undefined, 'close', session, '--verdict', 'undetermined', '--because', 'e2e probe', '--json')).out);
  return JSON.parse(readFileSync(close.resultPath, 'utf8'));
}

const twoGroups = { version: 1, rules: [], loginHosts: [], groups: [{ name: 'a', hosts: ['127.0.0.1'] }, { name: 'b', hosts: ['localhost'] }] };

// 弹框数：1（规则）。这一条之外，「经 302 进别组」已由上面那条冻结用例覆盖（Task 7）：这里是点链接直接去别组的域名，没有重定向。
test('a link straight into another group is answered with a 403 and the group to use; the session stays usable and result.json records other-group', { timeout: 180_000 }, async () => {
  const o = await startOwn(twoGroups, approving);
  try {
    const open = await openOwn(o, origin + '/cross-link.html');
    assert.equal(open.profile, 'a');
    const from = server.hits.length;
    const click = JSON.parse((await stepOwn(o, open.session, [{ op: 'click', target: '#go' }, { op: 'assert', kind: 'text', target: 'body', cmp: 'contains', expected: '这个域名属于组 b' }])).out);
    assert.equal(click.exit, 0, 'the refused navigation is answered, not a failure: the 403 page is what the browser shows');
    assert.ok(click.notices.some((n: string) => n.includes('这个域名属于组 b，当前 profile 是组 a 的。请用 --profile b 另开会话。')), JSON.stringify(click.notices));
    assert.equal(click.writesBlocked, 1, 'the refused navigation counts as a blocked request');
    const again = await stepOwn(o, open.session, [{ op: 'snapshot' }]);
    assert.equal(again.code, 0, 'a refused hop is not a redirect: the session is not frozen');
    assert.equal(server.hits.slice(from).length, 0, 'no write reached the server');
    const result = await closeOwn(o, open.session);
    const blocked: any[] = result.writes.blocked;
    assert.ok(blocked.some((w) => w.reason === 'other-group' && w.host === 'localhost' && w.decision === 'blocked'), JSON.stringify(blocked));
    assert.ok(blocked.every((w) => w.reason === 'other-group'));
    assert.ok(!result.hosts.some((h: any) => h.host === 'localhost'), 'the refused host does not count as visited');
    assert.equal(o.d.requests.length, 1, 'one dialog: the rules');
  } finally {
    await o.stop();
  }
});

// 弹框数：1（规则）。
test('--profile a/t1 makes the profile directory a@t1 (0700) and status lists it after default', { timeout: 180_000 }, async () => {
  const o = await startOwn(twoGroups, approving);
  try {
    const open = await openOwn(o, origin + '/index.html', '--profile', 'a/t1');
    assert.equal(open.profile, 'a@t1');
    const dir = join(o.h.profilesDir, 'a@t1');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.ok(!existsSync(join(o.h.profilesDir, 'a')), 'the plain group profile was not created');
    const status = JSON.parse((await o.run(undefined, 'status', '--json')).out);
    assert.deepEqual(status.profiles.map((p: any) => p.name), ['default', 'a@t1']);
    assert.equal(status.profiles[1].state, 'launched');
    assert.match((await o.run(undefined, 'status')).out, /profile a@t1 /);
    assert.equal((await o.run(undefined, 'close', open.session)).code, 0);
    assert.equal(o.d.requests.length, 1, 'one dialog: the rules');
  } finally {
    await o.stop();
  }
});

// 弹框数：1（规则，被拒）。
test('a refused rules change is a usage error, nothing opens, and the same change is not asked again', { timeout: 180_000 }, async () => {
  const o = await startOwn({ version: 1, rules: [{ match: '127.0.0.1', mode: 'readonly' }], loginHosts: [] }, denying);
  try {
    const gate = await o.run(undefined, 'open', origin + '/ro.html');
    assert.equal(gate.code, 21);
    await settle();
    const denied = await o.run(undefined, 'open', origin + '/ro.html');
    assert.equal(denied.code, 2, denied.out + denied.err);
    assert.ok((denied.out + denied.err).includes('人拒绝了这次规则改动'), denied.out + denied.err);
    const third = await o.run(undefined, 'open', origin + '/ro.html');
    assert.equal(third.code, 2, 'asking again changes nothing');
    assert.equal(o.d.requests.length, 1, 'the same change is not shown a second time');
    assert.deepEqual(JSON.parse((await o.run(undefined, 'status', '--json')).out).sessions, [], 'no page was ever opened');
    const list = JSON.parse((await o.run(undefined, 'rule', 'list', '--json')).out);
    assert.equal(list.approved, false);
    assert.equal(list.pending, true, 'the file stays unapproved');
  } finally {
    await o.stop();
  }
});

// 弹框数：1（规则，弹不出）。fakeDialog() 缺省回 unavailable。
test('a rules change whose dialog cannot be shown ends in exit 22 and stays 22', { timeout: 180_000 }, async () => {
  const o = await startOwn({ version: 1, rules: [{ match: '127.0.0.1', mode: 'readonly' }], loginHosts: [] });
  try {
    const gate = await o.run(undefined, 'open', origin + '/ro.html');
    assert.equal(gate.code, 21);
    await settle();
    const unavailable = await o.run(undefined, 'open', origin + '/ro.html');
    assert.equal(unavailable.code, 22, unavailable.out + unavailable.err);
    assert.ok((unavailable.out + unavailable.err).includes('弹不出批准框'), unavailable.out + unavailable.err);
    assert.equal((await o.run(undefined, 'open', origin + '/ro.html')).code, 22, 'a dialog that cannot be shown does not come back by retrying');
    assert.equal(o.d.requests.length, 1);
    assert.deepEqual(JSON.parse((await o.run(undefined, 'status', '--json')).out).sessions, []);
  } finally {
    await o.stop();
  }
});

// 弹框数：3（规则批准、放行声明批准、另一条放行声明被拒）。
test('group a is read-only with a readPosts endpoint: that POST arrives, any other is blocked, and step --allow needs 21, an approval and a retry (a refused one never arrives)', { timeout: 180_000 }, async () => {
  const rules = {
    version: 1, rules: [{ match: '127.0.0.1', mode: 'readonly' }], loginHosts: [],
    groups: [{ name: 'a', hosts: ['127.0.0.1'], readPosts: [{ method: 'POST', url: origin + '/api/read-posts' }] }],
  };
  // 规则框按「批准」，放行框按「放行」（approving 只认「批准」键，放行框里没有，会按「拒绝」）
  const allowing = (r: DialogRequest): DialogResult => (r.buttons.includes('放行') ? { kind: 'button', button: '放行' } : approving(r));
  let answer: (r: DialogRequest) => DialogResult = allowing;
  const o = await startOwn(rules, (r) => answer(r));
  const hitsOf = (path: string): number => server.hits.filter((h) => h.path === path).length;
  try {
    const open = await openOwn(o, origin + '/declare.html');
    assert.equal(open.mode, 'readonly');
    const first = JSON.parse((await stepOwn(o, open.session, [
      { op: 'click', target: '#read' }, { op: 'wait', for: { text: 'read:200' } },
      { op: 'click', target: '#other' }, { op: 'wait', for: { text: 'other:403' } },
    ])).out);
    assert.equal(first.exit, 0);
    await settle();
    assert.equal(hitsOf('/api/read-posts'), 1, 'the readPosts endpoint got its POST');
    assert.equal(hitsOf('/api/other'), 0, 'every other POST was blocked');

    // 放行声明：第一次 21 且一个操作都不执行
    const allow = JSON.stringify([{ method: 'POST', url: origin + '/api/declared' }]);
    const clickDeclared = [{ op: 'click', target: '#declared' }, { op: 'wait', for: { text: 'declared:200' } }];
    const gate = await stepOwn(o, open.session, clickDeclared, '--allow', allow);
    assert.equal(gate.code, 21, gate.out + gate.err);
    await settle();
    assert.equal(hitsOf('/api/declared'), 0, 'nothing ran while the approval was pending');
    const ok = await stepOwn(o, open.session, clickDeclared, '--allow', allow);   // 假对话框回了「放行」：原样重试
    assert.equal(ok.code, 0, ok.out + ok.err);
    await settle();
    assert.equal(hitsOf('/api/declared'), 1, 'the approved declaration let the POST through');
    const shown = o.d.requests[1]!;
    assert.equal(shown.title.startsWith('e2k：放行写请求'), true);
    assert.ok(shown.lines.some((l) => l.includes(`POST ${origin}/api/declared`)), 'the dialog shows the normalised method and URL');

    // 另一条声明被人拒：重试是 usage，点击没有执行
    answer = denying;
    const denyAllow = JSON.stringify([{ method: 'POST', url: origin + '/api/denied' }]);
    const clickDenied = [{ op: 'click', target: '#denied' }, { op: 'wait', for: { text: 'denied:' } }];
    assert.equal((await stepOwn(o, open.session, clickDenied, '--allow', denyAllow)).code, 21);
    await settle();
    const refused = await stepOwn(o, open.session, clickDenied, '--allow', denyAllow);
    assert.equal(refused.code, 2, refused.out + refused.err);
    assert.ok((refused.out + refused.err).includes('人拒绝了这些放行声明'));
    await settle();
    assert.equal(hitsOf('/api/denied'), 0, 'a refused declaration lets nothing through');

    const result = await closeOwn(o, open.session);
    assert.deepEqual(result.declarations.map((d: any) => [d.method, d.url.slice(-13), d.approved]), [['POST', '/api/declared', 'dialog']]);
    assert.equal(o.d.requests.length, 3, 'three dialogs: rules, declaration, refused declaration');
  } finally {
    await o.stop();
  }
});

// 弹框数：1（规则）。
test('an identity probe that does not match: open still hands the page over, the next step exits 22 and its click never reaches the server; a matching page is the control', { timeout: 180_000 }, async () => {
  const rules = { version: 1, rules: [], loginHosts: [], groups: [{ name: 'a', hosts: ['127.0.0.1'], identity: { selector: '#who', expect: 'Test Tenant' } }] };
  const o = await startOwn(rules, approving);
  const fired = (): number => server.hits.filter((h) => h.path === '/api/identity-fired').length;
  const click = [{ op: 'click', target: '#fire' }];
  try {
    // 对照：身份对得上，step 的点击照常发出去（默认模式，写都放行）
    const good = await openOwn(o, origin + '/identity.html?who=Test%20Tenant');
    assert.equal(good.identity, 'ok');
    assert.equal((await stepOwn(o, good.session, click)).code, 0);
    await until('the control click to arrive', () => fired() === 1);
    assert.equal((await o.run(undefined, 'close', good.session)).code, 0);

    const bad = JSON.parse((await o.run(undefined, 'open', origin + '/identity.html?who=Other%20Tenant', '--json')).out);
    assert.equal(bad.identity, 'mismatch', 'open reports the mismatch so a person sees it');
    const step = await stepOwn(o, bad.session, click);
    assert.equal(step.code, 22, step.out + step.err);
    assert.ok((step.out + step.err).includes('身份探针不符'), step.out + step.err);
    await settle();
    assert.equal(fired(), 1, 'the click of the refused step never reached the server (only the control hit is there)');
    assert.equal((await stepOwn(o, bad.session, [{ op: 'snapshot' }])).code, 22, 'the session keeps refusing');
    const result = await closeOwn(o, bad.session);
    assert.equal(result.identity.mismatch, true);
    assert.deepEqual(result.actions.map((a: any) => a.op.op), [], 'no operation of a refused step is on record');
    assert.equal(o.d.requests.length, 1, 'one dialog: the rules');
  } finally {
    await o.stop();
  }
});

// 弹框数：1（规则）。终审 I-6：身份元素还没渲染出来（单页应用异步渲染页头）不能把会话永久判死。
test('an identity element that is not on the page yet does not kill the session: open and an early step answer 22 and run nothing, the step after it rendered goes through', { timeout: 180_000 }, async () => {
  const rules = { version: 1, rules: [], loginHosts: [], groups: [{ name: 'a', hosts: ['127.0.0.1'], identity: { selector: '#who', expect: 'Test Tenant' } }] };
  const o = await startOwn(rules, approving);
  const fired = (): number => server.hits.filter((h) => h.path === '/api/identity-fired').length;
  const click = [{ op: 'click', target: '#fire' }];
  const base = fired();   // 服务端的记录在整份文件里共用
  try {
    const warm = await openOwn(o, origin + '/identity.html?who=Test%20Tenant');   // 第一次 open 要先过规则的批准框（21 → 批准 → 重试）
    assert.equal(warm.identity, 'ok');
    assert.equal((await o.run(undefined, 'close', warm.session)).code, 0);
    const run = await o.run(undefined, 'open', origin + '/identity.html?who=Test%20Tenant&delay=2500', '--json');
    assert.equal(run.code, 22, run.out + run.err);
    const early = JSON.parse(run.out);
    assert.equal(early.identity, 'mismatch', 'open reports it so that a person sees it');
    const step = await stepOwn(o, early.session, click);
    assert.equal(step.code, 22, step.out + step.err);
    assert.ok(!(step.out + step.err).includes('身份探针不符'), 'not a confirmed mismatch');
    await settle();
    assert.equal(fired(), base, 'the click of the refused step never reached the server');
    await settle(2600);   // 页头渲染出来了
    const late = await stepOwn(o, early.session, click);
    assert.equal(late.code, 0, late.out + late.err);
    await until('the click to arrive', () => fired() === base + 1);
    const result = await closeOwn(o, early.session);
    assert.equal(result.identity.mismatch, false);
  } finally {
    await o.stop();
  }
});

// 弹框数：1（规则）。deny 主机的导航要 abort，不回 403 页：回的页面会提交在 deny 主机的源上，脚本能读写那个源的存储（R4a）。
test('a navigation into a deny host commits nothing on the deny origin', { timeout: 180_000 }, async () => {
  const o = await startOwn({ version: 1, rules: [{ match: 'localhost', mode: 'deny' }], loginHosts: [] }, approving);
  try {
    const open = await openOwn(o, origin + '/index.html');
    const from = server.hits.length;
    const denyOrigin = server.altOrigin;
    // 表单 POST 的顶层导航：不提交，deny 主机的服务端什么都没收到（fixture 只记写，所以用 POST 来证明请求没发出去）
    const post = JSON.parse((await stepOwn(o, open.session, [
      { op: 'eval', js: `const f = document.createElement('form'); f.method = 'post'; f.action = ${JSON.stringify(denyOrigin + '/api/save')}; f.innerHTML = '<input name="x" value="1">'; document.body.append(f); f.submit(); 'submitted'` },
      { op: 'wait', for: { ms: 500 } },
    ])).out);
    assert.equal(post.results[0].outcome, 'ok', JSON.stringify(post));
    assert.equal(server.hits.slice(from).length, 0, 'no request to the deny host reached the server');
    // goto 一个 deny 地址：被拦，这一步失败；之后页面不在 deny 主机的源上（停在默认主机，或浏览器自己的错误页，源是 null），deny 源里什么都没提交
    const go = JSON.parse((await stepOwn(o, open.session, [{ op: 'goto', url: denyOrigin + '/index.html' }])).out);
    assert.notEqual(go.results[0].outcome, 'ok', JSON.stringify(go.results));
    assert.ok(go.notices.some((n: string) => n.includes('这个域名是「不允许」的，没经批准不能打开')), JSON.stringify(go.notices));
    const probe = JSON.parse((await stepOwn(o, open.session, [
      { op: 'eval', js: 'location.origin' },
      { op: 'eval', js: "(() => { try { localStorage.setItem('k', 'v'); return location.origin + ':stored'; } catch { return 'blocked'; } })()" },
      { op: 'eval', js: 'location.href' },
    ])).out);
    assert.equal(probe.exit, 0, JSON.stringify(probe));
    for (const r of probe.results) assert.ok(!String(r.output).includes('localhost'), `the page is not on the deny origin: ${r.output}`);
    assert.ok(String(probe.results[0].output).includes(origin) || String(probe.results[0].output).includes('null'), `default host or an error page: ${probe.results[0].output}`);
    const again = await stepOwn(o, open.session, [{ op: 'snapshot' }]);
    assert.equal(again.code, 0, 'the session is still usable and not frozen');
    const result = await closeOwn(o, open.session);
    const blocked: any[] = result.writes.blocked;
    assert.ok(blocked.length >= 2 && blocked.every((w) => w.reason === 'denied' && w.decision === 'blocked' && w.host === 'localhost'), JSON.stringify(blocked));
    assert.ok(!result.hosts.some((h: any) => h.host === 'localhost'), 'the deny host does not count as visited');
    assert.equal(o.d.requests.length, 1, 'one dialog: the rules');
  } finally {
    await o.stop();
  }
});

// ---- deny 模式、save-case → run、MCP 壳（M3）：各用各的内核和 home，对话框脚本自己编排 ----

// open 要过几道框（规则、deny）：21 就等假对话框作答再原样重试，最多重试 4 次。返回最后一次的结果。
async function openThrough(o: Own, ...args: string[]): Promise<Run> {
  let r = await o.run(undefined, 'open', ...args, '--json');
  for (let i = 0; i < 4 && r.code === 21; i++) {
    await settle();
    r = await o.run(undefined, 'open', ...args, '--json');
  }
  return r;
}

const denyRules = (host: string): unknown => ({ version: 1, rules: [{ match: host, mode: 'deny' }], loginHosts: [] });
const hitsOf = (path: string): number => server.hits.filter((h) => h.path === path).length;

// 弹框数：拒绝的内核 2（规则、deny），另一个内核 3（规则、只读、可写）。被人拒过的 deny 请求一分钟内不再问，所以拒绝单独用一个内核。
test('a deny host is not opened without a person; 只读 opens it read-only; 可写 lets exactly the declared write through', { timeout: 180_000 }, async () => {
  const allow = JSON.stringify([{ method: 'POST', url: origin + '/api/declared' }]);
  const click = (id: string): unknown[] => [{ op: 'click', target: '#' + id }, { op: 'wait', for: { text: id + ':' } }];
  const from = server.hits.length;
  const declaredBase = hitsOf('/api/declared');   // 服务端的记录在整份文件里共用：前面的组测试也打过 /api/declared
  const otherBase = hitsOf('/api/other');

  // 人拒绝：没有会话、没有一个请求到达服务端
  const no = await startOwn(denyRules('127.0.0.1'), answeringDeny('拒绝'));
  try {
    const refused = await openThrough(no, origin + '/declare.html', '--allow', allow);
    assert.equal(refused.code, 2, refused.out + refused.err);
    assert.ok((refused.out + refused.err).includes('人拒绝了打开这个不允许的域名'), refused.out + refused.err);
    assert.equal(JSON.parse((await no.run(undefined, 'status', '--json')).out).sessions.length, 0, 'a refused open leaves no session');
    assert.equal(server.hits.slice(from).length, 0, 'nothing reached the server');
    assert.ok(no.d.requests.some((r) => r.title.startsWith('e2k：打开不允许的域名') && r.buttons[0] === '拒绝'), 'the deny dialog was shown, 拒绝 first');
  } finally {
    await no.stop();
  }

  let answer: (r: DialogRequest) => DialogResult = answeringDeny('只读');
  const o = await startOwn(denyRules('127.0.0.1'), (r) => answer(r));
  try {
    // 人选「只读」：会话开了，声明的写照样被拦
    const ro = await openThrough(o, origin + '/declare.html', '--allow', allow, '--name', 'deny-readonly');
    assert.equal(ro.code, 0, ro.out + ro.err);
    const roOpen = JSON.parse(ro.out);
    const roStep = JSON.parse((await stepOwn(o, roOpen.session, click('declared'))).out);
    assert.equal(roStep.exit, 0, JSON.stringify(roStep));
    await settle();
    assert.equal(hitsOf('/api/declared'), declaredBase, '只读 blocks even the declared write');
    assert.equal((await closeOwn(o, roOpen.session)).start.deny.allow.length, 0, 'the list does nothing under 只读');

    // 人选「可写」：只有清单里的那条写到达，别的写照样被拦
    answer = answeringDeny('可写');
    const rw = await openThrough(o, origin + '/declare.html', '--allow', allow, '--name', 'deny-writable');
    assert.equal(rw.code, 0, rw.out + rw.err);
    const rwOpen = JSON.parse(rw.out);
    const rwStep = JSON.parse((await stepOwn(o, rwOpen.session, [...click('declared'), ...click('other')])).out);
    assert.equal(rwStep.exit, 0, JSON.stringify(rwStep));
    await settle();
    const result = await closeOwn(o, rwOpen.session);
    assert.equal(hitsOf('/api/declared'), declaredBase + 1, 'the declared write arrived');
    assert.equal(hitsOf('/api/other'), otherBase, 'any other write was blocked');
    assert.equal(result.start.deny.allow.length, 1);
    assert.deepEqual(result.writes.allowed.map((w: any) => [w.method, w.allowedBy]), [['POST', 'declared']]);
    assert.ok(result.writes.blocked.length === 1 && result.writes.blocked[0].url.endsWith('/api/other'), JSON.stringify(result.writes.blocked));
  } finally {
    await o.stop();
  }
});

// 弹框数：1（规则）。默认主机是 localhost，deny 的是 127.0.0.1。顶层导航进 deny 主机在 R4a 里是 abort，不是 403 页：页面留在原地，会话照常用。
test('a link from a default page into the deny host is refused, nothing commits on the deny origin and the session goes on', { timeout: 180_000 }, async () => {
  const o = await startOwn(denyRules('127.0.0.1'), approving);
  try {
    const open = await openOwn(o, server.altOrigin + '/index.html');
    assert.equal(open.grant, null, 'the session is not on a deny host');
    const from = server.hits.length;
    const click = JSON.parse((await stepOwn(o, open.session, [
      { op: 'eval', js: `const a = document.createElement('a'); a.id = 'to-deny'; a.href = ${JSON.stringify(origin + '/index.html')}; a.textContent = 'deny'; document.body.append(a); 'added'` },
      { op: 'click', target: '#to-deny' },
      { op: 'wait', for: { ms: 500 } },
      { op: 'eval', js: 'location.origin' },
    ])).out);
    assert.ok(click.notices.some((n: string) => n.includes('这个域名是「不允许」的，没经批准不能打开')), JSON.stringify(click.notices));
    const where = String(click.results[3].output);
    assert.ok(!where.includes('127.0.0.1'), `the page is not on the deny origin: ${where}`);   // 停在原地，或浏览器自己的错误页（源是 null）
    assert.equal(server.hits.slice(from).length, 0, 'no write reached the server');
    const again = await stepOwn(o, open.session, [{ op: 'goto', url: server.altOrigin + '/index.html' }, { op: 'text', target: 'h1' }]);
    assert.equal(again.code, 0, 'the session is not frozen: ' + again.out + again.err);
    assert.equal(JSON.parse(again.out).results[1].output, 'Items');
    const result = await closeOwn(o, open.session);
    const blocked: any[] = result.writes.blocked;
    assert.ok(blocked.length >= 1 && blocked.every((w) => w.reason === 'denied' && w.decision === 'blocked' && w.host === '127.0.0.1'), JSON.stringify(blocked));
    assert.ok(!result.hosts.some((h: any) => h.host === '127.0.0.1'), 'the deny host does not count as visited');
    assert.equal(o.d.requests.length, 1, 'one dialog: the rules');
  } finally {
    await o.stop();
  }
});

// 弹框数：1（规则）。R18：默认主机上的页面发往没授权的 deny 主机的请求，不分方法、不分 fetch 还是 iframe，一律拦。
// 用 no-cors 的简单请求：要是放行，浏览器没有预检拦着，POST 会直接到服务端，fixture 的写记录里就会有它（no-cors 的回应是不透明的，fetch 本身成败不说明什么，所以看服务端和报告）。
test('a page on a default host cannot reach the deny host through fetch or an iframe', { timeout: 180_000 }, async () => {
  const o = await startOwn(denyRules('127.0.0.1'), approving);
  try {
    const open = await openOwn(o, server.altOrigin + '/index.html');
    const from = server.hits.length;
    const probe = JSON.parse((await stepOwn(o, open.session, [
      { op: 'eval', js: `fetch(${JSON.stringify(origin + '/api/r18')}, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: 'x' }).then(() => 'settled', () => 'settled')` },
      { op: 'eval', js: `fetch(${JSON.stringify(origin + '/index.html?r18=get')}, { mode: 'no-cors' }).then(() => 'settled', () => 'settled')` },
      { op: 'eval', js: `(() => { const f = document.createElement('iframe'); f.id = 'deny-frame'; f.src = ${JSON.stringify(origin + '/index.html?r18=frame')}; document.body.append(f); return 'added'; })()` },
      { op: 'eval', js: `fetch(${JSON.stringify(server.altOrigin + '/api/r18-control')}, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: 'x' }).then(() => 'settled', () => 'settled')` },   // 对照：同样的请求发往默认主机，会到达
      { op: 'wait', for: { ms: 800 } },
    ])).out);
    assert.equal(probe.exit, 0, JSON.stringify(probe));
    assert.deepEqual(server.hits.slice(from).map((h) => h.path), ['/api/r18-control'], 'only the control write reached the server');
    const result = await closeOwn(o, open.session);
    const blocked: any[] = result.writes.blocked;
    for (const [method, needle] of [['POST', '/api/r18'], ['GET', 'r18=get'], ['GET', 'r18=frame']] as const) {
      assert.ok(blocked.some((w) => w.method === method && String(w.url).includes(needle) && w.reason === 'denied' && w.host === '127.0.0.1' && w.decision === 'blocked'), `${method} ${needle} is on record as denied: ${JSON.stringify(blocked)}`);
    }
    assert.ok(!result.hosts.some((h: any) => h.host === '127.0.0.1'), 'the deny host does not count as visited');
  } finally {
    await o.stop();
  }
});

// 弹框数：1（规则）。用例文件放在状态目录之外的临时目录里。
test('save-case then run reproduces the session and the second report says pass', { timeout: 180_000 }, async () => {
  const o = await startOwn(denyRules('example.org'), approving);
  const dir = mkdtempSync(join(tmpdir(), 'e2k-case-'));
  const caseFile = join(dir, 'case.json');
  const base = hitsOf('/api/items');   // 服务端的记录在整份文件里共用
  try {
    const first = await openThrough(o, origin + '/index.html', '--name', 'orig');
    assert.equal(first.code, 0, first.out + first.err);
    const sid1: string = JSON.parse(first.out).session;
    const steps = [
      { op: 'fill', target: '#new-item', value: 'Gamma' },
      { op: 'click', target: '[data-testid="add"]' },
      { op: 'assert', kind: 'text', target: '#status', cmp: 'contains', expected: 'Added' },
    ];
    const ran = JSON.parse((await stepOwn(o, sid1, steps)).out);
    assert.equal(ran.exit, 0, JSON.stringify(ran));
    const result1 = await closeOwn(o, sid1);
    await until('the original write to arrive', () => hitsOf('/api/items') === base + 1);

    const saved = await o.run(undefined, 'save-case', sid1, '--out', caseFile, '--json');
    assert.equal(saved.code, 0, saved.out + saved.err);
    const file = JSON.parse(readFileSync(caseFile, 'utf8'));
    assert.equal(file.e2kCase, 1);
    assert.deepEqual(file.steps.map((x: any) => x.op.op), ['fill', 'click', 'assert']);
    assert.equal(file.containsWrites, true);
    assert.equal((await o.run(undefined, 'save-case', sid1, '--out', caseFile)).code, 2, 'an existing file is not overwritten');

    const replay = await o.run(undefined, 'run', caseFile, '--name', 'replayed', '--json');
    assert.equal(replay.code, 0, replay.out + replay.err);
    const out = JSON.parse(replay.out);
    assert.equal(out.verdict, 'pass');
    assert.notEqual(out.session, sid1, 'the replay is a new session');
    await until('the replayed write to arrive', () => hitsOf('/api/items') === base + 2);
    const result2 = JSON.parse(readFileSync(join(dirname(out.reportPath), 'result.json'), 'utf8'));
    assert.equal(result2.session, out.session);
    assert.equal(result2.verdict.value, 'pass');
    assert.deepEqual(result2.actions.map((a: any) => a.op.op), result1.actions.map((a: any) => a.op.op), 'the same operations ran');
    assert.deepEqual(result2.actions.map((a: any) => a.outcome), result1.actions.map((a: any) => a.outcome));
    assert.equal(result2.name, 'replayed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await o.stop();
  }
});

// 弹框数：1（规则）。MCP 壳是单独的子进程，连测试进程里的内核；stdout 只许有协议消息，逐行解析，数一数行数。
test('the MCP shell over stdio: initialize, tools/list, open, step, close against the running kernel', { timeout: 180_000 }, async () => {
  const o = await startOwn(denyRules('example.org'), approving);
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd: REPO, env: { ...process.env, E2K_HOME: o.h.root }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const waiting = new Map<number, (m: any) => void>();
  const messages: any[] = [];
  let buf = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      const m = JSON.parse(line);   // 不是 JSON 的行在这里就抛：stdout 不许有协议之外的东西
      messages.push(m);
      waiting.get(m.id)?.(m);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
  const exited = new Promise<number | null>((resolve) => { child.once('close', (code) => resolve(code)); });
  child.stdin.on('error', () => {});
  let nextId = 0;
  const rpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { reject(new Error(`no answer to ${method}: ${err}`)); }, 60_000);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
  const callTool = async (name: string, args: unknown): Promise<{ isError: boolean; body: any }> => {
    const m = await rpc('tools/call', { name, arguments: args });
    assert.equal(m.error, undefined, JSON.stringify(m));
    assert.equal(m.result.content.length, 1);
    assert.equal(m.result.content[0].type, 'text');
    return { isError: m.result.isError, body: JSON.parse(m.result.content[0].text) };
  };
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'e2k');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');   // 通知：没有回应

    const list = await rpc('tools/list');
    const names: string[] = list.result.tools.map((t: any) => t.name);
    assert.deepEqual([...names].sort(), ['close', 'doctor', 'open', 'rule_list', 'run', 'save_case', 'status', 'step']);
    assert.ok(list.result.tools.every((t: any) => typeof t.description === 'string' && t.inputSchema.type === 'object'));

    // 第一次 open 要过规则的批准框：exit 21 是正常结果（isError 不置位），等假对话框作答再原样重试
    const gate = await callTool('open', { url: origin + '/index.html', name: 'mcp-session' });
    assert.equal(gate.body.exit, 21, JSON.stringify(gate.body));
    assert.equal(gate.isError, false);
    await settle();
    const opened = await callTool('open', { url: origin + '/index.html', name: 'mcp-session' });
    assert.equal(opened.body.exit, 0, JSON.stringify(opened.body));
    assert.equal(opened.isError, false);
    const session: string = opened.body.result.session;
    assert.match(session, /^s-[0-9a-f]{6}$/);

    const step = await callTool('step', { session, ops: [{ op: 'click', target: '#save' }, { op: 'assert', kind: 'text', target: '#status', cmp: 'contains', expected: 'Saved' }] });
    assert.equal(step.body.exit, 0, JSON.stringify(step.body));
    assert.equal(step.body.result.tallies.match, 1);

    const bad = await callTool('step', { session, ops: [], extra: 1 });   // 多余的键：用法错误，工具结果里 isError，不是协议错误
    assert.equal(bad.body.exit, 2);
    assert.equal(bad.isError, true);

    const closed = await callTool('close', { session, verdict: 'undetermined', because: 'e2e probe' });
    assert.equal(closed.body.exit, 0, JSON.stringify(closed.body));
    const result = JSON.parse(readFileSync(closed.body.result.resultPath, 'utf8'));
    assert.equal(result.session, session);
    assert.deepEqual(result.actions.map((a: any) => a.op.op), ['click', 'assert']);

    const doctor = await callTool('doctor', {});   // 自检会往 stderr 写诊断也好、不写也好：stdout 上不能多出东西
    assert.equal(typeof doctor.body.exit, 'number');

    // 通知之后服务还在答；未知方法按 JSON-RPC 回错误，之后照常服务
    const unknown = await rpc('nope/nothing');
    assert.equal(unknown.error.code, -32601);
    assert.equal((await rpc('ping')).error, undefined);

    child.stdin.end();   // 关掉标准输入：服务收尾退出
    assert.equal(await exited, 0, err);
    assert.equal(buf, '', 'no partial line left on stdout');
    assert.equal(lines.length, nextId, 'one stdout line per request, nothing else');
    assert.ok(messages.every((m) => m.jsonrpc === '2.0' && typeof m.id === 'number'), 'every stdout line is a protocol response');
  } finally {
    child.kill();
    await exited;
    await o.stop();
  }
});

test('permissions and shutdown', { timeout: 180_000 }, async () => {
  assert.equal(statSync(home.root).mode & 0o777, 0o700);
  assert.equal(statSync(home.socket).mode & 0o777, 0o600);
  assert.equal(statSync(join(home.profilesDir, 'default')).mode & 0o777, 0o700);
  await kernel.stop();
  assert.ok(!existsSync(home.socket));
  assert.equal((await e2k('status')).code, 22);
});
