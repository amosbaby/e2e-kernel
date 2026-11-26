import { ACTION_TIMEOUT_MS, DriverError } from '../driver/types.ts';
import type { Page, Stable } from '../driver/types.ts';
import type { Op, Target, WaitCond } from '../shared/ops.ts';
import type { OpResult, Outcome, Tallies } from '../shared/protocol.ts';
import { ensurePrivateDir, resolveInside } from '../shared/paths.ts';
import { REDACTED, redactBody, redactText, redactUrl } from '../shared/redact.ts';
import { compare } from './assert.ts';
import { safely } from './recorder.ts';
import type { ActionRecord, Recorder } from './recorder.ts';

// 执行一批操作（设计 5.6、5.8）：按顺序跑，动作执行失败就停，后面的标 not-run；assert 不符不停。
// 每条都进记录；记录里的操作先脱敏，读操作的输出不进记录。驱动抛 DriverError 以外的异常一律往上抛（内部错误）。

export interface ExecCtx { recorder: Recorder; runDir: string; now(): Date }

const PASSWORD_REFUSAL = 'password-field: 内核不输入密码，请由人登录后再继续';
const FILL_UNCHECKED = 'fill-unchecked: 判断不出目标是不是密码框，内核不填写';

const MAX_SNAPSHOT = 20_000;
const DEFAULT_TEXT = 4_000;
const MAX_TEXT = 20_000;
const MAX_EVAL = 4_000;
const MAX_CONSOLE_ENTRIES = 50;
const MAX_CONSOLE_TEXT = 300;
const MAX_NETWORK = 50;

type Output = NonNullable<OpResult['output']>;

// 一条操作跑完的结果。valueCleared：只有 describe 确认目标不是密码框、且 fill 成功的那条才为真；
// 其余的 fill（没跑、被拒、describe 或等待失败、超时）记录里的值一律换成 REDACTED。
interface Done {
  outcome: Outcome;
  stable?: Stable | null;
  output?: Output;
  actual?: string | number | boolean | null;
  expected?: string | number | boolean;
  error?: string;
  shot?: string;
  valueCleared?: boolean;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length}]` : s;
}

// 先脱敏再截断：反过来会把 token 切成认不出来的半截。
function redactCap(raw: string, max: number): string {
  return safely(() => truncate(redactText(raw), max));
}

function redactValue<T>(v: T): T | string {
  return typeof v === 'string' ? safely(() => redactText(v)) : v;
}

function driverErrorText(e: DriverError): string {
  return `${e.kind}: ${safely(() => redactText(e.message))}`;
}

function rethrowUnlessDriverError(e: unknown): asserts e is DriverError {
  if (!(e instanceof DriverError)) throw e;
}

// 只放值不是 undefined 的键：驱动收到的参数和操作里给的一致。
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function targetOf(op: Op): Target | undefined {
  return 'target' in op ? op.target : undefined;
}

// eval 的返回值：先成一个 JSON 字符串，按 JSON 脱敏（敏感键的值换掉），再整体过一遍文本脱敏（键名里的 token），最后截断。
function evalOutput(v: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
  const text = json ?? 'undefined';
  return safely(() => truncate(redactText(redactBody(text, 'application/json', Number.POSITIVE_INFINITY) ?? REDACTED), MAX_EVAL));
}

function shotName(seq: number): string {
  return `${String(seq).padStart(2, '0')}.jpg`;
}

async function takeShot(page: Page, seq: number, ctx: ExecCtx, fullPage: boolean): Promise<string> {
  ensurePrivateDir(resolveInside(ctx.runDir, 'shots'));
  const name = shotName(seq);
  await page.screenshot({ path: resolveInside(ctx.runDir, 'shots', name), fullPage });
  return `shots/${name}`;
}

// 失败时留一张截图；截不了（页面没了之类）就不留。
async function failureShot(page: Page, seq: number, ctx: ExecCtx): Promise<string | undefined> {
  try {
    return await takeShot(page, seq, ctx, false);
  } catch (e) {
    rethrowUnlessDriverError(e);
    return undefined;
  }
}

async function tryDescribe(page: Page, target: Target): Promise<{ ok: boolean; stable: Stable | null }> {
  try {
    return { ok: true, stable: (await page.describe(target)).stable };
  } catch (e) {
    rethrowUnlessDriverError(e);
    return { ok: false, stable: null };
  }
}

// fill 的错误文本里不留下要填的值（驱动的消息里万一带着它）。
function fillErrorText(e: DriverError, value: string): string {
  const text = driverErrorText(e);
  return value === '' ? text : text.split(value).join(REDACTED);
}

// fill：先等目标出现（describe 不等待），再 describe，确定不是密码框才填。
// 等不到、describe 失败、说不清是不是密码框、是密码框，都不调 page.fill()。
async function runFill(page: Page, op: Extract<Op, { op: 'fill' }>): Promise<Done> {
  try {
    await page.waitFor({ target: op.target, state: 'visible' }, ACTION_TIMEOUT_MS);
  } catch (e) {
    rethrowUnlessDriverError(e);
    return { outcome: 'failed', stable: null, error: fillErrorText(e, op.value) };
  }
  let described: { stable: Stable | null; isPassword: boolean };
  try {
    described = await page.describe(op.target);
  } catch (e) {
    rethrowUnlessDriverError(e);
    return { outcome: 'failed', stable: null, error: `${FILL_UNCHECKED}（${fillErrorText(e, op.value)}）` };
  }
  const { stable, isPassword } = described;
  if (isPassword === true) return { outcome: 'failed', stable, error: PASSWORD_REFUSAL };
  if (isPassword !== false) return { outcome: 'failed', stable, error: FILL_UNCHECKED };
  try {
    await page.fill(op.target, op.value);
  } catch (e) {
    rethrowUnlessDriverError(e);
    return { outcome: 'failed', stable, error: fillErrorText(e, op.value) };
  }
  return { outcome: 'ok', stable, valueCleared: true };
}

// assert：读不到元素（not-found）算不符、actual 为 null；别的 DriverError 往外抛，由调用方记成 failed。
async function runAssert(page: Page, op: Extract<Op, { op: 'assert' }>): Promise<Done> {
  let actual: string | number | boolean | null;
  try {
    actual = await page.read(defined({ kind: op.kind, target: op.target, property: op.property }));
  } catch (e) {
    if (!(e instanceof DriverError) || e.kind !== 'not-found') throw e;
    actual = null;
  }
  const c = compare(op.kind, op.cmp, actual, op.expected, op.property);
  return { outcome: c.match ? 'match' : 'mismatch', actual: redactValue(c.actual), expected: redactValue(c.expected) };
}

async function perform(page: Page, op: Exclude<Op, { op: 'fill' }>, seq: number, ctx: ExecCtx): Promise<Done> {
  switch (op.op) {
    case 'snapshot':
      return { outcome: 'ok', output: redactCap(await page.snapshot(defined({ depth: op.depth })), MAX_SNAPSHOT) };
    case 'text':
      return { outcome: 'ok', output: redactCap(await page.text(defined({ target: op.target })), Math.min(op.max ?? DEFAULT_TEXT, MAX_TEXT)) };
    case 'screenshot':
      return { outcome: 'ok', shot: await takeShot(page, seq, ctx, op.fullPage ?? false) };
    case 'console': {
      const all = await page.console();
      return { outcome: 'ok', output: all.slice(-MAX_CONSOLE_ENTRIES).map((m) => ({ level: m.level, text: redactCap(m.text, MAX_CONSOLE_TEXT) })) };
    }
    case 'network':
      return { outcome: 'ok', output: ctx.recorder.requests.slice(-MAX_NETWORK).map((r) => ({ ...r })) };
    case 'click':
      await page.click(op.target);
      return { outcome: 'ok' };
    case 'hover':
      await page.hover(op.target);
      return { outcome: 'ok' };
    case 'press':
      await (op.target === undefined ? page.press(op.key) : page.press(op.key, op.target));
      return { outcome: 'ok' };
    case 'scroll':
      await page.scroll(defined({ target: op.target, dx: op.dx, dy: op.dy }));
      return { outcome: 'ok' };
    case 'goto':
      await page.goto(op.url);
      return { outcome: 'ok' };
    case 'viewport':
      await page.setViewport({ width: op.width, height: op.height });
      return { outcome: 'ok' };
    case 'wait':
      await page.waitFor(op.for, op.timeoutMs ?? ACTION_TIMEOUT_MS);
      return { outcome: 'ok' };
    case 'assert':
      return runAssert(page, op);
    case 'eval':
      return { outcome: 'ok', output: evalOutput(await page.evaluate(op.js)) };
  }
}

// 带目标的操作（fill 除外）：动作前 describe；失败了就在动作没失败时再试一次；还不行记 null。动作本身照常执行。
async function runOne(page: Page, op: Op, seq: number, ctx: ExecCtx): Promise<Done> {
  if (op.op === 'fill') return runFill(page, op);
  const target = targetOf(op);
  const before = target === undefined ? { ok: true, stable: null } : await tryDescribe(page, target);
  let done: Done;
  try {
    done = await perform(page, op, seq, ctx);
  } catch (e) {
    rethrowUnlessDriverError(e);
    return { outcome: 'failed', stable: before.stable, error: driverErrorText(e) };
  }
  const stable = target !== undefined && !before.ok ? (await tryDescribe(page, target)).stable : before.stable;
  return { ...done, stable };
}

function redactWait(c: WaitCond): WaitCond {
  if ('text' in c) return { text: safely(() => redactText(c.text)) };
  if ('urlContains' in c) return { urlContains: safely(() => redactText(c.urlContains)) };
  return { ...c };
}

// 进记录的操作：调用方给的自由文本先脱敏；target 原样留着（重放要用）。
function recordedOp(op: Op, valueCleared: boolean): Op {
  switch (op.op) {
    case 'fill':
      return { ...op, value: valueCleared ? safely(() => redactText(op.value)) : REDACTED };
    case 'goto':
      return { ...op, url: safely(() => redactUrl(op.url)) };
    case 'eval':
      return { ...op, js: safely(() => redactText(op.js)) };
    case 'wait':
      return { ...op, for: redactWait(op.for) };
    case 'assert':
      return { ...op, expected: redactValue(op.expected) };
    default:
      return { ...op };
  }
}

export async function runOps(page: Page, ops: Op[], ctx: ExecCtx): Promise<OpResult[]> {
  const results: OpResult[] = [];
  let stopped = false;
  for (const [index, op] of ops.entries()) {
    const seq = ctx.recorder.nextSeq();
    const started = ctx.now();
    let done: Done;
    if (stopped) {
      done = { outcome: 'not-run' };
    } else {
      done = await runOne(page, op, seq, ctx);
      if (done.outcome === 'failed') {
        stopped = true;
        done.shot ??= await failureShot(page, seq, ctx);
      }
    }
    const ms = done.outcome === 'not-run' ? 0 : Math.max(0, ctx.now().getTime() - started.getTime());

    const record: ActionRecord = { seq, at: started.toISOString(), ms, op: recordedOp(op, done.valueCleared === true), outcome: done.outcome };
    const target = targetOf(op);
    if (target !== undefined) record.target = { given: target, stable: done.stable ?? null };
    const result: OpResult = { index, op: op.op, outcome: done.outcome };
    if (done.output !== undefined) result.output = done.output;
    for (const r of [record, result]) {
      if ('actual' in done) r.actual = done.actual;
      if (done.expected !== undefined) r.expected = done.expected;
      if (done.error !== undefined) r.error = done.error;
      if (done.shot !== undefined) r.shot = done.shot;
    }
    ctx.recorder.addAction(record);
    results.push(result);
  }
  return results;
}

export function tally(items: readonly { outcome: Outcome }[]): Tallies {
  const t: Tallies = { ok: 0, match: 0, mismatch: 0, failed: 0, notRun: 0 };
  for (const { outcome } of items) {
    if (outcome === 'not-run') t.notRun++;
    else t[outcome]++;
  }
  return t;
}

// 一批里既有不符又有执行失败时报 11。
export function exitFor(t: Tallies): 0 | 10 | 11 {
  if (t.failed > 0) return 11;
  if (t.mismatch > 0) return 10;
  return 0;
}
