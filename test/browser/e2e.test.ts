import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPlaywrightDriver } from '../../src/drivers/playwright/driver.ts';
import { startKernel } from '../../src/kernel/server.ts';
import type { KernelHandle } from '../../src/kernel/server.ts';
import { call } from '../../src/shared/client.ts';
import { startFixtureServer } from '../support/fixture-server.ts';
import type { FixtureServer } from '../support/fixture-server.ts';
import { makeTmpHome } from '../support/tmp-home.ts';
import { approving, choosingMode, fakeDialog } from '../support/fake-dialog.ts';
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

test('permissions and shutdown', { timeout: 180_000 }, async () => {
  assert.equal(statSync(home.root).mode & 0o777, 0o700);
  assert.equal(statSync(home.socket).mode & 0o777, 0o600);
  assert.equal(statSync(join(home.profilesDir, 'default')).mode & 0o777, 0o700);
  await kernel.stop();
  assert.ok(!existsSync(home.socket));
  assert.equal((await e2k('status')).code, 22);
});
