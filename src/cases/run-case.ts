import { E2kError } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import type { Op } from '../shared/ops.ts';
import { MAX_ALLOW, SESSION_ID, exitCodeFor } from '../shared/protocol.ts';
import type { AllowItem, CloseParams, Finding, Method, StepParams, Tallies, VerdictValue } from '../shared/protocol.ts';
import { isObject } from '../shared/validate.ts';
import type { CaseFile, CaseStep } from './case.ts';

// run 在客户端重放用例（设计 5.8、R13）：用现成的 open / step / close 协议，不加内核方法。
// 流程：open → 一批批 step（每批最多 50 步，在带放行声明的步骤处切开）→ close。
// 结论由这里判（有失败或未执行、有不符 → fail；有不能重放的步骤 → undetermined；都相符 → pass）；
// 原会话里 agent 的 findings 只带 claim，不重判。close 的 because、notDone 只写数量和序号，不写页面上的文字。

export const BATCH_SIZE = 50;
export const RETRY_MS = 2000;
export const WAIT_MS = 120_000;
export const FINDING_BASIS = '原会话里 agent 的判定，重跑不判定';
const MAX_NOT_DONE = 20;
const REQUEST_ID = /请求 (a-[0-9a-f]{6})/;

export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export interface RunOptions { name?: string; clock: Clock; onWaiting?: (id: string | null) => void }
export interface RunError { code: ErrorCode; message: string; next?: string }
export interface RunOutcome {
  exit: number;
  session: string | null;          // 没开成会话（open 就出错、或开会话之前就被拒）为 null
  reportPath: string | null;
  verdict: VerdictValue | null;    // 没开成会话、或 close 没成功时为 null
  skipped: number;                 // 不能重放、没有发给内核的步骤数
  tallies: Tallies | null;         // 各批 step 的合计，加上因停下而没发出去的步骤（算未执行）
  error: RunError | null;          // 中途出的错（退出码就是它的）；没出错为 null
  because: string | null;          // 写进 close 的结论理由（不是 pass 时才有）；没开成会话为 null
}

interface Batch { ops: Op[]; allow: AllowItem[] }

function usage(message: string): E2kError {
  return new E2kError('usage', message);
}

function malformed(): E2kError {
  return new E2kError('internal', '内核的回应格式不对');
}

function toRunError(e: E2kError): RunError {
  return e.next === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, next: e.next };
}

const allowKey = (a: AllowItem): string => JSON.stringify([a.method, a.url, a.operation ?? null]);

function dedupe(items: AllowItem[]): AllowItem[] {
  const seen = new Set<string>();
  return items.filter((a) => {
    const k = allowKey(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 把可重放的步骤切成批：每批最多 BATCH_SIZE 步；带放行声明的步骤起新的一批，那一批带着这些声明。
// 声明的序号对不上可重放的步骤时（那一步被跳过了）挂到序号不小于它的第一个可重放步骤上；后面没有了就挂到最后一批（T8-b）。
// 一批的声明最多 MAX_ALLOW 条：并到一起超了（先去重）就拒绝，不在开会话之后才发现。
export function planBatches(c: CaseFile): Batch[] {
  const runnable = c.steps.filter((s): s is CaseStep & { op: Op } => s.op !== undefined);
  const attach: AllowItem[][] = runnable.map(() => []);
  const tail: AllowItem[] = [];
  for (const a of c.allow) {
    const item: AllowItem = { method: a.method, url: a.url, ...(a.operation === undefined ? {} : { operation: a.operation }) };
    const i = runnable.findIndex((s) => s.seq >= a.seq);
    (i < 0 ? tail : attach[i]!).push(item);
  }
  const batches: Batch[] = [];
  runnable.forEach((s, i) => {
    const cur = batches.at(-1);
    const starts = attach[i]!.length > 0;
    if (cur === undefined || starts || cur.ops.length >= BATCH_SIZE) batches.push({ ops: [s.op], allow: dedupe(attach[i]!) });
    else cur.ops.push(s.op);
  });
  const last = batches.at(-1);
  if (last !== undefined && tail.length > 0) last.allow = dedupe([...last.allow, ...tail]);
  if (batches.some((b) => b.allow.length > MAX_ALLOW)) {
    throw usage(`用例里同一批要放行的声明超过 ${MAX_ALLOW} 条，不能重放；请用 save-case --steps 重新导出`);
  }
  return batches;
}

// 发一个请求；收到 21（等人在弹框里批准）就每 2 秒原样重试。每换一个请求 id（从 id 到没有 id、或 id 之间）重新计 120 秒，
// 同一个 id 等满 120 秒就把那个 21 往上抛。消息里没有 id 的当作它自己的一个 id（null）。其他错误原样往上抛。
async function sendRetrying(send: (m: Method, p: unknown) => Promise<unknown>, method: Method, params: unknown, o: RunOptions): Promise<unknown> {
  let current: string | null | undefined;
  let deadline = 0;
  for (;;) {
    try {
      return await send(method, params);
    } catch (e) {
      if (!(e instanceof E2kError) || e.code !== 'wait-approval') throw e;
      const id = REQUEST_ID.exec(e.message)?.[1] ?? null;
      if (current === undefined || id !== current) {
        current = id;
        deadline = o.clock.now() + WAIT_MS;
        o.onWaiting?.(id);
      }
      if (o.clock.now() >= deadline) throw e;
      await o.clock.sleep(RETRY_MS);
    }
  }
}

function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw malformed();
  return v;
}

function readTallies(v: unknown): Tallies {
  if (!isObject(v)) throw malformed();
  return { ok: count(v.ok), match: count(v.match), mismatch: count(v.mismatch), failed: count(v.failed), notRun: count(v.notRun) };
}

function addTallies(a: Tallies, b: Tallies): Tallies {
  return { ok: a.ok + b.ok, match: a.match + b.match, mismatch: a.mismatch + b.mismatch, failed: a.failed + b.failed, notRun: a.notRun + b.notRun };
}

function readOpen(v: unknown): { session: string; blocked: boolean; identityMismatch: boolean } {
  if (!isObject(v) || typeof v.session !== 'string' || !SESSION_ID.test(v.session)) throw malformed();
  return { session: v.session, blocked: v.blocked === 'login', identityMismatch: v.identity === 'mismatch' };
}

function readStep(v: unknown): { exit: 0 | 10 | 11 | 20; tallies: Tallies } {
  if (!isObject(v) || (v.exit !== 0 && v.exit !== 10 && v.exit !== 11 && v.exit !== 20)) throw malformed();
  return { exit: v.exit, tallies: readTallies(v.tallies) };
}

function readClose(v: unknown): { reportPath: string; exit: number } {
  if (!isObject(v) || typeof v.reportPath !== 'string' || (v.exit !== 0 && v.exit !== 10)) throw malformed();
  return { reportPath: v.reportPath, exit: v.exit };
}

function skipLines(steps: CaseStep[]): string[] {
  const lines = steps.filter((s) => s.skip !== undefined).map((s) => `步骤 ${s.seq}（${s.skip!.op}）不能重放：${s.skip!.why}`);
  if (lines.length <= MAX_NOT_DONE) return lines;
  return [...lines.slice(0, MAX_NOT_DONE - 1), `另有 ${lines.length - (MAX_NOT_DONE - 1)} 步不能重放`];
}

type Stop = { kind: 'identity' } | { kind: 'login'; batch: number } | { kind: 'error'; batch: number; error: E2kError } | null;

// open 回来身份探针不符：和 CLI open 同口径（22），一步都不发。
const IDENTITY_MISMATCH: RunError = {
  code: 'needs-human',
  message: '身份探针不符：打开时页面上的账号或租户不是组配置里期望的那个，没有执行任何步骤',
  next: '账号或租户可能被别的会话切走了；请人确认后重跑',
};

export async function runCase(send: (method: Method, params: unknown) => Promise<unknown>, c: CaseFile, o: RunOptions): Promise<RunOutcome> {
  let batches: Batch[];
  try {
    batches = planBatches(c);
  } catch (e) {
    if (e instanceof E2kError) return { exit: exitCodeFor(e.code), session: null, reportPath: null, verdict: null, skipped: 0, tallies: null, error: toRunError(e), because: null };
    throw e;
  }
  const skipped = c.steps.filter((s) => s.skip !== undefined).length;
  const runnable = c.steps.length - skipped;

  const openParams: Record<string, unknown> = { url: c.open.url, name: o.name ?? c.name, profile: c.open.profile };
  if (c.open.viewport !== null) openParams.viewport = c.open.viewport;
  if (c.open.touch) openParams.touch = true;
  if (c.open.readonly) openParams.readonly = true;
  if (c.open.allow.length > 0) openParams.allow = c.open.allow;

  let opened: { session: string; blocked: boolean; identityMismatch: boolean };
  try {
    opened = readOpen(await sendRetrying(send, 'open', openParams, o));
  } catch (e) {
    if (e instanceof E2kError) return { exit: exitCodeFor(e.code), session: null, reportPath: null, verdict: null, skipped, tallies: null, error: toRunError(e), because: null };
    throw e;
  }
  const session = opened.session;

  let tallies: Tallies = { ok: 0, match: 0, mismatch: 0, failed: 0, notRun: 0 };
  let sent = 0;
  // 身份不符先于登录墙（22 优先于 20，同 CLI open）。
  let stop: Stop = opened.identityMismatch ? { kind: 'identity' } : opened.blocked ? { kind: 'login', batch: 0 } : null;
  let thrown: unknown;
  let closed: { reportPath: string; exit: number } | null = null;
  let closeError: E2kError | null = null;
  let verdict: VerdictValue = 'undetermined';

  try {
    for (const [i, b] of batches.entries()) {
      if (stop !== null) break;
      const params: StepParams = { session, ops: b.ops, ...(b.allow.length > 0 ? { allow: b.allow } : {}) };
      let r: { exit: 0 | 10 | 11 | 20; tallies: Tallies };
      try {
        r = readStep(await sendRetrying(send, 'step', params, o));
      } catch (e) {
        if (!(e instanceof E2kError)) throw e;
        stop = e.code === 'wait-login' ? { kind: 'login', batch: i + 1 } : { kind: 'error', batch: i + 1, error: e };
        break;
      }
      tallies = addTallies(tallies, r.tallies);
      sent += b.ops.length;
      if (r.exit === 20) stop = { kind: 'login', batch: i + 1 };
      else if (r.exit === 11) break;   // 失败了：后面的批不发
    }
  } catch (e) {
    thrown = e;   // 不是 E2kError 的异常：先收尾再往上抛
  }
  const unsent = runnable - sent;
  tallies = { ...tallies, notRun: tallies.notRun + unsent };

  let because: string | undefined;
  if (stop?.kind === 'identity') {
    because = '身份探针不符';
  } else if (stop?.kind === 'error') {
    because = `重放在第 ${stop.batch} 批出错（${stop.error.code}），之后的 ${unsent} 步没有执行`;
  } else if (stop?.kind === 'login') {
    because = stop.batch === 0 ? '撞到登录墙：打开时就是登录页，一步都没有执行' : `撞到登录墙：第 ${stop.batch} 批 step 返回登录墙，之后的 ${unsent} 步没有执行`;
  } else if (thrown !== undefined) {
    because = '重放中途出现内部错误，之后的步骤没有执行';
  } else if (tallies.failed > 0 || tallies.notRun > 0 || tallies.mismatch > 0) {
    verdict = 'fail';
    const parts = [[tallies.failed, '步执行失败'], [tallies.notRun, '步未执行'], [tallies.mismatch, '处不符']] as const;
    because = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`).join('、');
  } else if (skipped > 0) {
    because = `有 ${skipped} 步不能重放，已跳过，逐条见 notDone`;
  } else {
    verdict = 'pass';
  }

  const findings: Finding[] = c.findings.map((f) => ({ claim: f.claim, basis: FINDING_BASIS, verdict: 'undetermined' }));
  const notDone = skipLines(c.steps);
  const close: CloseParams = {
    session,
    verdict: because === undefined ? { value: verdict } : { value: verdict, because },
    ...(findings.length > 0 ? { findings } : {}),
    ...(notDone.length > 0 ? { notDone } : {}),
  };
  try {
    closed = readClose(await sendRetrying(send, 'close', close, o));
  } catch (e) {
    if (!(e instanceof E2kError)) throw e;
    closeError = e;
  }
  if (thrown !== undefined) throw thrown;

  // 退出码：撞到登录墙 20 > 失败 11 > 不符 10 > 0；中途出错（不是 21 以外也一样）以那个错误的码为准；close 本身出错时以它的码为准。
  let error: RunError | null = null;
  let exit: number;
  if (stop?.kind === 'identity') {
    error = IDENTITY_MISMATCH;
    exit = exitCodeFor(IDENTITY_MISMATCH.code);
  } else if (stop?.kind === 'error') {
    error = toRunError(stop.error);
    exit = exitCodeFor(stop.error.code);
  } else if (stop?.kind === 'login') {
    exit = 20;
  } else if (tallies.failed > 0 || tallies.notRun > 0) {
    exit = 11;
  } else if (tallies.mismatch > 0) {
    exit = 10;
  } else {
    exit = 0;
  }
  if (closeError !== null && error === null) {
    error = toRunError(closeError);
    exit = exitCodeFor(closeError.code);
  }
  // 结论是 pass 时内核发现记录自相矛盾（不该发生）：不能当通过。
  if (exit === 0 && closed !== null && closed.exit === 10) exit = 10;
  return { exit, session, reportPath: closed?.reportPath ?? null, verdict: closed === null ? null : verdict, skipped, tallies, error, because: because ?? null };
}
