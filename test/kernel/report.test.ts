import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capabilities } from '../../src/driver/types.ts';
import type { ActionRecord, WriteRecord } from '../../src/kernel/recorder.ts';
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
    decision: 'allowed', targetMode: 'default', ...extra };
}
function driverWith(caps: Partial<Capabilities> = {}): RunInput['driver'] {
  return { name: 'fake', capabilities: { networkInterception: true, crossProcessIframes: 'covered', nativeFormSubmit: 'covered',
    sharesUserProfile: false, canHeadless: false, selectorDialect: 'css', ...caps } };
}
function input(o: Partial<RunInput> = {}): RunInput {
  return { kernelVersion: '0.1.0', session: 's-a41f00', name: 'session', startedAt: new Date('2026-11-26T15:30:00Z'),
    endedAt: new Date('2026-11-26T15:31:00Z'), closedBy: 'agent', start: { url: 'http://localhost/', viewport: null, profile: 'default' },
    driver: driverWith(), actions: [], writes: [], unattributedWrites: [], hosts: [{ host: 'localhost', mode: 'default' }], webSockets: 0,
    verdict: null, findings: [], notDone: [], superseded: [], ...o };
}
function textOf(html: string, id: string): string {
  const m = new RegExp(`<p id="${id}">([^<]*)</p>`).exec(html);
  assert.ok(m, `no element #${id}`);
  return m[1]!;
}
function outcomes(html: string): string[] {
  return [...html.matchAll(/<td class="outcome">([^<]*)<\/td>/g)].map((m) => m[1]!);
}
function section(html: string, id: string): string {
  return new RegExp(`<section id="${id}">.*?</section>`, 's').exec(html)?.[0] ?? '';
}

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'e2k-report-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

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

test('html escapes everything that came from the page', () => {
  const html = renderReport(buildResult(input({ start: { url: 'http://localhost/?q=<b>x</b>', viewport: null, profile: 'default' },
    actions: [act('click', 'failed', { error: '<script>window.pwned=1</script>', shot: 'shots/01.jpg"><img src=x onerror=1' })] })));
  assert.ok(!html.includes('<script')); assert.ok(!html.includes('<b>x</b>')); assert.ok(!html.includes('onerror=1"'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('Content-Security-Policy'));
});

test('a valid screenshot path becomes an img, anything else does not', () => {
  const html = renderReport(buildResult(input({ actions: [act('screenshot', 'ok', { shot: 'shots/01.jpg' }), act('screenshot', 'ok', { shot: '../x.jpg' })] })));
  assert.equal(html.match(/<img /g)?.length, 1); assert.ok(html.includes('<img src="shots/01.jpg"'));
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
    driver: driverWith({ nativeFormSubmit: 'unknown' }),
    actions: [act('click', 'ok', { target: { given: 'e2', stable: { selector: '#a', via: 'id' } }, shot: 'shots/01.jpg' }),
      act('assert', 'match', { actual: 1, expected: 1, error: 'e' }),
      act('click', 'failed', { seq: 9001, target: { given: '#b', stable: null }, error: 'other: x', hints: ['2 matches', '1) button "A" >> nth=0'] }),
      act('screenshot', 'ok', { seq: 9002 }),
      act('eval', 'ok', { output: '1', jsHash: 'sha256:0123456789abcdef' }), act('eval', 'ok', { outputOmitted: true, jsHash: 'sha256:0123456789abcdef' })],
    writes: [write('POST', 'http://localhost/a', 200, { body: '{}', pageUrl: 'http://localhost/' }), write('POST', 'http://localhost/c', 200, { bodyOmitted: true })],
    unattributedWrites: [write('PUT', 'http://localhost/b', null)],
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
  for (const k of ['superseded', 'by', 'conflicts', 'failedOp', 'failedTarget', 'byOp', 'byTarget', 'byReadOnly']) assert.ok(keys.has(k), k);
  assert.ok(Array.isArray(r.conflicts));
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
    start: { url: 'http://localhost/?token=abc123', viewport: null, profile: 'default' },
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
