import type { Capabilities } from '../driver/types.ts';
import type { ActionRecord, WriteRecord } from '../kernel/recorder.ts';
import { E2kError } from '../shared/errors.ts';
import { READ_OPS } from '../shared/ops.ts';
import type { Op, Viewport } from '../shared/ops.ts';
import { tally } from '../shared/protocol.ts';
import type { ConflictReason, Finding, Mode, Supersede, Tallies, Verdict } from '../shared/protocol.ts';
import { redactText, safely } from '../shared/redact.ts';

// 一场会话的结果（设计 5.3「留痕」）。字段名不得是脱敏意义上的敏感键（名字里不能带 auth、token 一类的片段）：
// 否则 writeRun 的脱敏会把整个值换掉。

export type ClosedBy = 'agent' | 'idle-timeout' | 'kernel-shutdown' | 'browser-gone' | 'page-gone';

export interface RunInput {
  kernelVersion: string; session: string; name: string; startedAt: Date; endedAt: Date; closedBy: ClosedBy;
  start: { url: string; viewport: Viewport | null; touch: boolean; profile: string };
  driver: { name: string; capabilities: Capabilities };
  actions: ActionRecord[]; writes: WriteRecord[]; unattributedWrites: WriteRecord[];
  hosts: { host: string; mode: Mode }[]; webSockets: number;
  verdict: Verdict | null; findings: Finding[]; notDone: string[];
  superseded: Supersede[];   // agent 声明的；buildResult 对着 actions 校验，再补上两边的操作名和目标
}

// 一条已恢复的失败：序号 failed 的失败 / 未执行，由之后的序号 by 的成功操作取代。op 和 target 来自记录，不来自 agent。
// target 是已脱敏的选择器或引用，没有就是 null。byReadOnly：取代者是只读操作（含 wait），而被取代的是动作（读一下页面或等一会儿不能证明动作做成了）。
export interface SupersededEntry {
  failed: number; by: number; failedOp: string; failedTarget: string | null; byOp: string; byTarget: string | null; byReadOnly: boolean;
}

// 写请求的汇总：已归属的写（放行加拦下）按主机 × 方法 × GraphQL 类型分组。host 是已脱敏的主机名，不带路径和请求体。
export interface WriteSummaryRow { host: string; method: string; graphql: WriteRecord['graphql']; allowed: number; blocked: number }

export interface RunResult {
  schema: 1; kernelVersion: string; session: string; name: string; startedAt: string; endedAt: string; closedBy: ClosedBy;
  start: RunInput['start']; driver: RunInput['driver']; hosts: RunInput['hosts'];
  verdict: Verdict | null; findings: Finding[]; notDone: string[]; superseded: SupersededEntry[];
  tallies: Tallies; consistency: 'ok' | 'conflict'; conflicts: ConflictReason[];
  actions: ActionRecord[];
  writes: { allowed: WriteRecord[]; blocked: WriteRecord[]; unattributed: WriteRecord[]; summary: WriteSummaryRow[] };
  approvals: never[];                 // M2 才有内容
  coverage: { serviceWorkers: 'blocked'; webSockets: number; notes: string[] };
  blocked: null;                      // M2 才有内容（等登录、等批准、身份不符、跳到不允许的域名）
  next: string | null;
}

const NEXT_BY_CLOSE: Partial<Record<ClosedBy, string>> = {
  'browser-gone': '浏览器已关闭，需要时重新 open',
  'page-gone': '会话的页面被关闭，需要时重新 open',
};

function coverageNotes(input: RunInput): string[] {
  const notes: string[] = [];
  if (input.webSockets > 0) notes.push('有 WebSocket 连接，不受写策略管');
  const caps = input.driver.capabilities;
  if (caps.crossProcessIframes !== 'covered') {
    notes.push('跨进程 iframe 里发出的请求不一定被写策略拦住，详见 docs/m0-findings.md');
  }
  if (caps.nativeFormSubmit !== 'covered') {
    notes.push('页面原生的表单提交不一定被写策略拦住，详见 docs/m0-findings.md');
  }
  return notes;
}

function usage(message: string): E2kError {
  return new E2kError('usage', message);
}

// 只读操作加 wait：都不改变页面，成功了也证明不了动作做成了。
function isNonAction(op: Op['op']): boolean {
  return READ_OPS.has(op) || op === 'wait';
}

function targetText(a: ActionRecord): string | null {
  return a.target === undefined ? null : safely(() => redactText(a.target!.given));
}

// 对着记录校验 agent 声明的「谁取代谁」，并补上两边的操作名和目标（不信 agent 给的）。不合格抛 usage，不回显任何给定的值。
// failed 只能是执行失败或未执行（mismatch 不可被取代）；by 只能是之后的完成或相符；同一个 failed 不能出现两次。
export function resolveSuperseded(actions: readonly ActionRecord[], declared: readonly Supersede[]): SupersededEntry[] {
  const bySeq = new Map<number, ActionRecord>(actions.map((a) => [a.seq, a]));
  const seen = new Set<number>();
  return declared.map((d, i) => {
    const name = `params.superseded[${i}]`;
    const failed = bySeq.get(d.failed);
    const by = bySeq.get(d.by);
    if (failed === undefined || (failed.outcome !== 'failed' && failed.outcome !== 'not-run')) {
      throw usage(`${name}.failed 不是执行失败或未执行的操作`);
    }
    if (by === undefined || (by.outcome !== 'ok' && by.outcome !== 'match') || d.by <= d.failed) {
      throw usage(`${name}.by 不是在它之后完成或相符的操作`);
    }
    if (seen.has(d.failed)) throw usage(`${name}.failed 已经被取代过`);
    seen.add(d.failed);
    return {
      failed: d.failed, by: d.by, failedOp: failed.op.op, failedTarget: targetText(failed), byOp: by.op.op, byTarget: targetText(by),
      byReadOnly: isNonAction(by.op.op) && !isNonAction(failed.op.op),
    };
  });
}

// 内核不改 agent 的结论，只把「说通过、记录却有不符 / 没解决的失败 / 没做」的矛盾标出来。
// 失败和未执行被取代了就不算；不符不可取代。tallies 仍是原始计数。
function conflictsOf(input: RunInput, resolved: readonly SupersededEntry[]): ConflictReason[] {
  if (input.verdict === null || input.verdict.value !== 'pass') return [];
  const recovered = new Set(resolved.map((e) => e.failed));
  const unresolved = (outcome: ActionRecord['outcome']): boolean => input.actions.some((a) => a.outcome === outcome && !recovered.has(a.seq));
  const out: ConflictReason[] = [];
  if (input.actions.some((a) => a.outcome === 'mismatch')) out.push('mismatch');
  if (unresolved('failed')) out.push('unresolved-failed');
  if (unresolved('not-run')) out.push('unresolved-not-run');
  if (input.notDone.length > 0) out.push('not-done');
  if (input.findings.some((f) => f.verdict === 'fail')) out.push('finding-fail');
  return out;
}

// 只统计已归属的写。method 转大写（fetch 不规范化大小写）。排序按 host、method、graphql（null 排在最前），用码点比较，结果稳定。
export function summarizeWrites(writes: readonly WriteRecord[]): WriteSummaryRow[] {
  const rows = new Map<string, WriteSummaryRow>();
  for (const w of writes) {
    const method = w.method.toUpperCase();
    const key = JSON.stringify([w.host, method, w.graphql]);
    let row = rows.get(key);
    if (row === undefined) {
      row = { host: w.host, method, graphql: w.graphql, allowed: 0, blocked: 0 };
      rows.set(key, row);
    }
    if (w.decision === 'allowed') row.allowed++; else row.blocked++;
  }
  const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows.values()].sort((a, b) => by(a.host, b.host) || by(a.method, b.method) || by(a.graphql ?? '', b.graphql ?? ''));
}

export function buildResult(input: RunInput): RunResult {
  const tallies = tally(input.actions);
  const superseded = resolveSuperseded(input.actions, input.superseded);
  const conflicts = conflictsOf(input, superseded);
  return {
    schema: 1,
    kernelVersion: input.kernelVersion,
    session: input.session,
    name: input.name,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    closedBy: input.closedBy,
    start: { ...input.start },
    driver: { name: input.driver.name, capabilities: { ...input.driver.capabilities } },
    hosts: input.hosts.map((h) => ({ ...h })),
    verdict: input.verdict === null ? null : { ...input.verdict },
    findings: input.findings.map((f) => ({ ...f })),
    notDone: [...input.notDone],
    superseded,
    tallies,
    consistency: conflicts.length > 0 ? 'conflict' : 'ok',
    conflicts,
    actions: [...input.actions],
    writes: {
      allowed: input.writes.filter((w) => w.decision === 'allowed'),
      blocked: input.writes.filter((w) => w.decision === 'blocked'),
      unattributed: [...input.unattributedWrites],
      summary: summarizeWrites(input.writes),
    },
    approvals: [],
    coverage: { serviceWorkers: 'blocked', webSockets: input.webSockets, notes: coverageNotes(input) },
    blocked: null,
    next: NEXT_BY_CLOSE[input.closedBy] ?? null,
  };
}
