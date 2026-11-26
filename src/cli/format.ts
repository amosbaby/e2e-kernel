import type { Check } from '../driver/types.ts';
import type { ProfileInfo } from '../kernel/profiles.ts';
import type { RulesFile } from '../kernel/rules.ts';
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

export function formatOpen(r: OpenResult): string {
  return [`${inline(r.session)} ${inline(r.name)} 模式 ${inline(r.mode)}`, `地址 ${inline(r.url)}`, `标题 ${inline(r.title)}`, `记录目录 ${inline(r.runDir)}`,
    ...waitLine(r), block(r.snapshot)].join('\n');
}

export function formatStep(r: StepResult): string {
  return [`${inline(r.session)} ${tallyText(r.tallies)}`, ...waitLine(r), ...r.results.map(opLine)].join('\n');
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

// 旧内核的 status 没有 rules：跳过这两行，不抛。
function rulesLines(rules: StatusResult['rules'] | undefined): string[] {
  if (rules === undefined) return [];
  return [
    rules.hash === null ? `规则 ${rules.count} 条` : `规则 ${rules.count} 条 ${inline(rules.hash)}`,
    ...(rules.error === null ? [] : [`规则文件有错，open 会被拒绝：${inline(rules.error)}`]),
  ];
}

export function formatStatus(r: StatusResult): string {
  const c = r.driver.capabilities;
  const lines = [
    `版本 ${inline(r.version)}  pid ${r.pid}`,
    `状态目录 ${inline(r.home)}`,
    `驱动 ${inline(r.driver.name)}（网络拦截 ${c.networkInterception ? '能' : '不能'}，跨进程 iframe ${inline(c.crossProcessIframes)}，` +
      `原生表单提交 ${inline(c.nativeFormSubmit)}，选择器 ${inline(c.selectorDialect)}）`,
    `浏览器 ${r.instance === 'running' ? '在运行' : '未启动'}`,
    `会话 ${r.sessions.length} 个`,
    ...r.sessions.map((s) => `  ${inline(s.session)} ${inline(s.name)} 闲置 ${s.idleSec} 秒 ${inline(s.url)}`),
    ...(r.profiles ?? []).map(profileLine),
    ...rulesLines(r.rules),
  ];
  return lines.join('\n');
}

// `rule list` 的结果：规则文件现在的样子，由 CLI 自己读，不经内核。
export interface RuleListResult extends RulesFile { path: string }

export function formatRuleList(r: RuleListResult): string {
  if (r.error !== null) return [`规则文件 ${inline(r.path)}`, inline(r.error)].join('\n');
  if (r.hash === null) return '没有 rules.json，所有域名都是默认模式';
  return [
    `规则文件 ${inline(r.path)}`,
    ...(r.rules.length === 0 ? ['（没有规则）'] : r.rules.map((x) => `${inline(x.match)}  ${inline(x.mode)}`)),
    `loginHosts  ${r.loginHosts.length === 0 ? '（无）' : r.loginHosts.map(inline).join(', ')}`,
    `hash  ${inline(r.hash)}`,
  ].join('\n');
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
