import type { Capabilities } from '../driver/types.ts';
import { tally } from '../kernel/executor.ts';
import type { ActionRecord, WriteRecord } from '../kernel/recorder.ts';
import type { Viewport } from '../shared/ops.ts';
import type { Finding, Mode, Tallies, Verdict } from '../shared/protocol.ts';

// 一场会话的结果（设计 5.3「留痕」）。字段名不得是脱敏意义上的敏感键（名字里不能带 auth、token 一类的片段）：
// 否则 writeRun 的脱敏会把整个值换掉。

export type ClosedBy = 'agent' | 'idle-timeout' | 'kernel-shutdown' | 'browser-gone' | 'page-gone';

export interface RunInput {
  kernelVersion: string; session: string; name: string; startedAt: Date; endedAt: Date; closedBy: ClosedBy;
  start: { url: string; viewport: Viewport | null; profile: string };
  driver: { name: string; capabilities: Capabilities };
  actions: ActionRecord[]; writes: WriteRecord[]; unattributedWrites: WriteRecord[];
  hosts: { host: string; mode: Mode }[]; webSockets: number;
  verdict: Verdict | null; findings: Finding[]; notDone: string[];
}

export interface RunResult {
  schema: 1; kernelVersion: string; session: string; name: string; startedAt: string; endedAt: string; closedBy: ClosedBy;
  start: RunInput['start']; driver: RunInput['driver']; hosts: RunInput['hosts'];
  verdict: Verdict | null; findings: Finding[]; notDone: string[];
  tallies: Tallies; consistency: 'ok' | 'conflict';
  actions: ActionRecord[];
  writes: { allowed: WriteRecord[]; blocked: WriteRecord[]; unattributed: WriteRecord[] };
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

// 内核不改 agent 的结论，只把「说通过、记录却有不符 / 失败 / 没做」的矛盾标出来。
function consistencyOf(verdict: Verdict | null, t: Tallies, notDone: readonly string[]): 'ok' | 'conflict' {
  const contradicted = t.mismatch > 0 || t.failed > 0 || t.notRun > 0 || notDone.length > 0;
  return verdict !== null && verdict.value === 'pass' && contradicted ? 'conflict' : 'ok';
}

export function buildResult(input: RunInput): RunResult {
  const tallies = tally(input.actions);
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
    tallies,
    consistency: consistencyOf(input.verdict, tallies, input.notDone),
    actions: [...input.actions],
    writes: {
      allowed: input.writes.filter((w) => w.decision === 'allowed'),
      blocked: input.writes.filter((w) => w.decision === 'blocked'),
      unattributed: [...input.unattributedWrites],
    },
    approvals: [],
    coverage: { serviceWorkers: 'blocked', webSockets: input.webSockets, notes: coverageNotes(input) },
    blocked: null,
    next: NEXT_BY_CLOSE[input.closedBy] ?? null,
  };
}
