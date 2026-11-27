import type { Check } from '../driver/types.ts';
import type { ApprovalsStatus } from '../kernel/approval-store.ts';
import type { ProfileInfo } from '../kernel/profiles.ts';
import type { Rule, RulesFile } from '../kernel/rules.ts';
import type { StatusResult } from '../kernel/server.ts';
import { conflictText } from '../shared/protocol.ts';
import type { CloseResult, OpResult, OpenResult, StepResult, Tallies } from '../shared/protocol.ts';
import { redactText } from '../shared/redact.ts';

// CLI 的紧凑文本输出。打印的内容都来自内核的回应（内核已经脱敏），这里只排版，不加回任何调用方给的原值。

const OUTCOME_TEXT: Record<OpResult['outcome'], string> = {
  'ok': '完成', 'match': '相符', 'mismatch': '不符', 'failed': '执行失败', 'not-run': '未执行',
};

// 页面给的文字原样进终端会被当成控制序列（清行、上移光标、OSC 52 写剪贴板……），能改写人看到的汇总和不符行。
// 所以凡是可能带页面内容的字符串，C0（U+0000–U+001F）、DEL、C1（U+0080–U+009F）一律改写成可见的 \xNN；
// 多行输出里真正的换行保留（\r\n、\r、\n 都当换行，不让单独的 \r 把光标拉回行首）。
const LINE_BREAK = /\r\n|\r|\n/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function escapeControls(s: string): string {
  return s.replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// 多行文字：保留换行，每一行都过一遍控制字符改写。
function lines(s: string): string[] {
  return s.split(LINE_BREAK).map(escapeControls);
}

// 一个值放在一行里：换行改写成字面的 \n，不让它冒充下一行；其余控制字符改写成 \xNN。
function inline(v: unknown): string {
  return lines(String(v)).join('\\n');
}

function firstLine(s: string): string {
  return escapeControls(s.split(LINE_BREAK)[0] ?? '');
}

// 多行输出（快照、错误说明）：保留换行，不缩进。
function block(s: string): string {
  return lines(s).join('\n');
}

function indent(s: string): string {
  return lines(s).map((line) => `  ${line}`).join('\n');
}

function tallyText(t: Tallies): string {
  return `相符 ${t.match} / 不符 ${t.mismatch} / 执行失败 ${t.failed} / 未执行 ${t.notRun}`;
}

function outputText(output: NonNullable<OpResult['output']>): string {
  if (typeof output === 'string') return indent(output);
  if (output.length === 0) return '  （无）';
  return output.map((x) => ('level' in x
    ? `  [${inline(x.level)}] ${inline(x.text)}`
    : `  ${inline(x.method)} ${x.status ?? '-'} ${inline(x.url)} ${inline(x.resourceType)}`)).join('\n');
}

function opLine(r: OpResult): string {
  let line = `#${r.index + 1} 序号${r.seq} ${inline(r.op)} ${OUTCOME_TEXT[r.outcome]}`;
  if (r.outcome === 'mismatch') line += ` 实测=${inline(r.actual ?? null)} 期望=${inline(r.expected ?? '')}`;
  if (r.outcome === 'failed' && r.error !== undefined) line += ` ${firstLine(r.error)}`;
  if (r.shot !== undefined) line += ` ${inline(r.shot)}`;
  if (r.outcome === 'failed' && r.hints !== undefined && r.hints.length > 0) line += `\n${r.hints.map((h) => `  ${inline(h)}`).join('\n')}`;
  return r.output === undefined ? line : `${line}\n${outputText(r.output)}`;
}

function waitLine(r: { blocked: 'login' | null; next: string | null }): string[] {
  return r.blocked === 'login' && r.next !== null ? [`等登录：${inline(r.next)}`] : [];
}

// profile 总是打出来（`组` 或 `组@槽`）；老内核的回应没有 profile：不打。
function openProfileLine(r: OpenResult): string[] {
  return typeof r.profile === 'string' ? [`profile: ${inline(r.profile)}`] : [];
}

// 借用时多一行：组名取自 profile key（`组` 或 `组@槽`，借用不带槽）。老内核的回应没有 borrowed：当作没借用。
function borrowedLine(r: OpenResult): string[] {
  if (r.borrowed !== true) return [];
  const g = inline(String(r.profile).split('@', 1)[0] ?? '');
  return [`借用组 ${g} 的登录：发往 ${g} 的写按那边的模式判；不核对账号`];
}

// 身份探针没通过（不符，或这次没能确认）：醒目的一行，放在最前面。老内核的回应没有 identity：当作没探。不带页面上读到的任何文字（内核也没给）。
function identityLine(r: OpenResult): string[] {
  return r.identity === 'mismatch'
    ? ['!! 身份探针没通过：没能确认页面上的账号或租户就是组配置里期望的那个。确认是别的账号的，这个会话的 step 一律 22，要人关掉重开；只是没读到账号元素或读取出错的，只让这一次 step 22，下一次会重新探。先别继续，照下面的下一步处理']
    : [];
}

export function formatOpen(r: OpenResult): string {
  return [...identityLine(r), `${inline(r.session)} ${inline(r.name)} 模式 ${inline(r.mode)}`, `地址 ${inline(r.url)}`, `标题 ${inline(r.title)}`, `记录目录 ${inline(r.runDir)}`,
    ...openProfileLine(r), ...borrowedLine(r), ...waitLine(r), block(r.snapshot)].join('\n');
}

export function formatStep(r: StepResult): string {
  // 老内核的回应没有 notices：当作没有提示。
  const notices = Array.isArray(r.notices) ? r.notices : [];
  return [`${inline(r.session)} ${tallyText(r.tallies)}`, ...waitLine(r), ...notices.map((n) => `提示：${inline(n)}`), ...r.results.map(opLine)].join('\n');
}

export function formatClose(r: CloseResult): string {
  const out = [`${inline(r.session)} 已收尾`, `报告 ${inline(r.reportPath)}`, `结果 ${inline(r.resultPath)}`, tallyText(r.tallies)];
  if (r.consistency === 'conflict') {
    out.push('结论与记录不一致');
    // 原因来自内核的回应；不认识的值（版本不一致）不打印原文，只给固定说明。
    if (Array.isArray(r.conflicts) && r.conflicts.length > 0) {
      out.push(`原因：${r.conflicts.map(conflictText).join('；')}`);
    }
  }
  return out.join('\n');
}

// doctor 和 status 共用的措辞；枚举值只出现在 --json 里。
export const PROFILE_STATE_TEXT: Record<ProfileInfo['state'], string> = { missing: '目录还不存在', 'never-launched': '没启动过', launched: '用过' };

export function lastLoginText(p: ProfileInfo): string {
  return p.lastLogin === null ? '无' : `${inline(p.lastLogin.at)} ${inline(redactText(p.lastLogin.host))}`;
}

// 判断有没有登录态看最近一次 login，不看状态：浏览器用过的目录里不一定登录过，会话窗口里手动登录也不记在这里。
function profileLine(p: ProfileInfo): string {
  return `profile ${inline(p.name)} ${PROFILE_STATE_TEXT[p.state]}，最近一次 login ${lastLoginText(p)}`;
}

// 旧内核的 status 没有 rules：跳过这些行，不抛；旧内核没有批准相关的字段也不抛。
function rulesLines(rules: StatusResult['rules'] | undefined): string[] {
  if (rules === undefined) return [];
  return [
    rules.hash === null ? `规则 ${rules.count} 条` : `规则 ${rules.count} 条 ${inline(rules.hash)}`,
    ...(rules.error === null ? [] : [`规则文件有错，open 会被拒绝：${inline(rules.error)}`]),
    ...(rules.pending == null ? [] : ['规则文件有未批准的改动：生效的仍是已批准的那份，只有新增或改成只读的规则条目已先生效（rule diff 查看）']),
    ...(rules.approvals === 'unreadable' ? ['批准记录读不了：现有规则全部要重新批准'] : []),
    ...(rules.approvalsChanged === true ? ['批准记录文件被外部改过：运行中仍按内存里的批准，重启内核时以磁盘上的为准'] : []),
  ];
}

export function formatStatus(r: StatusResult): string {
  const c = r.driver.capabilities;
  const lines = [
    `版本 ${inline(r.version)}  pid ${r.pid}`,
    `状态目录 ${inline(r.home)}`,
    `驱动 ${inline(r.driver.name)}（网络拦截 ${c.networkInterception ? '能' : '不能'}，跨进程 iframe ${inline(c.crossProcessIframes)}，` +
      `原生表单提交 ${inline(c.nativeFormSubmit)}，SharedWorker ${inline(c.sharedWorkers ?? 'unknown')}，选择器 ${inline(c.selectorDialect)}）`,
    `浏览器 ${r.instance === 'running' ? '在运行' : '未启动'}`,
    `会话 ${r.sessions.length} 个`,
    ...r.sessions.map((s) => `  ${inline(s.session)} ${inline(s.name)} 闲置 ${s.idleSec} 秒 ${inline(s.url)}`),
    ...(r.profiles ?? []).map(profileLine),
    ...rulesLines(r.rules),
  ];
  return lines.join('\n');
}

// `rule list` 的结果：规则文件现在的样子加批准状态，由 CLI 自己读，不经内核。
// 组只列名字、主机和各清单的条数：接口路径和身份探针留在文件里，不进输出。
// approved（每条规则、每个组）：和批准快照里的一样；顶层 approved：文件没有错、也没有未批准的改动。
export interface RuleGroupSummary {
  name: string; hosts: string[]; loginHosts: string[];
  readPosts: number; persistedQueries: number; logout: number; identity: boolean; approved: boolean;
}
// hostModes：登录时在没列明的主机上选的模式（批准记录里的）；writes：记住的放行声明（批准记录里的，scope 是 `组/页面主机`）。
export interface HostModeRow { host: string; mode: string }
export interface WriteDeclRow { scope: string; method: string; url: string; operation: string | null }
export interface RuleListResult extends Omit<RulesFile, 'groups' | 'rules'> {
  path: string; rules: (Rule & { approved: boolean })[]; groups: RuleGroupSummary[]; hostModes: HostModeRow[]; writes: WriteDeclRow[];
  approved: boolean; pending: boolean; approvals: ApprovalsStatus;
}

const APPROVED_TEXT = (ok: boolean): string => (ok ? '（已批准）' : '（未批准）');
const PENDING_LINE = '有未批准的改动（rule diff 查看）';
const UNREADABLE_LINE = '批准记录读不了：现有规则全部要重新批准';

const MODE_TEXT: Record<string, string> = { readonly: '只读', default: '默认' };

export function formatRuleList(r: RuleListResult): string {
  if (r.error !== null) return [`规则文件 ${inline(r.path)}`, inline(r.error)].join('\n');
  const notes = [...(r.pending ? [PENDING_LINE] : []), ...(r.approvals === 'unreadable' ? [UNREADABLE_LINE] : [])];
  const remembered = [
    ...r.hostModes.map((x) => `登录时选的模式  ${inline(x.host)}  ${inline(MODE_TEXT[x.mode] ?? x.mode)}`),
    ...r.writes.map((x) => `放行声明  ${inline(x.scope)}  ${inline(x.method)} ${inline(x.url)}  ${x.operation === null ? '整个地址' : `operation ${inline(x.operation)}`}`),
  ];
  if (r.hash === null) return [r.pending ? '没有 rules.json，但批准记录里还有规则，生效的仍是已批准的那份' : '没有 rules.json，所有域名都是默认模式', ...remembered, ...notes].join('\n');
  return [
    `规则文件 ${inline(r.path)}`,
    ...(r.rules.length === 0 ? ['（没有规则）'] : r.rules.map((x) => `${inline(x.match)}  ${inline(x.mode)}  ${APPROVED_TEXT(x.approved)}`)),
    `loginHosts  ${r.loginHosts.length === 0 ? '（无）' : r.loginHosts.map(inline).join(', ')}`,
    ...r.groups.map((g) => `组 ${inline(g.name)}  hosts ${g.hosts.map(inline).join(', ')}  loginHosts ${g.loginHosts.length === 0 ? '（无）' : g.loginHosts.map(inline).join(', ')}`
      + `  readPosts ${g.readPosts}  persistedQueries ${g.persistedQueries}  logout ${g.logout}  identity ${g.identity ? '有' : '无'}  ${APPROVED_TEXT(g.approved)}`),
    `hash  ${inline(r.hash)}`,
    ...remembered,
    ...notes,
  ].join('\n');
}

// `rule diff` 的结果：规则文件和批准快照之间的完整差异（不截断）。
export interface RuleDiffResult { path: string; approvals: ApprovalsStatus; pending: boolean; hash: string | null; lines: string[]; error: string | null }

export function formatRuleDiff(r: RuleDiffResult): string {
  if (r.error !== null) return [`规则文件 ${inline(r.path)}`, inline(r.error)].join('\n');
  const unreadable = r.approvals === 'unreadable' ? [UNREADABLE_LINE] : [];
  if (!r.pending) return [...unreadable, '没有未批准的改动'].join('\n');
  // 待批文件的短哈希：sha256: 加前 12 位十六进制；文件被删了没有哈希。
  const head = r.hash === null ? '待批文件 无（文件被删了）' : `待批文件 ${inline(r.hash.slice(0, 'sha256:'.length + 12))}`;
  return [head, ...unreadable, ...r.lines.map(inline)].join('\n');
}

export function formatChecks(c: Check[]): string {
  return c.map((x) => {
    const line = `${x.ok ? '[ok]  ' : '[失败]'} ${inline(x.name)}：${inline(x.detail)}`;
    return x.fix === undefined ? line : `${line}\n  修复：${inline(x.fix)}`;
  }).join('\n');
}

export function formatError(e: { code: string; message: string; next?: string }): string {
  const line = `错误（${inline(e.code)}）：${block(e.message)}`;
  return e.next === undefined ? line : `${line}\n${block(e.next)}`;
}
