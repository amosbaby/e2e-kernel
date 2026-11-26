import type { ActionRecord, WriteRecord } from '../kernel/recorder.ts';
import { safely } from '../kernel/recorder.ts';
import { escapeHtml } from '../shared/escape.ts';
import { conflictText } from '../shared/protocol.ts';
import type { Outcome, VerdictValue } from '../shared/protocol.ts';
import { REDACTED, redactBody, redactSelector, redactText, redactUrl } from '../shared/redact.ts';
import type { ClosedBy, RunResult, SupersededEntry } from './result.ts';

// 报告页（设计 5.3）。纯函数，不含脚本，不引外部资源。
// 页面内容的处理顺序固定：先脱敏、再截断、最后 escapeHtml。脱敏出错时给固定标记，绝不输出原值。
// 内核自己的值（会话名、路径、操作名）不脱敏，只 escapeHtml。选择器在 store.ts 的 sanitize 里已经脱敏过，这里只转义。

const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
const SHOT_PATH = /^shots\/\d{2,}(-[a-z0-9][a-z0-9-]{0,39})?\.(jpg|png)$/;
const DISPLAY_MAX = 500;

const VERDICT_TEXT: Record<VerdictValue, string> = {
  pass: '通过', fail: '不通过', exists: '存在', absent: '不存在', undetermined: '无法判断',
};
const OUTCOME_TEXT: Record<Outcome, string> = {
  'ok': '完成', 'match': '相符', 'mismatch': '不符', 'failed': '执行失败', 'not-run': '未执行',
};
const CLOSED_BY_TEXT: Record<ClosedBy, string> = {
  'agent': 'agent 关闭会话', 'idle-timeout': '闲置超时', 'kernel-shutdown': '内核关闭',
  'browser-gone': '浏览器被关闭', 'page-gone': '会话的页面被关闭',
};

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[已截断，共 ${s.length} 字符]` : s;
}

// 页面内容：脱敏 → 截断 → 转义。非字符串进 redactText 会抛错，同样落到固定标记。
function page(v: unknown, max = DISPLAY_MAX): string {
  return escapeHtml(clip(safely(() => redactText(v as string)), max));
}

// 选择器：同样脱敏 → 截断 → 转义，只是按选择器的规则（`[名字=值]` 不吞掉后面的选择器）。
function pageSelector(v: unknown): string {
  return escapeHtml(clip(safely(() => redactSelector(v as string)), DISPLAY_MAX));
}

function pageUrl(v: unknown): string {
  return escapeHtml(clip(safely(() => redactUrl(v as string)), DISPLAY_MAX));
}

function pageBody(v: unknown): string {
  return escapeHtml(clip(safely(() => redactBody(v as string, null) ?? REDACTED), DISPLAY_MAX));
}

// 内核自己的值：只转义。
function own(v: unknown): string {
  return escapeHtml(typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : REDACTED);
}

function scalar(v: string | number | boolean | null | undefined): string {
  if (typeof v === 'string') return page(v);
  return v === undefined ? '' : escapeHtml(String(v));
}

function outcomeText(o: Outcome): string {
  return OUTCOME_TEXT[o] ?? '未知';
}

function listOrNone(items: string[]): string {
  return items.length === 0 ? '<p>无</p>' : `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

function targetCell(a: ActionRecord): string {
  if (a.target === undefined) return '';
  const given = `<code>${own(a.target.given)}</code>`;
  const stable = a.target.stable;
  return stable === null || stable.selector === a.target.given ? given : `${given}<br>稳定选择器 <code>${own(stable.selector)}</code>`;
}

function detailCell(a: ActionRecord): string {
  const parts: string[] = [];
  if (a.op.op === 'assert') parts.push(`实测 <code>${scalar(a.actual)}</code>，期望 <code>${scalar(a.expected)}</code>`);
  if (a.output !== undefined) parts.push(`返回值 <code>${page(a.output)}</code>`);
  if (a.outputOmitted === true) parts.push('返回值未记录（页面有密码框，或判断不出）');
  if (a.jsHash !== undefined) parts.push(`源码哈希 <code>${own(a.jsHash)}</code>`);
  if (a.error !== undefined) parts.push(`错误 ${page(a.error)}`);
  if (Array.isArray(a.hints) && a.hints.length > 0) parts.push(`诊断<br>${a.hints.map((h) => page(h)).join('<br>')}`);
  return parts.join('<br>');
}

function shotCell(a: ActionRecord): string {
  if (a.shot === undefined) return '';
  // 路径只接受固定形状的值；别的一律不当图片用。
  return SHOT_PATH.test(a.shot) ? `<img src="${escapeHtml(a.shot)}" alt="截图 ${escapeHtml(a.shot)}">` : '截图路径无效';
}

function stepRow(a: ActionRecord): string {
  return `<tr><td>${own(a.seq)}</td><td>${own(a.op.op)}</td><td>${targetCell(a)}</td>`
    + `<td class="outcome">${outcomeText(a.outcome)}</td><td>${detailCell(a)}</td><td>${shotCell(a)}</td></tr>`;
}

function writeItem(w: WriteRecord): string {
  const status = w.failed ? '失败' : w.status === null ? '无状态码' : String(w.status);
  const flag = w.targetMode === 'default' ? '' : ` <strong class="flag">非默认模式域名（${own(w.targetMode)}）</strong>`;
  const body = w.bodyOmitted ? '<br>请求体未记录（发出它的页面有密码框，或判断不出）'
    : w.body === null ? '' : `<br>请求体 <code>${pageBody(w.body)}</code>`;
  return `<li><code>${page(w.method)} ${pageUrl(w.url)}</code> 时间 ${own(w.at)} 状态码 ${own(status)}${flag}${body}</li>`;
}

// 汇总表：只有主机名、方法、GraphQL 类型和计数，不带路径和请求体；不含未归属的写。
function summaryTable(r: RunResult): string {
  const { summary, unattributed } = r.writes;
  if (summary.length === 0) return '';
  const rows = summary.map((e) => `<tr><td>${page(e.host)}</td><td>${page(e.method)}</td><td>${e.graphql === null ? '—' : page(e.graphql)}</td>`
    + `<td>${own(e.allowed)}</td><td>${own(e.blocked)}</td></tr>`).join('');
  const n = unattributed.length;
  return `<table id="writes-summary"><thead><tr><th>主机</th><th>方法</th><th>GraphQL</th><th>放行</th><th>拦下</th></tr></thead><tbody>${rows}</tbody></table>`
    + `<p>不含未归属的写（${own(n)} 条${n > 0 ? '，见下' : ''}）</p>`;
}

function writesSection(r: RunResult): string {
  const { allowed, blocked, unattributed } = r.writes;
  let out = '<section id="writes"><h2>这次动了什么</h2>';
  if (allowed.length + blocked.length + unattributed.length === 0) return `${out}<p>无</p></section>`;
  out += summaryTable(r);
  if (allowed.length > 0) out += `<h3>放行的写</h3><ul>${allowed.map(writeItem).join('')}</ul>`;
  if (blocked.length > 0) out += `<h3>被拦下的写</h3><ul>${blocked.map(writeItem).join('')}</ul>`;
  if (unattributed.length > 0) {
    out += '<h3>未归属的写</h3><p>发生在本会话期间、无法确定来自哪个页面，可能属于同时进行的其他会话或人手开的标签页。</p>'
      + `<ul>${unattributed.map(writeItem).join('')}</ul>`;
  }
  return `${out}</section>`;
}

function verdictSection(r: RunResult): string {
  let out = '<section id="sec-verdict"><h2>结论</h2>';
  if (r.verdict === null) {
    out += '<p id="verdict">agent 未提交结论</p>';
  } else {
    out += `<p id="verdict">${VERDICT_TEXT[r.verdict.value] ?? '未知'}</p><p id="verdict-by">agent 判定</p>`;
    if (r.verdict.because !== undefined) out += `<p id="verdict-because">${page(r.verdict.because)}</p>`;
  }
  const t = r.tallies;
  out += `<p id="tallies">相符 ${own(t.match)} / 不符 ${own(t.mismatch)} / 执行失败 ${own(t.failed)} / 未执行 ${own(t.notRun)}</p>`;
  if (r.consistency === 'conflict') {
    out += '<p id="conflict">结论与记录不一致</p>';
    const reasons = Array.isArray(r.conflicts) ? r.conflicts.map((c) => escapeHtml(conflictText(c))) : [];
    if (reasons.length > 0) out += `<ul id="conflict-reasons">${reasons.map((c) => `<li>${c}</li>`).join('')}</ul>`;
  }
  return `${out}</section>`;
}

// 被取代的失败；记录坏了（不是数组）就当作没有取代：失败关闭，宁可多列。
function recoveries(r: RunResult): SupersededEntry[] {
  return Array.isArray(r.superseded) ? r.superseded : [];
}

function opWithTarget(seq: unknown, op: unknown, target: unknown): string {
  return `序号 ${own(seq)} ${own(op)}${typeof target === 'string' ? ` <code>${pageSelector(target)}</code>` : ''}`;
}

function recoveredItem(e: SupersededEntry, sharedBy: number): string {
  const note = e.byReadOnly === true ? '（取代者是只读操作）' : '';
  const shared = sharedBy > 1 ? `（此取代者同时取代了 ${sharedBy} 个失败）` : '';
  return `${opWithTarget(e.failed, e.failedOp, e.failedTarget)} → 由 ${opWithTarget(e.by, e.byOp, e.byTarget)} 取代${note}${shared}`;
}

// 失败分两组：agent 声明已恢复的（内核对着记录校验过，并列出两边的操作），和没解决的。未执行的操作在「没做的」里。
function failuresSection(r: RunResult): string {
  const recovered = new Set(recoveries(r).map((e) => e.failed));
  const unresolved = r.actions.filter((a) => a.outcome === 'failed' && !recovered.has(a.seq))
    .map((a) => `${opWithTarget(a.seq, a.op.op, a.target?.given)}（执行失败）`);
  return '<section id="failures"><h2>失败的操作</h2>'
    + `<h3>已恢复的失败</h3>${listOrNone(recoveries(r).map((e, _i, all) => recoveredItem(e, all.filter((x) => x.by === e.by).length)))}`
    + `<h3>未解决的失败</h3>${listOrNone(unresolved)}</section>`;
}

function notDoneSection(r: RunResult): string {
  const recovered = new Set(recoveries(r).map((e) => e.failed));
  const items = [
    ...r.notDone.map((s) => page(s)),
    ...r.actions.filter((a) => a.outcome === 'not-run' && !recovered.has(a.seq)).map((a) => `步骤 ${own(a.seq)}：${own(a.op.op)}（未执行）`),
  ];
  return `<section id="not-done"><h2>没做的</h2>${listOrNone(items)}</section>`;
}

function findingsSection(r: RunResult): string {
  const items = r.findings.map((f) => `${f.verdict === undefined ? '' : `[${escapeHtml(VERDICT_TEXT[f.verdict] ?? '未知')}] `}<strong>${page(f.claim)}</strong><br>依据 ${page(f.basis)}`);
  return `<section id="findings"><h2>agent 的各条结论和依据</h2>${listOrNone(items)}</section>`;
}

function stepsSection(r: RunResult): string {
  const head = '<tr><th>序号</th><th>操作</th><th>目标</th><th>结果</th><th>详情</th><th>截图</th></tr>';
  const body = r.actions.length === 0 ? '<tr><td colspan="6">无</td></tr>' : r.actions.map(stepRow).join('');
  return `<section id="steps"><h2>步骤</h2><table>${head}${body}</table></section>`;
}

function envSection(r: RunResult): string {
  const caps = r.driver.capabilities;
  const hosts = r.hosts.map((h) => `<li>${page(h.host)}：${own(h.mode)}</li>`);
  const capLines = [
    `网络层拦截：${own(caps.networkInterception)}`, `跨进程 iframe：${own(caps.crossProcessIframes)}`,
    `原生表单提交：${own(caps.nativeFormSubmit)}`, `共用用户 profile：${own(caps.sharesUserProfile)}`,
    `可无头：${own(caps.canHeadless)}`, `选择器方言：${own(caps.selectorDialect)}`,
  ];
  const notes = [`Service Worker：${own(r.coverage.serviceWorkers)}`, `WebSocket 连接数：${own(r.coverage.webSockets)}`,
    ...r.coverage.notes.map((n) => own(n))];
  const vp = r.start.viewport === null ? '默认' : `${own(r.start.viewport.width)}×${own(r.start.viewport.height)}`;
  return '<section id="env"><h2>环境</h2>'
    + `<h3>域名和当时的模式</h3>${listOrNone(hosts)}`
    + `<h3>驱动和能力</h3><p>${own(r.driver.name)}</p>${listOrNone(capLines)}`
    + `<h3>覆盖说明</h3>${listOrNone(notes)}`
    + `<p>起始地址 ${pageUrl(r.start.url)}，视口 ${vp}，触屏模拟 ${r.start.touch ? '是' : '否'}，profile ${own(r.start.profile)}</p>`
    + `<p>开始 ${own(r.startedAt)}，结束 ${own(r.endedAt)}，结束方式 ${CLOSED_BY_TEXT[r.closedBy] ?? '未知'}，内核版本 ${own(r.kernelVersion)}</p>`
    + (r.next === null ? '' : `<p>${own(r.next)}</p>`)
    + '</section>';
}

const STYLE = 'body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1d1d1f}'
  + 'h2{border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:32px}table{border-collapse:collapse;width:100%}'
  + 'td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}code{word-break:break-all}'
  + 'img{max-width:240px}.flag{color:#b00020}#conflict{color:#b00020;font-weight:bold}';

export function renderReport(r: RunResult): string {
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + `<title>e2e 报告 ${own(r.name)}</title><style>${STYLE}</style></head><body>`
    + `<h1>e2e 报告：${own(r.name)}（${own(r.session)}）</h1>`
    + verdictSection(r) + failuresSection(r) + notDoneSection(r) + findingsSection(r) + writesSection(r) + stepsSection(r) + envSection(r)
    + '</body></html>\n';
}
