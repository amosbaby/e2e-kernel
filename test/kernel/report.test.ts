import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capabilities } from '../../src/driver/types.ts';
import type { ActionRecord, ModeChange, WriteRecord } from '../../src/kernel/recorder.ts';
import { renderReport } from '../../src/report/html.ts';
import { buildResult } from '../../src/report/result.ts';
import type { RunInput } from '../../src/report/result.ts';
import { RUN_DIR_RE, pruneRuns, runDirName, writeRun } from '../../src/report/store.ts';
import type { Op } from '../../src/shared/ops.ts';
import { E2kError } from '../../src/shared/errors.ts';
import type { Mode, Outcome } from '../../src/shared/protocol.ts';
import { REDACTED, isSensitiveKey } from '../../src/shared/redact.ts';

// 长得像 token 的串在运行时拼出来，不写成字面量。
const jwt = 'eyJ' + 'a'.repeat(21) + '.' + 'b'.repeat(24) + '.' + 'c'.repeat(24);

let seq = 0;
function act(op: Op['op'], outcome: Outcome, extra: Partial<ActionRecord> = {}): ActionRecord {
  return { seq: ++seq, at: '2026-11-26T15:30:05.000Z', ms: 3, op: { op } as Op, outcome, ...extra };
}
function write(method: string, url: string, status: number | null, extra: Partial<WriteRecord> = {}): WriteRecord {
  return { id: `r${++seq}`, at: '2026-11-26T15:30:06.000Z', method, url, status, failed: false, body: null, bodyOmitted: false, pageUrl: null,
    decision: 'allowed', targetMode: 'default', host: new URL(url).hostname, graphql: null, reason: null, mode: 'default', ...extra };
}
function driverWith(caps: Partial<Capabilities> = {}): RunInput['driver'] {
  return { name: 'fake', capabilities: { networkInterception: true, crossProcessIframes: 'covered', nativeFormSubmit: 'covered', sharedWorkers: 'covered',
    sharesUserProfile: false, canHeadless: false, selectorDialect: 'css', ...caps } };
}
function input(o: Partial<RunInput> = {}): RunInput {
  return { kernelVersion: '0.1.0', session: 's-a41f00', name: 'session', startedAt: new Date('2026-11-26T15:30:00Z'),
    endedAt: new Date('2026-11-26T15:31:00Z'), closedBy: 'agent', start: { url: 'http://localhost/', viewport: null, touch: false, profile: 'default' },
    driver: driverWith(), actions: [], writes: [], unattributedWrites: [], hosts: [{ host: 'localhost', mode: 'default' }], webSockets: 0,
    verdict: null, findings: [], notDone: [], superseded: [], declarations: [],
    modes: [], rules: { hash: null, count: 0, pendingHash: null }, blocked: null, forced: false, ...o };
}
function textOf(html: string, id: string): string {
  const m = new RegExp(`<p id="${id}">([^<]*)</p>`).exec(html);
  assert.ok(m, `no element #${id}`);
  return m[1]!;
}
function outcomes(html: string): string[] {
  return [...html.matchAll(/<td class="outcome">([^<]*)<\/td>/g)].map((m) => m[1]!);
}
// 小节：整节（section）或模式一节下的子块（div）。子块不嵌套，非贪婪匹配到第一个同名结束标签。
function section(html: string, id: string): string {
  return new RegExp(`<(section|div) id="${id}">.*?</\\1>`, 's').exec(html)?.[0] ?? '';
}

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'e2k-report-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

test('the mode section also names an unapproved rules file whose tightening is already in force', () => {
  const html = section(renderReport(buildResult(input({ modes: [], rules: { hash: 'sha256:0123456789abcdef', count: 2, pendingHash: 'sha256:fedcba9876543210' } }))), 'modes');
  assert.ok(html.includes('sha256:0123456789abcdef') && html.includes('sha256:fedcba9876543210') && html.includes('未批准'));
  assert.ok(html.includes('新增或改成只读的规则条目'), 'only those rules are in force before approval');
  assert.ok(!html.includes('其中的收紧'));
  assert.ok(!section(renderReport(buildResult(input({ modes: [] }))), 'modes').includes('未批准'));
});

test('tallies line and per-step outcome wording', () => {
  const r = buildResult(input({ actions: [act('assert', 'match'), act('assert', 'mismatch'), act('click', 'ok'), act('click', 'failed'), act('click', 'not-run')] }));
  assert.deepEqual(r.tallies, { ok: 1, match: 1, mismatch: 1, failed: 1, notRun: 1 });
  const html = renderReport(r);
  assert.equal(textOf(html, 'tallies'), '相符 1 / 不符 1 / 执行失败 1 / 未执行 1');
  assert.deepEqual(outcomes(html), ['相符', '不符', '完成', '执行失败', '未执行']);
});

test('assert steps carry the measured and the expected value', () => {
  const html = renderReport(buildResult(input({ actions: [act('assert', 'mismatch', { actual: 'Saved', expected: 'Done' })] })));
  assert.ok(html.includes('实测 <code>Saved</code>，期望 <code>Done</code>'));
});

test('verdict wording is exact', () => {
  for (const [v, label] of [['pass', '通过'], ['fail', '不通过'], ['exists', '存在'], ['absent', '不存在'], ['undetermined', '无法判断']] as const) {
    const html = renderReport(buildResult(input({ verdict: { value: v, because: '依据甲' } })));
    assert.equal(textOf(html, 'verdict'), label); assert.equal(textOf(html, 'verdict-by'), 'agent 判定'); assert.ok(html.includes('依据甲'));
  }
  const none = renderReport(buildResult(input({ verdict: null })));
  assert.equal(textOf(none, 'verdict'), 'agent 未提交结论'); assert.ok(!none.includes('id="verdict-by"'));
});

test('a pass verdict that contradicts the record is flagged', () => {
  for (const patch of [{ actions: [act('assert', 'mismatch')] }, { actions: [act('click', 'failed')] },
    { actions: [act('click', 'not-run')] }, { notDone: ['没查分页'] }]) {
    const r = buildResult(input({ verdict: { value: 'pass' }, ...patch }));
    assert.equal(r.consistency, 'conflict'); assert.equal(textOf(renderReport(r), 'conflict'), '结论与记录不一致');
  }
  const ok = buildResult(input({ verdict: { value: 'fail' }, actions: [act('assert', 'mismatch')] }));
  assert.equal(ok.consistency, 'ok'); assert.ok(!renderReport(ok).includes('id="conflict"'));
  assert.ok(renderReport(buildResult(input({ notDone: ['没查分页'] }))).includes('没查分页'));
});

test('not-run steps and notDone are listed together under the not-done section', () => {
  const html = renderReport(buildResult(input({ notDone: ['没查分页'], actions: [act('click', 'not-run')] })));
  const s = section(html, 'not-done');
  assert.ok(s.includes('没查分页')); assert.ok(s.includes('click'));
});

test('writes section lists allowed, blocked and unattributed writes', () => {
  const r = buildResult(input({ writes: [write('POST', 'http://localhost:5173/api/items', 201), { ...write('PUT', 'http://localhost:5173/api/x', null), decision: 'blocked' }],
    unattributedWrites: [write('POST', 'http://localhost:5173/api/form-blank', 200)] }));
  assert.deepEqual([r.writes.allowed.length, r.writes.blocked.length, r.writes.unattributed.length], [1, 1, 1]);
  const html = renderReport(r);
  for (const s of ['这次动了什么', '/api/items', '201', '/api/x', '未归属的写', '/api/form-blank', '无法确定来自哪个页面']) assert.ok(html.includes(s), s);
  assert.ok(section(renderReport(buildResult(input({}))), 'writes').includes('<p>无</p>'));
});

test('an allowed write carries allowedBy in result.json and the report names the basis; other writes carry no such key; a logout block is a reason of its own', () => {
  const r = buildResult(input({
    writes: [write('POST', 'http://api.example.com/v1/t1/search', 200, { allowedBy: 'read-post' }), write('POST', 'http://api.example.com/graphql', 200, { allowedBy: 'persisted-query' }),
      write('POST', 'http://api.example.com/items', 200, { allowedBy: 'declared' }), write('POST', 'http://api.example.com/plain', 200),
      { ...write('GET', 'http://a.example.com/logout', null, { reason: 'logout', mode: 'readonly' }), decision: 'blocked' }],
  }));
  assert.deepEqual(r.writes.allowed.map((w) => w.allowedBy), ['read-post', 'persisted-query', 'declared', undefined]);
  assert.ok(!('allowedBy' in r.writes.allowed[3]!) && !('allowedBy' in r.writes.blocked[0]!));
  assert.deepEqual(r.writes.blockedSummary, [{ host: 'a.example.com', method: 'GET', reason: 'logout', count: 1, unattributed: false }]);
  const html = renderReport(r);
  const w = section(html, 'writes');
  for (const t of ['放行依据 读型 POST 白名单', '放行依据 持久化查询白名单', '放行依据 放行声明']) assert.ok(w.includes(t), t);
  assert.equal(w.split('放行依据').length - 1, 3);
  assert.ok(section(html, 'blocked-writes').includes('登出'));
});

test('an allowedBy value the report does not know is shown as unknown and escaped', () => {
  const r = buildResult(input({ writes: [write('POST', 'http://x.example.com/a', 200, { allowedBy: '<b>x</b>' as never })] }));
  const w = section(renderReport(r), 'writes');
  assert.ok(w.includes('放行依据 未知') && !w.includes('<b>x</b>'));
});

test('the writes summary groups attributed writes by host, method and GraphQL kind, with counts and a stable order', () => {
  const blocked = (m: string, u: string, extra: Partial<WriteRecord> = {}): WriteRecord => ({ ...write(m, u, null, extra), decision: 'blocked' });
  const r = buildResult(input({
    writes: [
      write('POST', 'http://b.example.com/api/a', 200), write('post', 'http://b.example.com/api/z?x=1', 200), blocked('POST', 'http://b.example.com/api/c'),
      write('POST', 'http://a.example.com/graphql', 200, { graphql: 'query' }), write('POST', 'http://a.example.com/graphql', 200, { graphql: 'mutation' }),
      write('POST', 'http://a.example.com/graphql', 200, { graphql: 'mutation' }), blocked('POST', 'http://a.example.com/graphql', { graphql: 'mutation' }),
      write('POST', 'http://a.example.com/other', 200, { graphql: 'unknown' }), write('DELETE', 'http://a.example.com/api/1', 204),
      write('POST', 'http://a.example.com/api', 200),
    ],
    unattributedWrites: [write('POST', 'http://z.example.com/form', 200)],
  }));
  assert.deepEqual(r.writes.summary, [
    { host: 'a.example.com', method: 'DELETE', graphql: null, allowed: 1, blocked: 0 },
    { host: 'a.example.com', method: 'POST', graphql: null, allowed: 1, blocked: 0 },
    { host: 'a.example.com', method: 'POST', graphql: 'mutation', allowed: 2, blocked: 1 },
    { host: 'a.example.com', method: 'POST', graphql: 'query', allowed: 1, blocked: 0 },
    { host: 'a.example.com', method: 'POST', graphql: 'unknown', allowed: 1, blocked: 0 },
    { host: 'b.example.com', method: 'POST', graphql: null, allowed: 2, blocked: 1 },
  ], 'host names only, no paths; the unattributed write is not counted; method is upper-cased');
  assert.ok(!JSON.stringify(r.writes.summary).includes('/api'));
  assert.deepEqual(buildResult(input({})).writes.summary, []);
});

test('the writes summary uses the recorded host, which was redacted on its own', () => {
  const r = buildResult(input({ writes: [write('POST', 'http://x.example.com/a', 200, { host: '[REDACTED].example.com' }), write('POST', 'http://x.example.com/b', 200, { host: '[REDACTED].example.com' })] }));
  assert.deepEqual(r.writes.summary.map((e) => [e.host, e.allowed]), [['[REDACTED].example.com', 2]]);
});

test('the report shows the writes summary table above the list, and says it leaves out unattributed writes', () => {
  const r = buildResult(input({
    writes: [write('POST', 'http://api.example.com/graphql', 200, { graphql: 'mutation' }), write('POST', 'http://api.example.com/graphql', 200, { graphql: 'mutation' }),
      { ...write('POST', 'http://api.example.com/graphql', null, { graphql: 'query' }), decision: 'blocked' }, write('PUT', 'http://api.example.com/x', 200)],
    unattributedWrites: [write('POST', 'http://api.example.com/form', 200), write('POST', 'http://api.example.com/form2', 200)],
  }));
  const w = section(renderReport(r), 'writes');
  for (const s of ['<th>主机</th>', '<th>方法</th>', '<th>GraphQL</th>', '<th>放行</th>', '<th>拦下</th>']) assert.ok(w.includes(s), s);
  assert.ok(w.includes('<td>api.example.com</td><td>POST</td><td>mutation</td><td>2</td><td>0</td>'), w);
  assert.ok(w.includes('<td>api.example.com</td><td>POST</td><td>query</td><td>0</td><td>1</td>'), w);
  assert.ok(w.includes('<td>api.example.com</td><td>PUT</td><td>—</td><td>1</td><td>0</td>'), w);
  assert.ok(w.includes('不含未归属的写（2 条，见下）'), w);
  assert.ok(w.indexOf('<table') < w.indexOf('放行的写'), 'the table comes first');
  const none = section(renderReport(buildResult(input({ writes: [write('POST', 'http://api.example.com/a', 200)] }))), 'writes');
  assert.ok(none.includes('不含未归属的写（0 条）') && !none.includes('见下'));
  const onlyUnattributed = section(renderReport(buildResult(input({ unattributedWrites: [write('POST', 'http://api.example.com/f', 200)] }))), 'writes');
  assert.ok(!onlyUnattributed.includes('<table'));
});

test('summary host and kind are escaped, and a token-shaped host never shows raw', () => {
  const host = 'Ab1'.repeat(14) + '.example.com';
  const html = renderReport(buildResult(input({ writes: [write('POST', 'http://x.example.com/a', 200, { host: '<i>' + host, graphql: 'unknown' })] })));
  assert.ok(!html.includes('<i>'));
  assert.ok(!html.includes(host));
});

test('writes to a non-default mode host are marked', () => {
  const html = renderReport(buildResult(input({ writes: [write('POST', 'http://localhost/a', 200, { targetMode: 'readonly' as Mode }), write('POST', 'http://localhost/b', 200)] })));
  assert.equal(html.match(/非默认模式域名/g)?.length, 1);
});

test('coverage notes and next', () => {
  const r = buildResult(input({ webSockets: 2, driver: driverWith({ nativeFormSubmit: 'not-covered' }) }));
  assert.ok(r.coverage.notes.includes('有 WebSocket 连接，不受写策略管'));
  assert.ok(r.coverage.notes.some((n) => n.includes('docs/m0-findings.md')));
  assert.equal(r.coverage.notes.length, 2);
  assert.equal(buildResult(input({ closedBy: 'browser-gone' })).next, '浏览器已关闭，需要时重新 open');
  assert.equal(buildResult(input({ closedBy: 'page-gone' })).next, '会话的页面被关闭，需要时重新 open');
  assert.equal(buildResult(input({ closedBy: 'agent' })).next, null);
});

test('a driver that does not cover SharedWorker adds a coverage note; one that does, does not', () => {
  const note = 'SharedWorker 发出的请求不一定被写策略拦住，详见 docs/m0-findings.md';
  for (const c of ['not-covered', 'unknown'] as const) {
    assert.ok(buildResult(input({ driver: driverWith({ sharedWorkers: c }) })).coverage.notes.includes(note), c);
  }
  const covered = buildResult(input({ driver: driverWith({ sharedWorkers: 'covered' }) }));
  assert.ok(!covered.coverage.notes.some((n) => n.includes('SharedWorker')));
  assert.ok(renderReport(covered).includes('SharedWorker：covered'));
});

test('html escapes everything that came from the page', () => {
  const html = renderReport(buildResult(input({ start: { url: 'http://localhost/?q=<b>x</b>', viewport: null, touch: true, profile: 'default' },
    actions: [act('click', 'failed', { error: '<script>window.pwned=1</script>', shot: 'shots/01.jpg"><img src=x onerror=1' })] })));
  assert.ok(!html.includes('<script')); assert.ok(!html.includes('<b>x</b>')); assert.ok(!html.includes('onerror=1"'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('Content-Security-Policy'));
});

test('the environment section says whether touch emulation was on, and result.json carries start.touch', () => {
  const on = renderReport(buildResult(input({ start: { url: 'http://localhost/', viewport: null, touch: true, profile: 'default' } })));
  const off = renderReport(buildResult(input()));
  assert.ok(on.includes('触屏模拟 是') && !on.includes('触屏模拟 否'));
  assert.ok(off.includes('触屏模拟 否') && !off.includes('触屏模拟 是'));
  assert.equal(buildResult(input({ start: { url: 'http://localhost/', viewport: null, touch: true, profile: 'default' } })).start.touch, true);
});

test('a valid screenshot path becomes an img, anything else does not', () => {
  const html = renderReport(buildResult(input({ actions: [act('screenshot', 'ok', { shot: 'shots/01.jpg' }), act('screenshot', 'ok', { shot: '../x.jpg' })] })));
  assert.equal(html.match(/<img /g)?.length, 1); assert.ok(html.includes('<img src="shots/01.jpg"'));
});

test('labelled and png screenshot paths render as img; traversal and odd shapes do not', () => {
  const good = ['shots/03-checkout-mobile.png', 'shots/12.png', 'shots/100-a.jpg', 'shots/01-0-9.jpg'];
  const badPaths = ['shots/../x.png', 'shots/03-../x.png', '../shots/01.png', 'shots/01-.png', 'shots/01-A.png', 'shots/01-a/b.png', 'shots/1.png',
    'shots/01.gif', 'shots/01-a.png.html', '/shots/01.png', 'shots/01-' + 'a'.repeat(41) + '.png', 'shots/01.png\n'];
  const html = renderReport(buildResult(input({ actions: [...good, ...badPaths].map((shot) => act('screenshot', 'ok', { shot })) })));
  assert.equal(html.match(/<img /g)?.length, good.length);
  for (const g of good) assert.ok(html.includes(`<img src="${g}" alt="截图 ${g}">`), g);
  assert.equal(html.match(/截图路径无效/g)?.length, badPaths.length);
});

test('the screenshot path rule holds up against long adversarial input', () => {
  const t0 = Date.now();
  const shots = ['shots/' + '1'.repeat(30000) + '.gif', 'shots/01-' + 'a-'.repeat(15000) + '.png', 'shots/' + '1'.repeat(30000) + '-' + '-'.repeat(30000)];
  const html = renderReport(buildResult(input({ actions: shots.map((shot) => act('screenshot', 'ok', { shot })) })));
  assert.equal(html.match(/<img /g)?.length ?? 0, 0);
  assert.ok(Date.now() - t0 < 2000);
});

test('page content is redacted before it is truncated and escaped in the html', () => {
  // 脱敏必须在截断之前：token 跨过显示上限时，先截断会留下半截 token。
  const body = JSON.stringify({ note: 'x'.repeat(470) + ' ' + jwt + ' <img src=x onerror=1>' });
  const html = renderReport(buildResult(input({
    writes: [write('POST', 'http://localhost/api', 200, { body })],
    findings: [{ claim: '<b>c</b> ' + jwt, basis: 'y'.repeat(480) + ' ' + jwt }],
    actions: [act('assert', 'mismatch', { actual: 'z'.repeat(490) + ' ' + jwt, expected: 'e' })],
  })));
  assert.ok(!html.includes('eyJ'), 'token fragment leaked');
  assert.ok(!html.includes('<b>c</b>')); assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes(REDACTED));
});

test('if redaction throws, a fixed marker is shown and the raw value never is', () => {
  const secret = 'raw-secret-marker-7731';
  const odd = { toString: () => secret } as unknown as string;   // 不是字符串：redactText 会抛错
  const html = renderReport(buildResult(input({ findings: [{ claim: odd, basis: odd }], notDone: [odd],
    verdict: { value: 'fail', because: odd }, actions: [act('assert', 'mismatch', { error: odd })] })));
  assert.ok(!html.includes(secret)); assert.ok(html.includes(REDACTED));
});

test('hints show in the report, redacted and escaped, and nowhere raw in either file', () => {
  const secret = 'f'.repeat(8) + 'a1'.repeat(28);
  const hints = ['2 matches', `1) <b>button</b> "${jwt}"`, `被遮挡：<div data-x="${secret}">`];
  const input1 = input({ actions: [act('click', 'failed', { error: 'other: boom', hints })] });
  const html = renderReport(buildResult(input1));
  assert.ok(html.includes('诊断<br>2 matches<br>1) &lt;b&gt;button&lt;/b&gt;'), html);
  assert.ok(!html.includes(jwt)); assert.ok(!html.includes(secret));
  const out = writeRun(join(tmp, 'r-hints'), buildResult(input1));
  for (const f of [out.reportPath, out.resultPath]) { const t = readFileSync(f, 'utf8'); assert.ok(!t.includes(jwt)); assert.ok(!t.includes(secret)); }
  assert.deepEqual(JSON.parse(readFileSync(out.resultPath, 'utf8')).actions[0].hints.length, 3);
  assert.ok(!renderReport(buildResult(input({ actions: [act('click', 'failed', { error: 'other: boom' })] }))).includes('诊断'));
});

test('a write whose body was omitted says so in the report', () => {
  const html = renderReport(buildResult(input({ writes: [write('POST', 'http://localhost/api/sso', 200, { bodyOmitted: true })] })));
  assert.ok(html.includes('请求体未记录'));
  assert.ok(!renderReport(buildResult(input({ writes: [write('POST', 'http://localhost/api/ok', 200, { body: 'a=1' })] }))).includes('请求体未记录'));
});

test('an eval step shows its recorded result and source hash; a token in the result does not leak', () => {
  const hash = 'sha256:0123456789abcdef';
  const html = renderReport(buildResult(input({ actions: [
    act('eval', 'ok', { output: '{"n":1,"id":"<b>x</b>"}', jsHash: hash }),
    act('eval', 'ok', { output: `"${jwt}"`, jsHash: hash }),
    act('eval', 'ok', { outputOmitted: true, jsHash: hash }),
  ] })));
  assert.ok(html.includes('返回值 <code>{&quot;n&quot;:1,&quot;id&quot;:&quot;&lt;b&gt;x&lt;/b&gt;&quot;}</code>'), 'result shown, escaped');
  assert.ok(html.includes(`源码哈希 <code>${hash}</code>`));
  assert.ok(html.includes('返回值未记录'));
  assert.ok(!html.includes('<b>x</b>') && !html.includes('eyJ'), 'a token in the result must not leak');
});

test('no key anywhere in buildResult output is a sensitive key', () => {
  const r = buildResult(input({
    verdict: { value: 'pass', because: 'b' }, findings: [{ claim: 'c', basis: 'b', verdict: 'fail' }], notDone: ['n'], webSockets: 1, superseded: [{ failed: 9001, by: 9002 }],
    driver: driverWith({ nativeFormSubmit: 'unknown' }), start: { url: 'http://localhost/', viewport: null, touch: false, profile: 'a', borrowed: true },
    actions: [act('click', 'ok', { target: { given: 'e2', stable: { selector: '#a', via: 'id' } }, shot: 'shots/01.jpg' }),
      act('assert', 'match', { actual: 1, expected: 1, error: 'e' }),
      act('click', 'failed', { seq: 9001, target: { given: '#b', stable: null }, error: 'other: x', hints: ['2 matches', '1) button "A" >> nth=0'] }),
      act('screenshot', 'ok', { seq: 9002 }),
      act('screenshot', 'ok', { op: { op: 'screenshot', label: 'a', format: 'png', mask: ['#m'] }, shot: 'shots/04-a.png' }),
      act('wait', 'ok', { op: { op: 'wait', for: { idle: 300 }, timeoutMs: 2000 } }),
      act('eval', 'ok', { output: '1', jsHash: 'sha256:0123456789abcdef' }), act('eval', 'ok', { outputOmitted: true, jsHash: 'sha256:0123456789abcdef' })],
    writes: [write('POST', 'http://localhost/a', 200, { body: '{}', pageUrl: 'http://localhost/' }), write('POST', 'http://localhost/c', 200, { bodyOmitted: true }),
      write('POST', 'http://localhost/graphql', 200, { graphql: 'mutation' }), write('POST', 'http://localhost/s', 200, { allowedBy: 'read-post' })],
    unattributedWrites: [{ ...write('PUT', 'http://localhost/b', null, { reason: 'unattributed', mode: 'readonly' }), decision: 'blocked' }],
    modes: [{ at: '2026-11-26T15:30:01.000Z', host: 'localhost', mode: 'readonly', reason: 'forced', rulesHash: 'sha256:0123456789abcdef', pendingRulesHash: 'sha256:fedcba9876543210' }],
    rules: { hash: 'sha256:0123456789abcdef', count: 2, pendingHash: 'sha256:fedcba9876543210' }, blocked: 'login', forced: true,
    declarations: [{ method: 'POST', url: 'http://localhost/a', operation: 'Save', approved: 'dialog' }, { method: 'PUT', url: 'http://localhost/b', operation: null, approved: 'remembered' }],
    identity: { group: 'a', checks: 2, skipped: 1, mismatch: true }, frozen: { group: 'a', host: 'b.example.com' },
  }));
  const bad: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null) {
      for (const [k, val] of Object.entries(v)) { if (isSensitiveKey(k)) bad.push(k); walk(val); }
    }
  };
  walk(r);
  assert.deepEqual(bad, []);
  const keys = new Set<string>();
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === 'object' && v !== null) for (const [k, val] of Object.entries(v)) { keys.add(k); collect(val); }
  };
  collect(r);
  for (const k of ['superseded', 'by', 'conflicts', 'failedOp', 'failedTarget', 'byOp', 'byTarget', 'byReadOnly', 'summary', 'host', 'graphql', 'bodyOmitted', 'allowed', 'blocked', 'label', 'format', 'mask', 'idle',
    'modes', 'rules', 'hash', 'count', 'mode', 'reason', 'rulesHash', 'pendingHash', 'pendingRulesHash', 'readonly', 'blockedSummary', 'unattributed', 'profile', 'borrowed', 'allowedBy', 'declarations', 'operation', 'approved', 'identity', 'group', 'checks', 'skipped', 'mismatch', 'frozen']) assert.ok(keys.has(k), k);
  assert.ok(Array.isArray(r.conflicts));
});

const blockedWrite = (m: string, u: string, reason: NonNullable<WriteRecord['reason']>, extra: Partial<WriteRecord> = {}): WriteRecord =>
  ({ ...write(m, u, null, { reason, mode: 'readonly', ...extra }), decision: 'blocked' });

test('buildResult carries the read-only fields through as given', () => {
  const modes: ModeChange[] = [
    { at: '2026-11-26T15:30:01.000Z', host: 'localhost', mode: 'default', reason: 'no-rule', rulesHash: null, pendingRulesHash: null },
    { at: '2026-11-26T15:30:09.000Z', host: 'app.example.com', mode: 'readonly', reason: 'rule', rulesHash: 'sha256:0123456789abcdef', pendingRulesHash: null },
  ];
  const r = buildResult(input({ modes, rules: { hash: 'sha256:0123456789abcdef', count: 3, pendingHash: 'sha256:fedcba9876543210' }, forced: true, blocked: 'login' }));
  assert.deepEqual(r.modes, modes);
  assert.deepEqual(r.rules, { hash: 'sha256:0123456789abcdef', count: 3, pendingHash: 'sha256:fedcba9876543210' });
  assert.equal(r.blocked, 'login');
  assert.deepEqual(r.start, { url: 'http://localhost/', viewport: null, touch: false, profile: 'default', borrowed: false, readonly: true });
  const plain = buildResult(input({}));
  assert.deepEqual([plain.modes, plain.rules, plain.blocked, plain.start.readonly], [[], { hash: null, count: 0, pendingHash: null }, null, false]);
});

test('blocked writes carry reason and mode in result.json', () => {
  const r = buildResult(input({ writes: [blockedWrite('PUT', 'http://localhost/a', 'method'), write('POST', 'http://localhost/b', 200)] }));
  assert.deepEqual(r.writes.blocked.map((w) => [w.reason, w.mode]), [['method', 'readonly']]);
  assert.deepEqual(r.writes.allowed.map((w) => [w.reason, w.mode]), [[null, 'default']]);
});

test('blockedSummary groups blocked writes by host, method and reason, includes unattributed ones, and has no paths', () => {
  const r = buildResult(input({
    writes: [
      blockedWrite('POST', 'http://b.example.com/api/a', 'graphql-mutation'), blockedWrite('post', 'http://b.example.com/api/z?x=1', 'graphql-mutation'),
      blockedWrite('POST', 'http://b.example.com/api/c', 'method'), blockedWrite('DELETE', 'http://a.example.com/api/1', 'method'),
      write('POST', 'http://a.example.com/ok', 200),
    ],
    unattributedWrites: [blockedWrite('POST', 'http://b.example.com/f', 'unattributed'), blockedWrite('POST', 'http://b.example.com/g', 'unattributed'),
      write('POST', 'http://b.example.com/allowed-one', 200)],
  }));
  assert.deepEqual(r.writes.blockedSummary, [
    { host: 'a.example.com', method: 'DELETE', reason: 'method', count: 1, unattributed: false },
    { host: 'b.example.com', method: 'POST', reason: 'graphql-mutation', count: 2, unattributed: false },
    { host: 'b.example.com', method: 'POST', reason: 'method', count: 1, unattributed: false },
    { host: 'b.example.com', method: 'POST', reason: 'unattributed', count: 2, unattributed: true },
  ]);
  assert.ok(!JSON.stringify(r.writes.blockedSummary).includes('/api'));
  assert.deepEqual(buildResult(input({})).writes.blockedSummary, []);
});

test('start.borrowed is false unless the session borrowed a group\'s login; the report names the profile and says borrowed, and other-group has its own text', () => {
  const plain = buildResult(input({}));
  assert.equal(plain.start.borrowed, false);
  assert.ok(!renderReport(plain).includes('（借用）'));
  assert.ok(section(renderReport(plain), 'mode-profile').includes('profile default') && !section(renderReport(plain), 'mode-profile').includes('借用'));
  const borrowed = buildResult(input({ start: { url: 'http://localhost/', viewport: null, touch: false, profile: 'a', borrowed: true } }));
  assert.deepEqual([borrowed.start.profile, borrowed.start.borrowed], ['a', true]);
  assert.ok(section(renderReport(borrowed), 'mode-profile').includes('profile a（借用）'));
  assert.ok(!section(renderReport(borrowed), 'env').includes('profile a') && !section(renderReport(borrowed), 'env').includes('借用'), 'the profile is shown once, under the mode section');
  const cross = buildResult(input({ writes: [blockedWrite('GET', 'http://b.example.com/x', 'other-group')] }));
  assert.deepEqual(cross.writes.blockedSummary, [{ host: 'b.example.com', method: 'GET', reason: 'other-group', count: 1, unattributed: false }]);
  const sec = section(renderReport(cross), 'blocked-writes');
  assert.ok(sec.includes('跨组导航') && !sec.includes('原因不明'), sec);
});

test('a blocked write without a reason is counted under the fixed reason unknown, and shown in the report', () => {
  const noReason = { ...write('POST', 'http://x.example.com/a', null), decision: 'blocked' as const, reason: null, mode: 'readonly' as const };
  const r = buildResult(input({ writes: [noReason], unattributedWrites: [{ ...noReason, id: 'u9' }] }));
  assert.deepEqual(r.writes.blockedSummary, [
    { host: 'x.example.com', method: 'POST', reason: 'unknown', count: 1, unattributed: false },
    { host: 'x.example.com', method: 'POST', reason: 'unknown', count: 1, unattributed: true },
  ]);
  const sec = section(renderReport(r), 'blocked-writes');
  assert.ok(sec.includes('原因不明') && !sec.includes('没有'), sec);
});

test('the blockedSummary counts add up to every blocked write, attributed and unattributed, with or without a reason', () => {
  const r = buildResult(input({
    writes: [blockedWrite('POST', 'http://a.example.com/1', 'method'), blockedWrite('PUT', 'http://a.example.com/2', 'graphql-mutation'),
      blockedWrite('POST', 'http://b.example.com/3', 'persisted-query'), blockedWrite('POST', 'http://b.example.com/3', 'redirected-write'),
      { ...blockedWrite('POST', 'http://b.example.com/4', 'method'), reason: null }, write('POST', 'http://a.example.com/ok', 200)],
    unattributedWrites: [blockedWrite('POST', 'http://c.example.com/5', 'unattributed'), { ...blockedWrite('POST', 'http://c.example.com/6', 'unattributed'), reason: null },
      write('POST', 'http://c.example.com/ok', 200)],
  }));
  const total = r.writes.blockedSummary.reduce((n, e) => n + e.count, 0);
  assert.equal(total, r.writes.blocked.length + r.writes.unattributed.filter((w) => w.decision === 'blocked').length);
  assert.equal(total, 7);
});

test('the same host, method and reason is split into an attributed and an unattributed row', () => {
  const r = buildResult(input({
    writes: [blockedWrite('POST', 'http://x.example.com/a', 'redirected-write')],
    unattributedWrites: [blockedWrite('POST', 'http://x.example.com/b', 'redirected-write')],
  }));
  assert.deepEqual(r.writes.blockedSummary.map((e) => [e.unattributed, e.count]), [[false, 1], [true, 1]]);
});

test('the environment section says the session ended on a login page only when blocked is login', () => {
  const env = (o: Partial<RunInput>): string => section(renderReport(buildResult(input(o))), 'env');
  assert.ok(env({ blocked: 'login' }).includes('收尾时停在登录页'));
  assert.ok(!env({ blocked: null }).includes('收尾时停在登录页'));
});

test('the mode section says default all along when there is nothing but the default mode', () => {
  const only = (modes: ModeChange[]): string => section(renderReport(buildResult(input({ modes }))), 'modes');
  assert.ok(only([]).includes('全程默认模式'));
  assert.ok(only([{ at: '2026-11-26T15:30:01.000Z', host: 'localhost', mode: 'default', reason: 'no-rule', rulesHash: null, pendingRulesHash: null }]).includes('全程默认模式'));
});

test('the mode section lists time, host, mode and reason, and the rules in force', () => {
  const r = buildResult(input({
    modes: [
      { at: '2026-11-26T15:30:01.000Z', host: 'localhost', mode: 'default', reason: 'no-rule', rulesHash: 'sha256:0123456789abcdef', pendingRulesHash: null },
      { at: '2026-11-26T15:30:09.000Z', host: 'app.example.com', mode: 'readonly', reason: 'rule', rulesHash: 'sha256:0123456789abcdef', pendingRulesHash: null },
      { at: '2026-11-26T15:30:20.000Z', host: 'x.example.com', mode: 'readonly', reason: 'forced', rulesHash: null, pendingRulesHash: null },
      { at: '2026-11-26T15:30:30.000Z', host: 'y.example.com', mode: 'readonly', reason: 'host-choice', rulesHash: null, pendingRulesHash: null },
    ],
    rules: { hash: 'sha256:0123456789abcdef', count: 2, pendingHash: null },
  }));
  const sec = section(renderReport(r), 'modes');
  assert.ok(!sec.includes('全程默认模式'));
  const rows = [...sec.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => m.slice(1, 5));
  assert.deepEqual(rows, [
    ['2026-11-26T15:30:01.000Z', 'localhost', 'default', '无规则命中'],
    ['2026-11-26T15:30:09.000Z', 'app.example.com', 'readonly', '规则命中'],
    ['2026-11-26T15:30:20.000Z', 'x.example.com', 'readonly', '--readonly 强制'],
    ['2026-11-26T15:30:30.000Z', 'y.example.com', 'readonly', '登录时选的模式'],
  ]);
  assert.ok(sec.includes('规则 2 条') && sec.includes('sha256:0123456789abcdef'), sec);
  assert.ok(section(renderReport(buildResult(input({ modes: [] }))), 'modes').includes('没有已批准的规则'));
});

test('the blocked-writes section shows the summary table, or says none', () => {
  const r = buildResult(input({
    writes: [blockedWrite('POST', 'http://api.example.com/a', 'graphql-mutation'), blockedWrite('POST', 'http://api.example.com/b', 'graphql-mutation')],
    unattributedWrites: [blockedWrite('POST', 'http://api.example.com/f', 'unattributed')],
  }));
  const sec = section(renderReport(r), 'blocked-writes');
  const rows = [...sec.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => m.slice(1, 6));
  assert.deepEqual(rows, [
    ['api.example.com', 'POST', 'GraphQL mutation', '2', '否'],
    ['api.example.com', 'POST', '未归属的写', '1', '是'],
  ]);
  assert.ok(!sec.includes('/api/'));
  const none = section(renderReport(buildResult(input({ writes: [write('POST', 'http://api.example.com/a', 200)] }))), 'blocked-writes');
  assert.ok(none.includes('没有') && !none.includes('<table'), none);
});

test('hosts in the mode and blocked-writes sections are escaped', () => {
  const r = buildResult(input({
    modes: [{ at: '2026-11-26T15:30:09.000Z', host: '<img src=x onerror=alert(1)>', mode: 'readonly', reason: 'rule', rulesHash: null, pendingRulesHash: null }],
    writes: [blockedWrite('POST', 'http://x.example.com/a', 'method', { host: '<script>alert(1)</script>.example.com' })],
  }));
  const html = renderReport(r);
  const both = section(html, 'modes') + section(html, 'blocked-writes');
  assert.ok(!both.includes('<img') && !both.includes('<script>'), both);
  assert.ok(both.includes('&lt;img') && both.includes('&lt;script&gt;'), both);
});

// 序号固定的动作：[失败(1), 未执行(2), 完成(3), 完成(4)]
function recoverable(): ActionRecord[] {
  return [
    act('click', 'failed', { seq: 1, target: { given: '#submit', stable: null }, error: 'other: boom' }),
    act('fill', 'not-run', { seq: 2, target: { given: '#name', stable: null } }),
    act('click', 'ok', { seq: 3, target: { given: '#submit', stable: null } }),
    act('screenshot', 'ok', { seq: 4 }),
  ];
}

test('superseded failures are shown as recovered, and a pass verdict then has no conflict', () => {
  const r = buildResult(input({ actions: recoverable(), verdict: { value: 'pass' }, superseded: [{ failed: 1, by: 3 }, { failed: 2, by: 4 }] }));
  assert.equal(r.consistency, 'ok'); assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.tallies, { ok: 2, match: 0, mismatch: 0, failed: 1, notRun: 1 });          // 原始计数不动
  assert.deepEqual(r.superseded, [
    { failed: 1, by: 3, failedOp: 'click', failedTarget: '#submit', byOp: 'click', byTarget: '#submit', byReadOnly: false },
    { failed: 2, by: 4, failedOp: 'fill', failedTarget: '#name', byOp: 'screenshot', byTarget: null, byReadOnly: true },
  ]);
  const html = renderReport(r);
  assert.ok(!html.includes('id="conflict"'));
  const sec = section(html, 'failures');
  assert.ok(sec.includes('已恢复的失败') && sec.includes('未解决的失败'), sec);
  const recovered = sec.slice(sec.indexOf('已恢复的失败'), sec.indexOf('未解决的失败'));
  assert.equal(recovered.match(/<li>/g)?.length, 2);
  for (const n of [1, 2, 3, 4]) assert.ok(recovered.includes(`序号 ${n}`), recovered);
  assert.ok(sec.slice(sec.indexOf('未解决的失败')).includes('<p>无</p>'), sec);
  assert.ok(!section(html, 'not-done').includes('步骤 2'), 'a recovered not-run step is not listed as not done');
  assert.ok(section(html, 'not-done').includes('<p>无</p>'));
});

test('the report shows both ops and targets side by side, and marks a read-only replacement of an action', () => {
  const html = renderReport(buildResult(input({ actions: recoverable(), superseded: [{ failed: 1, by: 3 }, { failed: 2, by: 4 }] })));
  const recovered = section(html, 'failures');
  assert.ok(/序号 1 click <code>#submit<\/code>[^<]*→[^<]*序号 3 click <code>#submit<\/code>/.test(recovered), recovered);
  assert.ok(/序号 2 fill <code>#name<\/code>[^<]*→[^<]*序号 4 screenshot/.test(recovered), recovered);
  assert.equal(recovered.match(/取代者是只读操作/g)?.length, 1, 'only the read-only replacement of an action is marked');
  assert.ok(recovered.indexOf('取代者是只读操作') > recovered.indexOf('序号 4'));
});

test('a wait counts as a non-action: replacing an action by it is marked, replacing a wait by it is not', () => {
  const acts = [
    act('click', 'failed', { seq: 1 }), act('wait', 'ok', { seq: 2 }), act('wait', 'failed', { seq: 3 }), act('wait', 'ok', { seq: 4 }),
    act('snapshot', 'failed', { seq: 5 }), act('wait', 'ok', { seq: 6 }), act('click', 'ok', { seq: 7 }),
  ];
  const r = buildResult(input({ actions: acts, superseded: [{ failed: 1, by: 2 }, { failed: 3, by: 4 }, { failed: 5, by: 6 }] }));
  assert.deepEqual(r.superseded.map((e) => e.byReadOnly), [true, false, false]);
  const html = renderReport(r);
  assert.equal(html.match(/取代者是只读操作/g)?.length, 1);
  assert.ok(/序号 1 click[^<]*→[^<]*序号 2 wait[^<]*取代（取代者是只读操作）/.test(section(html, 'failures')), section(html, 'failures'));
  assert.ok(buildResult(input({ actions: acts, superseded: [{ failed: 1, by: 7 }] })).superseded[0]!.byReadOnly === false);
});

test('a replacement used for several failures is marked next to each of those rows', () => {
  const acts = [
    act('click', 'failed', { seq: 1 }), act('fill', 'failed', { seq: 2 }), act('click', 'not-run', { seq: 3 }), act('click', 'failed', { seq: 4 }),
    act('click', 'ok', { seq: 5 }), act('click', 'ok', { seq: 6 }),
  ];
  const html = renderReport(buildResult(input({ actions: acts, superseded: [{ failed: 1, by: 5 }, { failed: 2, by: 5 }, { failed: 3, by: 5 }, { failed: 4, by: 6 }] })));
  const rows = [...section(html, 'failures').matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]!);
  assert.equal(rows.length, 4);
  for (const row of rows.slice(0, 3)) assert.ok(row.includes('（此取代者同时取代了 3 个失败）'), row);
  assert.ok(!rows[3]!.includes('同时取代'), rows[3]);
  assert.equal(html.match(/同时取代了/g)?.length, 3);
});

test('only part of the failures superseded: still a conflict, with the reason', () => {
  const r = buildResult(input({ actions: recoverable(), verdict: { value: 'pass' }, superseded: [{ failed: 1, by: 3 }] }));
  assert.equal(r.consistency, 'conflict'); assert.deepEqual(r.conflicts, ['unresolved-not-run']);
  const html = renderReport(r);
  assert.ok(html.includes('id="conflict"'));
  assert.ok(section(html, 'not-done').includes('步骤 2'));
  const r2 = buildResult(input({ actions: recoverable(), verdict: { value: 'pass' }, superseded: [{ failed: 2, by: 4 }] }));
  assert.equal(r2.consistency, 'conflict'); assert.deepEqual(r2.conflicts, ['unresolved-failed']);
  const sec = section(renderReport(r2), 'failures');
  assert.ok(sec.slice(sec.indexOf('未解决的失败')).includes('序号 1'), sec);
});

test('each conflict reason is reported on its own, and listed in the conclusion section', () => {
  const pass = { value: 'pass' } as const;
  const cases: [string, Partial<RunInput>][] = [
    ['mismatch', { actions: [act('assert', 'mismatch', { seq: 1 })] }],
    ['unresolved-failed', { actions: [act('click', 'failed', { seq: 1 })] }],
    ['unresolved-not-run', { actions: [act('click', 'not-run', { seq: 1 })] }],
    ['not-done', { notDone: ['没查分页'] }],
    ['finding-fail', { findings: [{ claim: 'a', basis: 'b', verdict: 'fail' }] }],
  ];
  const reasonText: Record<string, string> = {
    'mismatch': '有不符的断言', 'unresolved-failed': '有未解决的执行失败', 'unresolved-not-run': '有未解决的未执行操作',
    'not-done': 'agent 自己列了没做的事', 'finding-fail': '有一条结论的判定是不通过',
  };
  for (const [reason, extra] of cases) {
    const r = buildResult(input({ verdict: pass, ...extra }));
    assert.equal(r.consistency, 'conflict', reason); assert.deepEqual(r.conflicts, [reason], reason);
    const html = renderReport(r);
    assert.ok(section(html, 'sec-verdict').includes(reasonText[reason]!), `${reason}: ${section(html, 'sec-verdict')}`);
    for (const other of Object.keys(reasonText).filter((k) => k !== reason)) assert.ok(!section(html, 'sec-verdict').includes(reasonText[other]!), `${reason} shows ${other}`);
  }
  const all = buildResult(input({ verdict: pass, notDone: ['x'], findings: [{ claim: 'a', basis: 'b', verdict: 'fail' }],
    actions: [act('assert', 'mismatch', { seq: 1 }), act('click', 'failed', { seq: 2 }), act('click', 'not-run', { seq: 3 })] }));
  assert.deepEqual(all.conflicts, ['mismatch', 'unresolved-failed', 'unresolved-not-run', 'not-done', 'finding-fail']);
  // 不是 pass 就没有冲突
  for (const v of [null, { value: 'fail' as const }, { value: 'exists' as const }, { value: 'undetermined' as const, because: 'x' }]) {
    const r = buildResult(input({ verdict: v, notDone: ['x'], actions: [act('assert', 'mismatch', { seq: 1 })] }));
    assert.equal(r.consistency, 'ok'); assert.deepEqual(r.conflicts, []);
  }
});

test('a finding verdict other than fail is no conflict, and each finding shows its own verdict', () => {
  const r = buildResult(input({ verdict: { value: 'pass' }, findings: [
    { claim: 'one', basis: 'b', verdict: 'pass' }, { claim: 'two', basis: 'b', verdict: 'undetermined' }, { claim: 'three', basis: 'b' },
  ] }));
  assert.equal(r.consistency, 'ok');
  const html = renderReport(buildResult(input({ findings: [
    { claim: 'one', basis: 'b', verdict: 'pass' }, { claim: 'two', basis: 'b', verdict: 'fail' }, { claim: 'three', basis: 'b', verdict: 'exists' },
    { claim: 'four', basis: 'b', verdict: 'absent' }, { claim: 'five', basis: 'b', verdict: 'undetermined' }, { claim: 'six', basis: 'b' },
  ] })));
  const items = [...section(html, 'findings').matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]!);
  assert.equal(items.length, 6);
  ['通过', '不通过', '存在', '不存在', '无法判断'].forEach((l, i) => assert.ok(items[i]!.startsWith(`[${l}] `), items[i]));
  assert.ok(items[5]!.startsWith('<strong>six</strong>'), items[5]);
});

test('a superseded pair must point at a failed or not-run action and a later ok or match action; nothing else is accepted', () => {
  const acts = [
    act('click', 'failed', { seq: 1 }), act('assert', 'mismatch', { seq: 2 }), act('click', 'ok', { seq: 3 }), act('assert', 'match', { seq: 4 }),
    act('click', 'failed', { seq: 5 }), act('click', 'not-run', { seq: 6 }),
  ];
  const usage = (e: unknown): boolean => e instanceof E2kError && e.code === 'usage';
  const bad: { failed: number; by: number }[][] = [
    [{ failed: 3, by: 4 }],                 // failed 指向 ok
    [{ failed: 2, by: 3 }],                 // mismatch 不可被取代
    [{ failed: 4, by: 6 }],                 // match 不是失败
    [{ failed: 1, by: 2 }],                 // by 指向 mismatch
    [{ failed: 1, by: 5 }],                 // by 指向 failed
    [{ failed: 1, by: 6 }],                 // by 指向 not-run
    [{ failed: 1, by: 99 }], [{ failed: 99, by: 100 }],   // 不存在的序号
    [{ failed: 5, by: 3 }],                 // by 在前
    [{ failed: 1, by: 3 }, { failed: 1, by: 4 }],         // 同一个 failed 两次
  ];
  for (const superseded of bad) assert.throws(() => buildResult(input({ actions: acts, superseded })), usage, JSON.stringify(superseded));
  assert.equal(buildResult(input({ actions: acts, superseded: [{ failed: 1, by: 3 }] })).superseded.length, 1);
  // mismatch 取代不了：即使其他失败都被取代，pass 仍然冲突
  const r = buildResult(input({ actions: [act('assert', 'mismatch', { seq: 1 }), act('click', 'failed', { seq: 2 }), act('click', 'ok', { seq: 3 })],
    verdict: { value: 'pass' }, superseded: [{ failed: 2, by: 3 }] }));
  assert.deepEqual(r.conflicts, ['mismatch']); assert.equal(r.consistency, 'conflict');
});

test('superseded targets come from the record, are redacted, escaped and capped', () => {
  const secret = 'f'.repeat(8) + 'a1'.repeat(28);
  const html = renderReport(buildResult(input({ superseded: [{ failed: 1, by: 2 }], actions: [
    act('click', 'failed', { seq: 1, target: { given: `text="<b>x</b>" ${jwt} ${secret}`, stable: null } }),
    act('click', 'ok', { seq: 2, target: { given: `#a${'z'.repeat(2000)}`, stable: null } }),
  ] })));
  const sec = section(html, 'failures');
  assert.ok(!sec.includes('<b>x</b>') && sec.includes('&lt;b&gt;x&lt;/b&gt;'), sec);
  assert.ok(!sec.includes(jwt) && !sec.includes(secret));          // 步骤表里的 target 是原样留的（重放要用），这里只看新增的段
  assert.ok(sec.includes('已截断'), 'long target is capped');
});

test('superseded entries are sanitized in result.json and in the failures section of report.html alike', () => {
  const out = writeRun(join(tmp, 'r-sup'), buildResult(input({ superseded: [{ failed: 1, by: 2 }], actions: [
    act('click', 'failed', { seq: 1, target: { given: `text=${jwt}`, stable: null } }),
    act('click', 'ok', { seq: 2, target: { given: `text=${jwt}`, stable: null } }),
  ] })));
  const j = JSON.parse(readFileSync(out.resultPath, 'utf8'));
  assert.ok(!JSON.stringify(j.superseded).includes(jwt));
  assert.ok(!section(readFileSync(out.reportPath, 'utf8'), 'failures').includes(jwt));
  assert.equal(j.superseded[0].failed, 1); assert.equal(j.superseded[0].by, 2); assert.deepEqual(j.conflicts, []);
});

test('runDirName is UTC and matches RUN_DIR_RE', () => {
  const name = runDirName(new Date('2026-11-26T15:30:05Z'), 's-a41f00');
  assert.equal(name, '20261126-153005-s-a41f00'); assert.match(name, RUN_DIR_RE);
  assert.throws(() => runDirName(new Date(), '../x'));
});

test('writeRun redacts page content, keeps kernel identifiers, writes 0600 files in a 0700 dir', () => {
  const runDir = join(tmp, 'runs', 'session', 'one');
  const longName = 'a'.repeat(40);
  const longSelector = '[data-testid="' + 'Ab1'.repeat(20) + '"]';
  const out = writeRun(runDir, buildResult(input({ name: longName, findings: [{ claim: 'c', basis: jwt }],
    start: { url: 'http://localhost/?token=abc123', viewport: null, touch: false, profile: 'default' },
    actions: [act('click', 'ok', { target: { given: 'e2', stable: { selector: longSelector, via: 'testid' } } })] })));
  const saved = JSON.parse(readFileSync(out.resultPath, 'utf8'));
  assert.equal(saved.name, longName); assert.equal(saved.actions[0].target.stable.selector, longSelector);
  assert.equal(saved.session, 's-a41f00');
  for (const f of [out.reportPath, out.resultPath]) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!text.includes(jwt)); assert.ok(!text.includes('abc123')); assert.equal(statSync(f).mode & 0o777, 0o600);
  }
  assert.equal(statSync(runDir).mode & 0o777, 0o700);
  assert.ok(readFileSync(out.reportPath, 'utf8').includes('<h1>'));
});

test('writeRun keeps an eval hash and its output, and still redacts a token in the output', () => {
  const hash = 'sha256:0123456789abcdef';
  const out = writeRun(join(tmp, 'r-eval'), buildResult(input({ actions: [
    act('eval', 'ok', { output: '{"n":1}', jsHash: hash }), act('eval', 'ok', { output: `"${jwt}"`, jsHash: hash }), act('eval', 'ok', { outputOmitted: true, jsHash: hash })] })));
  const saved = JSON.parse(readFileSync(out.resultPath, 'utf8'));
  assert.equal(saved.actions[0].output, '{"n":1}'); assert.equal(saved.actions[0].jsHash, hash);
  assert.equal(saved.actions[2].outputOmitted, true); assert.equal(saved.actions[2].jsHash, hash);
  for (const f of [out.reportPath, out.resultPath]) assert.ok(!readFileSync(f, 'utf8').includes(jwt));
});

test('writeRun redacts host names and neutralises tags in both files', () => {
  const out = writeRun(join(tmp, 'r1'), buildResult(input({ hosts: [{ host: 'Ab1'.repeat(14) + '.example.com', mode: 'default' }],
    findings: [{ claim: '<img src=x onerror=1>', basis: jwt }] })));
  const json = readFileSync(out.resultPath, 'utf8');
  assert.ok(!json.includes(jwt)); assert.ok(!json.includes('Ab1'.repeat(14)));
  const html = readFileSync(out.reportPath, 'utf8');
  assert.ok(!html.includes(jwt)); assert.ok(!html.includes('<img src=x'));
});

test('writeRun: if redaction of a field throws, that field becomes a fixed marker, never the raw value', () => {
  const secret = 'raw-secret-marker-9921';
  const r = buildResult(input());
  r.findings = [{ claim: 'ok', get basis(): string { throw new Error(secret); } }];
  const out = writeRun(join(tmp, 'r2'), r);
  const json = readFileSync(out.resultPath, 'utf8');
  assert.equal(JSON.parse(json).findings, REDACTED); assert.ok(!json.includes(secret));
  const html = readFileSync(out.reportPath, 'utf8');
  assert.ok(!html.includes(secret)); assert.ok(html.includes('<html'));
});

test('report.html does not show op parameters; result.json keeps exactly what the recorder gave it', () => {
  const plain = 'plain-value-' + 'x'.repeat(6);
  const actions = [
    act('fill', 'ok', { op: { op: 'fill', target: 'e2', value: REDACTED } as Op }),
    act('fill', 'ok', { op: { op: 'fill', target: 'e3', value: plain } as Op }),
    act('fill', 'ok', { op: { op: 'fill', target: 'e4', value: `<b>v</b> ${jwt}` } as Op }),
  ];
  const out = writeRun(join(tmp, 'r-ops'), buildResult(input({ actions })));
  const html = readFileSync(out.reportPath, 'utf8');
  assert.ok(!html.includes(plain)); assert.ok(!html.includes('<b>v</b>')); assert.ok(!html.includes('eyJ'));
  assert.ok(!html.includes('参数')); assert.ok(!html.includes(REDACTED));
  const saved = JSON.parse(readFileSync(out.resultPath, 'utf8'));
  assert.equal(saved.actions[0].op.value, REDACTED);
  assert.equal(saved.actions[1].op.value, plain);
  assert.ok(!JSON.stringify(saved).includes(jwt));
});

test('writeRun refuses to write through a symlink that leaves the run directory', () => {
  const runDir = join(tmp, 'r3'); const outside = join(tmp, 'outside.json');
  mkdirSync(runDir, { mode: 0o700 }); writeFileSync(outside, 'keep');
  symlinkSync(outside, join(runDir, 'result.json'));
  assert.throws(() => writeRun(runDir, buildResult(input())));
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
});

function makeRuns(nameDir: string, count: number): string[] {
  mkdirSync(nameDir, { recursive: true });
  const names = Array.from({ length: count }, (_, i) => runDirName(new Date(Date.UTC(2026, 10, 1, 0, 0, i)), 's-a41f00'));
  for (const n of names) mkdirSync(join(nameDir, n));
  return names;
}

test('pruneRuns keeps the newest N and touches nothing else', () => {
  const nameDir = join(tmp, 'name'); const names = makeRuns(nameDir, 22);
  mkdirSync(join(nameDir, 'notes'));
  const outsideTarget = join(tmp, 'outside'); mkdirSync(outsideTarget);
  const link = join(nameDir, runDirName(new Date(Date.UTC(2026, 9, 1)), 's-b00001'));   // 合规命名，比所有真目录都老
  symlinkSync(outsideTarget, link);
  writeFileSync(join(nameDir, runDirName(new Date(Date.UTC(2026, 9, 2)), 's-b00002')), 'a file, not a directory');
  const removed = pruneRuns(nameDir, 20, new Set());
  assert.deepEqual(removed, [names[0], names[1]]);
  assert.ok(existsSync(join(nameDir, 'notes'))); assert.ok(existsSync(outsideTarget)); assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(existsSync(join(nameDir, names[2]!)));
});

test('pruneRuns: oldest dir is kept when excluded', () => {
  const nameDir = join(tmp, 'name'); const names = makeRuns(nameDir, 5);
  const removed = pruneRuns(nameDir, 3, new Set([names[0]!]));
  assert.deepEqual(removed, [names[1]]);
  assert.ok(existsSync(join(nameDir, names[0]!))); assert.ok(!existsSync(join(nameDir, names[1]!)));
});

test('pruneRuns on a missing directory removes nothing and rejects a bad keep', () => {
  assert.deepEqual(pruneRuns(join(tmp, 'nope'), 20, new Set()), []);
  assert.throws(() => pruneRuns(tmp, -1, new Set()));
});

test('an allowedBy value that is a key of Object.prototype is shown as unknown, not looked up on the prototype chain', () => {
  for (const v of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = buildResult(input({ writes: [write('POST', 'http://x.example.com/a', 200, { allowedBy: v as never })] }));
    assert.ok(section(renderReport(r), 'writes').includes('放行依据 未知'), v);
  }
});

test('declarations: result.json carries them as given; with none it is an empty array', () => {
  assert.deepEqual(buildResult(input({})).declarations, []);
  const given = [{ method: 'POST', url: 'http://localhost/a', operation: 'Save', approved: 'dialog' as const }, { method: 'DELETE', url: 'http://localhost/b', operation: null, approved: 'remembered' as const }];
  const r = buildResult(input({ declarations: given }));
  assert.deepEqual(r.declarations, given);
  assert.notEqual(r.declarations[0], given[0], 'a copy, not the same object');
});

test('the report lists the declarations: method, address, operation or the whole address, and how they were approved; nothing is listed when there are none', () => {
  const none = section(renderReport(buildResult(input({}))), 'declarations');
  assert.ok(none.includes('<p>无</p>'));
  const html = section(renderReport(buildResult(input({ declarations: [
    { method: 'POST', url: 'http://localhost/graphql', operation: 'Save', approved: 'dialog' },
    { method: 'DELETE', url: 'http://localhost/items/*', operation: null, approved: 'remembered' },
    { method: 'POST', url: 'http://localhost/<b>x</b>', operation: '<i>' as never, approved: 'other' as never },
  ] }))), 'declarations');
  assert.ok(html.includes('POST') && html.includes('http://localhost/graphql') && html.includes('operation Save') && html.includes('弹框批准'));
  assert.ok(html.includes('DELETE') && html.includes('这个地址上的所有写') && html.includes('沿用之前的批准'));
  assert.ok(html.includes('未知'), 'an unknown approval value is shown as unknown');
  assert.ok(!html.includes('<b>x</b>') && !html.includes('<i>'), 'escaped');
});

test('identity: result.json carries the counts as given; with none given (group without identity) it is null', () => {
  assert.equal(buildResult(input({})).identity, null);
  assert.equal(buildResult(input({ identity: null })).identity, null);
  const given = { group: 'a', checks: 3, skipped: 1, mismatch: false };
  const r = buildResult(input({ identity: given }));
  assert.deepEqual(r.identity, given);
  assert.notEqual(r.identity, given, 'a copy, not the same object');
});

test('identity: the report has a section only when the group has an identity; a mismatch is flagged; only the group name and counts are shown', () => {
  assert.equal(section(renderReport(buildResult(input({}))), 'identity'), '');
  const ok = section(renderReport(buildResult(input({ identity: { group: 'a', checks: 3, skipped: 1, mismatch: false } }))), 'identity');
  assert.ok(ok.includes('组 a') && ok.includes('核对 3 次') && ok.includes('跳过 1 次') && ok.includes('未发现不符') && !ok.includes('identity-mismatch'));
  const bad = renderReport(buildResult(input({ identity: { group: 'a<b>', checks: 1, skipped: 0, mismatch: true } })));
  assert.ok(section(bad, 'identity').includes('id="identity-mismatch"') && section(bad, 'identity').includes('a&lt;b&gt;'));
  const old = JSON.parse(JSON.stringify(buildResult(input({})))) as Record<string, unknown>;
  delete old.identity;   // 老版本的 result.json 没有这个字段
  assert.equal(section(renderReport(old as never), 'identity'), '');
});

test('frozen: result.json carries it as given; a session that was not frozen has null', () => {
  assert.equal(buildResult(input({})).frozen, null);
  assert.equal(buildResult(input({ frozen: null })).frozen, null);
  const given = { group: 'a', host: 'b.example.com' };
  const r = buildResult(input({ frozen: given }));
  assert.deepEqual(r.frozen, given);
  assert.notEqual(r.frozen, given, 'a copy, not the same object');
  assert.deepEqual(buildResult(input({ frozen: { group: null, host: null } })).frozen, { group: null, host: null });
});

// 模式一节下集中显示：profile、放行声明、身份探针、冻结。每段只出现一次，不另起顶层小节。
test('the mode section gathers profile, declarations, identity probe and freeze under their own headings, each once', () => {
  const html = renderReport(buildResult(input({
    start: { url: 'http://localhost/', viewport: null, touch: false, profile: 'a', borrowed: true },
    declarations: [{ method: 'POST', url: 'http://localhost/a', operation: null, approved: 'dialog' }],
    identity: { group: 'a', checks: 2, skipped: 0, mismatch: true }, frozen: { group: 'b', host: 'b.example.com' },
  })));
  const modes = section(html, 'modes');
  const headings = [...modes.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(headings, ['profile', '放行声明', '身份探针', '冻结']);
  for (const title of ['profile', '放行声明', '身份探针', '冻结']) assert.equal(html.split(`>${title}</h`).length - 1, 1, title);
  assert.ok(!html.includes('<section id="declarations">') && !html.includes('<section id="identity">'), 'no separate top-level sections');
  assert.ok(section(modes, 'mode-profile').includes('profile a（借用）'));
  assert.ok(section(modes, 'declarations').includes('http://localhost/a') && section(modes, 'declarations').includes('弹框批准'));
  assert.ok(section(modes, 'identity').includes('id="identity-mismatch"') && section(modes, 'identity').includes('核对 2 次'));
  assert.ok(section(modes, 'frozen').includes('组 b') && section(modes, 'frozen').includes('b.example.com'));
  // 全程默认模式的早返回路径也带这几段
  const plain = section(renderReport(buildResult(input({ frozen: { group: null, host: null } }))), 'modes');
  assert.ok(plain.includes('全程默认模式') && plain.includes('<h3>profile</h3>') && plain.includes('<h3>放行声明</h3>') && plain.includes('<h3>冻结</h3>'));
});

test('freeze: the reason names the group and the redacted host; an unknown group is said so; no freeze means no freeze heading', () => {
  const known = section(renderReport(buildResult(input({ frozen: { group: 'b', host: 'b.example.com' } }))), 'frozen');
  assert.ok(known.includes('组 b') && known.includes('b.example.com') && known.includes('冻结'), known);
  const unknown = section(renderReport(buildResult(input({ frozen: { group: null, host: null } }))), 'frozen');
  assert.ok(unknown.includes('判断不出归属') && !unknown.includes('组 null'), unknown);
  const none = renderReport(buildResult(input({})));
  assert.ok(!none.includes('<h3>冻结</h3>') && section(none, 'frozen') === '');
});

test('freeze, declarations, profile: page-derived values are redacted and escaped', () => {
  const html = renderReport(buildResult(input({
    start: { url: 'http://localhost/', viewport: null, touch: false, profile: 'p<i>q', borrowed: false },
    declarations: [{ method: 'P<b>', url: 'http://localhost/a<script>x</script>', operation: 'O<u>' as never, approved: 'dialog' }],
    frozen: { group: 'g<s>', host: `${jwt}.exa<em>mple.com` },
  })));
  const modes = section(html, 'modes');
  for (const raw of ['<script>', '<b>', '<i>', '<u>', '<s>', '<em>']) assert.ok(!modes.includes(raw), raw);
  assert.ok(modes.includes('a%3Cscript%3Ex') && modes.includes('P&lt;b&gt;') && modes.includes('O&lt;u&gt;') && modes.includes('g&lt;s&gt;') && modes.includes('p&lt;i&gt;q'));
  assert.ok(!html.includes(jwt), 'a token in the frozen host must not leak');
});

test('an older result.json without declarations, identity, frozen or start.borrowed still renders; the missing parts are absent, not an error', () => {
  const old = JSON.parse(JSON.stringify(buildResult(input({})))) as Record<string, unknown>;
  for (const k of ['declarations', 'identity', 'frozen']) delete old[k];
  delete (old.start as Record<string, unknown>).borrowed;
  const modes = section(renderReport(old as never), 'modes');
  assert.ok(modes.includes('<h3>profile</h3>') && modes.includes('profile default') && !modes.includes('借用'));
  assert.ok(section(modes, 'identity') === '' && section(modes, 'frozen') === '');
  assert.ok(section(modes, 'declarations').includes('<p>无</p>'));
  for (const bad of [null, 'x', 5, []]) {
    const r = JSON.parse(JSON.stringify(old)) as Record<string, unknown>;
    r.frozen = bad; r.identity = bad; r.declarations = bad;
    assert.doesNotThrow(() => renderReport(r as never), String(bad));
    const m = section(renderReport(r as never), 'modes');
    assert.ok(section(m, 'frozen') === '' && section(m, 'identity') === '', `a malformed value (${JSON.stringify(bad)}) shows no freeze or identity block`);
  }
});
