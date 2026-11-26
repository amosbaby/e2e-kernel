import type { Check } from '../driver/types.ts';
import type { StatusResult } from '../kernel/server.ts';
import type { CloseResult, OpResult, OpenResult, StepResult, Tallies } from '../shared/protocol.ts';

// CLI 的紧凑文本输出。打印的内容都来自内核的回应（内核已经脱敏），这里只排版，不加回任何调用方给的原值。

const OUTCOME_TEXT: Record<OpResult['outcome'], string> = {
  'ok': '完成', 'match': '相符', 'mismatch': '不符', 'failed': '执行失败', 'not-run': '未执行',
};

// 一个值放在一行里：换行改写成字面的 \n，不让它冒充下一行。
function inline(v: unknown): string {
  return String(v).replace(/\r\n|\r|\n/g, '\\n');
}

function firstLine(s: string): string {
  return s.split(/\r\n|\r|\n/)[0] ?? '';
}

function indent(s: string): string {
  return s.split(/\r\n|\r|\n/).map((line) => `  ${line}`).join('\n');
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
  let line = `#${r.index + 1} ${r.op} ${OUTCOME_TEXT[r.outcome]}`;
  if (r.outcome === 'mismatch') line += ` 实测=${inline(r.actual ?? null)} 期望=${inline(r.expected ?? '')}`;
  if (r.outcome === 'failed' && r.error !== undefined) line += ` ${firstLine(r.error)}`;
  if (r.shot !== undefined) line += ` ${r.shot}`;
  return r.output === undefined ? line : `${line}\n${outputText(r.output)}`;
}

export function formatOpen(r: OpenResult): string {
  return [`${r.session} ${r.name} 模式 ${r.mode}`, `地址 ${inline(r.url)}`, `标题 ${inline(r.title)}`, `记录目录 ${r.runDir}`, r.snapshot].join('\n');
}

export function formatStep(r: StepResult): string {
  return [`${r.session} ${tallyText(r.tallies)}`, ...r.results.map(opLine)].join('\n');
}

export function formatClose(r: CloseResult): string {
  const lines = [`${r.session} 已收尾`, `报告 ${r.reportPath}`, `结果 ${r.resultPath}`, tallyText(r.tallies)];
  if (r.consistency === 'conflict') lines.push('结论与记录不一致');
  return lines.join('\n');
}

export function formatStatus(r: StatusResult): string {
  const c = r.driver.capabilities;
  const lines = [
    `版本 ${r.version}  pid ${r.pid}`,
    `状态目录 ${r.home}`,
    `驱动 ${r.driver.name}（网络拦截 ${c.networkInterception ? '能' : '不能'}，跨进程 iframe ${c.crossProcessIframes}，` +
      `原生表单提交 ${c.nativeFormSubmit}，选择器 ${c.selectorDialect}）`,
    `浏览器 ${r.instance === 'running' ? '在运行' : '未启动'}`,
    `会话 ${r.sessions.length} 个`,
    ...r.sessions.map((s) => `  ${s.session} ${s.name} 闲置 ${s.idleSec} 秒 ${inline(s.url)}`),
  ];
  return lines.join('\n');
}

export function formatChecks(c: Check[]): string {
  return c.map((x) => {
    const line = `${x.ok ? '[ok]  ' : '[失败]'} ${x.name}：${inline(x.detail)}`;
    return x.fix === undefined ? line : `${line}\n  修复：${inline(x.fix)}`;
  }).join('\n');
}

export function formatError(e: { code: string; message: string; next?: string }): string {
  const line = `错误（${e.code}）：${e.message}`;
  return e.next === undefined ? line : `${line}\n${e.next}`;
}
