import type { Capabilities } from '../driver/types.ts';
import type { ActionRecord, ModeChange, WriteRecord } from '../kernel/recorder.ts';
import type { BlockReason } from '../kernel/write-policy.ts';
import { E2kError } from '../shared/errors.ts';
import { READ_OPS } from '../shared/ops.ts';
import type { Op, Viewport } from '../shared/ops.ts';
import { tally } from '../shared/protocol.ts';
import type { ConflictReason, Finding, Mode, Supersede, Tallies, Verdict } from '../shared/protocol.ts';
import { redactSelector, safely } from '../shared/redact.ts';

// 一场会话的结果（设计 5.3「留痕」）。字段名不得是脱敏意义上的敏感键（名字里不能带 auth、token 一类的片段）：
// 否则 writeRun 的脱敏会把整个值换掉。

export type ClosedBy = 'agent' | 'idle-timeout' | 'kernel-shutdown' | 'browser-gone' | 'page-gone';

export interface RunInput {
  kernelVersion: string; session: string; name: string; startedAt: Date; endedAt: Date; closedBy: ClosedBy;
  // borrowed：借用了别的组的登录（没给就是 false）；deny：open 时人批准的不允许的域名授权（没有或没给是 null）；
  // borrowDeny：借用授权覆盖的组名（借的组里有不允许的域名、人批准了借用；没有或没给是 null）。
  start: { url: string; viewport: Viewport | null; touch: boolean; profile: string; borrowed?: boolean; deny?: DenyGrantRecord | null; borrowDeny?: string | null };
  driver: { name: string; capabilities: Capabilities };
  actions: ActionRecord[]; writes: WriteRecord[]; unattributedWrites: WriteRecord[];
  hosts: { host: string; mode: Mode }[]; webSockets: number;
  verdict: Verdict | null; findings: Finding[]; notDone: string[];
  superseded: Supersede[];   // agent 声明的；buildResult 对着 actions 校验，再补上两边的操作名和目标
  declarations: DeclarationRecord[];   // 放行声明：本会话提过且已批准的
  modes: ModeChange[];       // 模式变更时间线
  rules: { hash: string | null; count: number; pendingHash: string | null };   // hash、count：收尾时已批准的规则；pendingHash：同时生效（取更严）的待批文件
  blocked: 'login' | null;   // 会话最后一次登录墙检查的结果
  forced: boolean;           // open --readonly
  identity?: IdentityRecord | null;   // 身份探针的计数；组没配身份为 null（没给也是 null）
  frozen?: FrozenRecord | null;       // 会话被冻结时的记录；没冻结为 null（没给也是 null）
  deniedNavigations?: number;         // 被拒（abort）的不允许的域名的顶层导航次数（没给是 0）
}

// 身份探针的计数，不含任何页面文字。checks：真正做了比较的探测次数（含不符，不含跳过）；skipped：前提不满足而跳过的次数。
export interface IdentityRecord { group: string; checks: number; skipped: number; mismatch: boolean }

// 会话经重定向进了别的组的域名（或不允许的域名）而被冻结：group 是第一次跨进去的那个组，判断不出归属时是 null；host 是第一跳的主机（已脱敏），没有是 null；
// denied：第一次冻结的原因是进了不允许的域名（这时 group 是 null，也不清 cookie）。
export interface FrozenRecord { group: string | null; host: string | null; denied: boolean }

// open 时人批准的不允许的域名授权（R2）：host 只有打开的那个主机；mode 是人选的「只读」或「可写」；allow 是选「可写」时 open --allow 的放行清单（其余为空）。
// 主机和地址在 result.json 里同其他地址一样脱敏。
export interface DenyGrantRecord { host: string; mode: 'readonly' | 'writable'; allow: { method: string; url: string; operation: string | null }[] }

// 本会话提过、人批准了的放行声明（url 是规范化后的地址，不带查询串）。approved：本次在弹框里批准的 / 之前批准过、这次沿用的。
// seq：提出这条声明的那次 step 的第一个操作的会话序号（同一条在之后的 step 里再提，沿用第一次的序号）；用例的 allow 靠它挂回那一批。
export interface DeclarationRecord { method: string; url: string; operation: string | null; approved: 'dialog' | 'remembered'; seq: number }

// 一条已恢复的失败：序号 failed 的失败 / 未执行，由之后的序号 by 的成功操作取代。op 和 target 来自记录，不来自 agent。
// target 是已脱敏的选择器或引用，没有就是 null。byReadOnly：取代者是只读操作（含 wait），而被取代的是动作（读一下页面或等一会儿不能证明动作做成了）。
export interface SupersededEntry {
  failed: number; by: number; failedOp: string; failedTarget: string | null; byOp: string; byTarget: string | null; byReadOnly: boolean;
}

// 写请求的汇总：已归属的写（放行加拦下）按主机 × 方法 × GraphQL 类型分组。host 是已脱敏的主机名，不带路径和请求体。
export interface WriteSummaryRow { host: string; method: string; graphql: WriteRecord['graphql']; allowed: number; blocked: number }

// 被拦下的写按主机 × 方法 × 原因分组（含未归属的，用 unattributed 区分）。host 是已脱敏的主机名，不带路径和请求体。
// reason 是 'unknown'：被拦的写没有记原因（现在没有这种路径；将来有人加了拦截路径却漏了 reason 时，它也不会从汇总里消失）。
export interface BlockedSummaryRow { host: string; method: string; reason: BlockReason | 'unknown'; count: number; unattributed: boolean }

export interface RunResult {
  schema: 1; kernelVersion: string; session: string; name: string; startedAt: string; endedAt: string; closedBy: ClosedBy;
  start: Omit<RunInput['start'], 'borrowed' | 'deny' | 'borrowDeny'> & { borrowed: boolean; deny: DenyGrantRecord | null; borrowDeny: string | null; readonly: boolean }; driver: RunInput['driver']; hosts: RunInput['hosts'];
  modes: ModeChange[]; rules: RunInput['rules'];
  verdict: Verdict | null; findings: Finding[]; notDone: string[]; superseded: SupersededEntry[];
  declarations: DeclarationRecord[];
  identity: IdentityRecord | null;
  frozen: FrozenRecord | null;
  deniedNavigations: number;
  tallies: Tallies; consistency: 'ok' | 'conflict'; conflicts: ConflictReason[];
  actions: ActionRecord[];
  writes: { allowed: WriteRecord[]; blocked: WriteRecord[]; unattributed: WriteRecord[]; summary: WriteSummaryRow[]; blockedSummary: BlockedSummaryRow[] };
  approvals: never[];                 // M2 才有内容
  coverage: { serviceWorkers: 'blocked'; webSockets: number; notes: string[] };
  blocked: 'login' | null;            // 会话最后一次登录墙检查的结果（R8：仍只有这两个值）；跳到不允许的域名被拦、冻结的事实记在 start.deny、start.borrowDeny、writes.blocked 和 frozen.denied
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
  if (caps.sharedWorkers !== 'covered') {
    notes.push('SharedWorker 发出的请求不一定被写策略拦住，详见 docs/m0-findings.md');
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
  return a.target === undefined ? null : safely(() => redactSelector(a.target!.given));
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

// 被拦下的写：已归属的和未归属的各自分组，按 host、method、reason、unattributed（false 在前）排序，码点比较。
// 被拦的写 reason 应该都有值；是 null 的归入固定的 'unknown'，保证汇总的次数加起来等于被拦的写的总数。
export function summarizeBlocked(writes: readonly WriteRecord[], unattributed: readonly WriteRecord[]): BlockedSummaryRow[] {
  const rows = new Map<string, BlockedSummaryRow>();
  const add = (list: readonly WriteRecord[], isUnattributed: boolean): void => {
    for (const w of list) {
      if (w.decision !== 'blocked') continue;
      const reason = w.reason ?? 'unknown';
      const method = w.method.toUpperCase();
      const key = JSON.stringify([w.host, method, reason, isUnattributed]);
      const row = rows.get(key);
      if (row === undefined) rows.set(key, { host: w.host, method, reason, count: 1, unattributed: isUnattributed });
      else row.count++;
    }
  };
  add(writes, false);
  add(unattributed, true);
  const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows.values()].sort((a, b) => by(a.host, b.host) || by(a.method, b.method) || by(a.reason, b.reason) || Number(a.unattributed) - Number(b.unattributed));
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
    start: {
      ...input.start, borrowed: input.start.borrowed === true, readonly: input.forced,
      deny: input.start.deny === undefined || input.start.deny === null ? null : { ...input.start.deny, allow: input.start.deny.allow.map((a) => ({ ...a })) },
      borrowDeny: input.start.borrowDeny ?? null,
    },
    driver: { name: input.driver.name, capabilities: { ...input.driver.capabilities } },
    hosts: input.hosts.map((h) => ({ ...h })),
    modes: input.modes.map((m) => ({ ...m })),
    rules: { ...input.rules },
    verdict: input.verdict === null ? null : { ...input.verdict },
    findings: input.findings.map((f) => ({ ...f })),
    notDone: [...input.notDone],
    superseded,
    declarations: input.declarations.map((d) => ({ ...d })),
    identity: input.identity === undefined || input.identity === null ? null : { ...input.identity },
    frozen: input.frozen === undefined || input.frozen === null ? null : { ...input.frozen },
    deniedNavigations: input.deniedNavigations ?? 0,
    tallies,
    consistency: conflicts.length > 0 ? 'conflict' : 'ok',
    conflicts,
    actions: [...input.actions],
    writes: {
      allowed: input.writes.filter((w) => w.decision === 'allowed'),
      blocked: input.writes.filter((w) => w.decision === 'blocked'),
      unattributed: [...input.unattributedWrites],
      summary: summarizeWrites(input.writes),
      blockedSummary: summarizeBlocked(input.writes, input.unattributedWrites),
    },
    approvals: [],
    coverage: { serviceWorkers: 'blocked', webSockets: input.webSockets, notes: coverageNotes(input) },
    blocked: input.blocked,
    next: NEXT_BY_CLOSE[input.closedBy] ?? null,
  };
}
