import { createHash } from 'node:crypto';
import { ACTION_TIMEOUT_MS, DriverError } from '../driver/types.ts';
import type { Described, Page, PasswordProbe, Stable } from '../driver/types.ts';
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
const MAX_EVAL_RECORD = 1_000;
const MAX_CONSOLE_ENTRIES = 50;
const MAX_CONSOLE_TEXT = 300;
const MAX_NETWORK = 50;

type Output = NonNullable<OpResult['output']>;

// 一条操作跑完的结果。valueCleared：只有 describe 确认目标不是密码框、是普通输入框或多行文本框、且 fill 成功的那条才为真；
// 其余的 fill（没跑、被拒、describe 或等待失败、超时、目标是 contenteditable 等）记录里的值一律换成 REDACTED。
interface Done {
  outcome: Outcome;
  stable?: Stable | null;
  output?: Output;
  actual?: string | number | boolean | null;
  expected?: string | number | boolean;
  error?: string;
  shot?: string;
  valueCleared?: boolean;
  // 失败时驱动给的诊断，已脱敏、每条截到 300、最多 6 条。回应照给；记录里要先看页面有没有密码类字段（见 recordHints）。
  hints?: string[];
  // 只有 eval 带这三项，给记录用：脱敏后截到 1000 的返回值（页面有密码类字段或探测不出时没有，改为 outputOmitted）和源码哈希。
  recordOutput?: string;
  recordError?: string;     // 只给记录用的错误文字；有它时记录不用 error（eval 抛错的消息可能带着页面值和源码片段）
  outputOmitted?: boolean;
  jsHash?: string;
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

// idle 等待没给 timeoutMs 时，默认超时比安静窗口多这么久（至少 10 秒）：窗口放不下就永远等不到。
const IDLE_DEFAULT_SLACK_MS = 5000;
const MAX_HINTS = 6;
const MAX_HINT = 300;
const HINTS_NOT_RECORDED = '[诊断未记录：页面有密码框，或判断不出]';

// 驱动的诊断条目可能带页面文字：先把要填的值换掉（fill 才有），再脱敏、最后截到 300。空值不换（split('') 会把每个字符隔开）。
function redactHints(e: DriverError, value?: string): string[] | undefined {
  if (!Array.isArray(e.hints) || e.hints.length === 0) return undefined;
  return e.hints.slice(0, MAX_HINTS).map((h) => redactCap(value === undefined || value === '' ? String(h) : String(h).split(value).join(REDACTED), MAX_HINT));
}

function withHints(done: Done, hints: string[] | undefined): Done {
  return hints === undefined ? done : { ...done, hints };
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

// eval 的返回值：先成一个 JSON 字符串，按 JSON 脱敏（敏感键的值换掉），再整体过一遍文本脱敏（键名里的 token）。
// 这里不截断：回应和记录各自截到自己的上限，两处都是「整体脱敏之后再截」。
function evalRedacted(v: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
  const text = json ?? 'undefined';
  return safely(() => redactText(redactBody(text, 'application/json', Number.POSITIVE_INFINITY) ?? REDACTED));
}

// 源码只记哈希：'sha256:' + 十六进制前 16 位（不加盐，见 README 的 Threat model）。16 位够短，不会被 HEX 规则（32 位以上）吃掉。
function sourceHash(js: string): string {
  return `sha256:${createHash('sha256').update(js).digest('hex').slice(0, 16)}`;
}

// 页面（任何 frame）有没有密码类字段；探测抛 DriverError 当作探不出（found: null）。失败关闭：只有 found 为 false 才算确定没有。
async function passwordLike(page: Page): Promise<PasswordProbe> {
  try {
    return await page.hasPasswordLikeField();
  } catch (e) {
    rethrowUnlessDriverError(e);
    return { found: null, frames: [] };
  }
}

// eval 跑前跑后各探一次：脚本可以往页面里插一个密码框再读，也可以把它删掉再返回它的值；
// 两次拿到的 frame 地址不一致（eval 期间页面换了文档）也按探不出处理。
// eval 抛错：回应里照旧给 agent 看错误（脱敏过），记录里只留固定文字：错误消息可能带着页面值（throw new Error(value)）
// 或源码里的标识符（ReferenceError），既没探测也没截断，不能进记录。失败的那条也记 jsHash。
async function runEval(page: Page, op: Extract<Op, { op: 'eval' }>): Promise<Done> {
  const jsHash = sourceHash(op.js);
  const before = await passwordLike(page);
  let value: unknown;
  try {
    value = await page.evaluate(op.js);
  } catch (e) {
    rethrowUnlessDriverError(e);
    return { outcome: 'failed', error: driverErrorText(e), recordError: `${e.kind}: eval 抛错（消息未记录）`, jsHash };
  }
  const after = await passwordLike(page);
  const redacted = evalRedacted(value);
  const done: Done = { outcome: 'ok', output: truncate(redacted, MAX_EVAL), jsHash };
  const sameDocs = before.frames.length === after.frames.length && before.frames.every((u, i) => u === after.frames[i]);
  if (before.found === false && after.found === false && sameDocs) done.recordOutput = truncate(redacted, MAX_EVAL_RECORD);
  else done.outputOmitted = true;
  return done;
}

type ShotOp = Extract<Op, { op: 'screenshot' }>;

// 文件名：NN[-label].jpg|png。label 在校验时已限定成小写字母、数字和连字符，所以进路径是安全的。
function shotName(seq: number, op?: ShotOp): string {
  const label = op?.label === undefined ? '' : `-${op.label}`;
  return `${String(seq).padStart(2, '0')}${label}.${op?.format === 'png' ? 'png' : 'jpg'}`;
}

async function takeShot(page: Page, seq: number, ctx: ExecCtx, op?: ShotOp): Promise<string> {
  ensurePrivateDir(resolveInside(ctx.runDir, 'shots'));
  const name = shotName(seq, op);
  await page.screenshot({
    path: resolveInside(ctx.runDir, 'shots', name), fullPage: op?.fullPage ?? false, format: op?.format ?? 'jpeg',
    ...defined({ target: op?.target, mask: op?.mask }),
  });
  return `shots/${name}`;
}

// 失败时留一张截图；截不了（页面没了之类）就不留。
async function failureShot(page: Page, seq: number, ctx: ExecCtx): Promise<string | undefined> {
  try {
    return await takeShot(page, seq, ctx);
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
    return withHints({ outcome: 'failed', stable: null, error: fillErrorText(e, op.value) }, redactHints(e, op.value));
  }
  let described: Described;
  try {
    described = await page.describe(op.target);
  } catch (e) {
    rethrowUnlessDriverError(e);
    return withHints({ outcome: 'failed', stable: null, error: `${FILL_UNCHECKED}（${fillErrorText(e, op.value)}）` }, redactHints(e, op.value));
  }
  const { stable, isPassword, kind } = described;
  if (isPassword === true) return { outcome: 'failed', stable, error: PASSWORD_REFUSAL };
  if (isPassword !== false) return { outcome: 'failed', stable, error: FILL_UNCHECKED };
  try {
    await page.fill(op.target, op.value);
  } catch (e) {
    rethrowUnlessDriverError(e);
    return withHints({ outcome: 'failed', stable, error: fillErrorText(e, op.value) }, redactHints(e, op.value));
  }
  // 值只在确认是普通输入框或多行文本框时才留进记录；contenteditable 等认不出的目标照填，但记成 [REDACTED]。
  return { outcome: 'ok', stable, valueCleared: kind === 'text-input' || kind === 'textarea' };
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
      return { outcome: 'ok', shot: await takeShot(page, seq, ctx, op) };
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
      await page.waitFor(op.for, op.timeoutMs ?? ('idle' in op.for ? Math.max(ACTION_TIMEOUT_MS, op.for.idle + IDLE_DEFAULT_SLACK_MS) : ACTION_TIMEOUT_MS));
      return { outcome: 'ok' };
    case 'assert':
      return runAssert(page, op);
    case 'eval':
      return runEval(page, op);
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
    return withHints({ outcome: 'failed', stable: before.stable, error: driverErrorText(e) }, redactHints(e));
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
      return { ...op, js: REDACTED };   // eval 的源码可能带着明文值，不进记录；记录里的 eval 不能重放
    case 'wait':
      return { ...op, for: redactWait(op.for) };
    case 'assert':
      return { ...op, expected: redactValue(op.expected) };
    default:
      return { ...op };
  }
}

// 记录里的诊断：页面确定没有密码类字段才留（失败关闭：有、或探不出都只留一句固定的话）。回应给 agent 的不受这个限制。
async function recordHints(page: Page, hints: string[]): Promise<string[]> {
  return (await passwordLike(page)).found === false ? hints : [HINTS_NOT_RECORDED];
}

// keepGoing：失败不拦住后面的操作（默认失败后停，其余记未执行）。
// aborted：每个操作开始前问一次，页面或浏览器已经没了就停下，其余记未执行（不然 keepGoing 下会对着关掉的页面逐个记成执行失败）。
export async function runOps(page: Page, ops: Op[], ctx: ExecCtx, opts?: { keepGoing?: boolean; aborted?: () => boolean }): Promise<OpResult[]> {
  const keepGoing = opts?.keepGoing === true;
  const results: OpResult[] = [];
  let stopped = false;
  for (const [index, op] of ops.entries()) {
    if (!stopped && opts?.aborted?.() === true) stopped = true;
    const seq = ctx.recorder.nextSeq();
    const started = ctx.now();
    let done: Done;
    if (stopped) {
      done = { outcome: 'not-run' };
    } else {
      done = await runOne(page, op, seq, ctx);
      if (done.outcome === 'failed') {
        if (!keepGoing) stopped = true;
        // 带 mask 的截图失败时不留失败截图：那张是整页、没有遮罩，正好违背 mask 的用意。
        if (!(op.op === 'screenshot' && op.mask !== undefined)) done.shot ??= await failureShot(page, seq, ctx);
      }
    }
    const ms = done.outcome === 'not-run' ? 0 : Math.max(0, ctx.now().getTime() - started.getTime());

    const record: ActionRecord = { seq, at: started.toISOString(), ms, op: recordedOp(op, done.valueCleared === true), outcome: done.outcome };
    const target = targetOf(op);
    if (target !== undefined) record.target = { given: target, stable: done.stable ?? null };
    const result: OpResult = { index, op: op.op, outcome: done.outcome, seq };
    if (done.output !== undefined) result.output = done.output;
    if (done.hints !== undefined) result.hints = done.hints;
    if (done.hints !== undefined) record.hints = await recordHints(page, done.hints);
    if (done.jsHash !== undefined) record.jsHash = done.jsHash;
    if (done.recordOutput !== undefined) record.output = done.recordOutput;
    if (done.outputOmitted === true) record.outputOmitted = true;
    for (const r of [record, result]) {
      if ('actual' in done) r.actual = done.actual;
      if (done.expected !== undefined) r.expected = done.expected;
      if (done.error !== undefined) r.error = done.error;
      if (done.shot !== undefined) r.shot = done.shot;
    }
    if (done.recordError !== undefined) record.error = done.recordError;
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
