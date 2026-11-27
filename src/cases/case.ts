import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { E2kError } from '../shared/errors.ts';
import { isRef, validateOps } from '../shared/ops.ts';
import type { Op, Viewport } from '../shared/ops.ts';
import { MAX_ALLOW, SESSION_ID, SESSION_NAME, allowItem } from '../shared/protocol.ts';
import type { AllowItem } from '../shared/protocol.ts';
import { REDACTED } from '../shared/redact.ts';
import { httpUrl, int, isObject, str } from '../shared/validate.ts';

// 用例文件（设计 5.8，R11、R12）：从一场已 close 的会话的 result.json 导出，之后由 run 重放。
// result.json 是已脱敏的：脱敏过的部分写成 [REDACTED]，重放不了的步骤写成 skip，不丢。
// 用例文件可能被手改，所以 parseCase 严格：多余的键、类型不对、超大都拒绝，报错只说哪个字段，不回显原值。

export interface CaseStep { seq: number; op?: Op; skip?: { op: string; why: string } }
export interface CaseFile {
  e2kCase: 1; name: string; source: { session: string; kernelVersion: string };
  open: { url: string; profile: string; viewport: Viewport | null; touch: boolean; readonly: boolean; allow: AllowItem[] };
  steps: CaseStep[]; allow: (AllowItem & { seq: number })[]; findings: { claim: string }[]; containsWrites: boolean;
}

export const MAX_CASE_BYTES = 1_000_000;
const MAX_STEPS = 500;
const MAX_PICKED_STEPS = 200;
const MAX_CASE_ALLOW = 500;
const MAX_FINDINGS = 20;
const SEQ_RANGE = { min: 1, max: Number.MAX_SAFE_INTEGER };
const PROFILE_KEY = /^[a-z0-9_-]{1,32}(\/[a-z0-9_-]{1,32})?$/;
const RECORD_PROFILE_KEY = /^[a-z0-9_-]{1,32}(@[a-z0-9_-]{1,32})?$/;
const SKIP_OP = /^[a-z]{1,20}$/;
const OUTCOMES: readonly string[] = ['ok', 'match', 'mismatch', 'failed', 'not-run'];
// 默认挑选（R11）：这些操作成功了就留；assert 只要执行了（相符或不符）就留；读类操作、eval 不留。
const DEFAULT_KEPT_OPS: ReadonlySet<string> = new Set(['click', 'hover', 'fill', 'press', 'scroll', 'goto', 'viewport', 'wait']);

// ---- 错误：不回显原值，只说字段 ----

function refuse(message: string): E2kError {
  return new E2kError('usage', `这份记录不能导出：${message}`);
}

function bad(path: string): E2kError {
  return new E2kError('usage', `用例文件不对：${path}`);
}

// 校验函数抛的 E2kError 消息里可能带着外部的键名：换成只有字段名的固定说明。
function guard<T>(fail: (path: string) => E2kError, path: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof E2kError) throw fail(path);
    throw e;
  }
}

function hasRedacted(v: unknown): boolean {
  return JSON.stringify(v).includes(REDACTED);
}

// 对象恰好是 required 里的键加上 optional 里出现的键，没有别的（含 __proto__ 一类自带的键）。
function exact(v: unknown, path: string, fail: (path: string) => E2kError, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isObject(v)) throw fail(path);
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw fail(path);
  for (const k of Object.keys(v)) {
    if (!required.includes(k) && !optional.includes(k)) throw fail(`${path} 有多余的键`);
  }
  for (const k of required) {
    if (!Object.hasOwn(v, k)) throw fail(`${path}.${k}`);
  }
  return v;
}

// op 里任一目标（target、wait 的 for.target、截图遮罩 mask）是快照引用的形状。
function hasRefTarget(op: Op): boolean {
  const o = op as unknown as Record<string, unknown>;
  const ref = (t: unknown): boolean => typeof t === 'string' && isRef(t);
  const waitFor = o.for;
  return ref(o.target) || (isObject(waitFor) && ref(waitFor.target)) || (Array.isArray(o.mask) && o.mask.some(ref));
}

// ---- parseCase ----

function parseViewport(v: unknown, path: string): Viewport | null {
  if (v === null) return null;
  const o = exact(v, path, bad, ['width', 'height']);
  return guard(bad, path, () => ({ width: int(o.width, 'w', { min: 320, max: 3840 }), height: int(o.height, 'h', { min: 240, max: 2160 }) }));
}

function parseFlag(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw bad(path);
  return v;
}

function parseAllowItem(v: unknown, path: string, withSeq: boolean): AllowItem & { seq?: number } {
  const o = exact(v, path, bad, withSeq ? ['method', 'url', 'seq'] : ['method', 'url'], ['operation']);
  const item = guard(bad, path, () => allowItem({ method: o.method, url: o.url, ...(o.operation === undefined ? {} : { operation: o.operation }) }, 'allow'));
  if (!withSeq) return item;
  return { ...item, seq: guard(bad, `${path}.seq`, () => int(o.seq, 'seq', SEQ_RANGE)) };
}

function parseAllowList(v: unknown, path: string, max: number, withSeq: boolean): (AllowItem & { seq?: number })[] {
  if (!Array.isArray(v) || v.length > max) throw bad(path);
  return v.map((x: unknown, i) => parseAllowItem(x, `${path}[${i}]`, withSeq));
}

function parseStep(v: unknown, path: string): CaseStep {
  const o = exact(v, path, bad, ['seq'], ['op', 'skip']);
  const seq = guard(bad, `${path}.seq`, () => int(o.seq, 'seq', SEQ_RANGE));
  const hasOp = Object.hasOwn(o, 'op');
  const hasSkip = Object.hasOwn(o, 'skip');
  if (hasOp === hasSkip) throw bad(`${path} 要有 op 或 skip，且只有其一`);
  if (hasSkip) {
    const s = exact(o.skip, `${path}.skip`, bad, ['op', 'why']);
    return {
      seq,
      skip: {
        op: guard(bad, `${path}.skip.op`, () => str(s.op, 'op', { min: 1, max: 20, pattern: SKIP_OP })),
        why: guard(bad, `${path}.skip.why`, () => str(s.why, 'why', { min: 1, max: 200 })),
      },
    };
  }
  const op = guard(bad, `${path}.op`, () => validateOps([o.op])[0]!);
  // 导出的用例里 eval 一律是 skip：手改塞进一个可执行的 eval 不放行。
  if (op.op === 'eval') throw bad(`${path}.op`);
  // 纵深防御：导出的可执行步骤里没有脱敏标记，也没有快照引用（重放时没有快照，引用无意义）。
  if (hasRedacted(op) || hasRefTarget(op)) throw bad(`${path}.op`);
  return { seq, op };
}

export function parseCase(text: string): CaseFile {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CASE_BYTES) throw bad(`文件超过 ${MAX_CASE_BYTES} 字节`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw bad('不是 JSON');
  }
  const o = exact(json, '用例', bad, ['e2kCase', 'name', 'source', 'open', 'steps', 'allow', 'findings', 'containsWrites']);
  if (o.e2kCase !== 1) throw bad('e2kCase');
  const name = guard(bad, 'name', () => str(o.name, 'name', { min: 1, max: 40, pattern: SESSION_NAME }));
  const src = exact(o.source, 'source', bad, ['session', 'kernelVersion']);
  const source = {
    session: guard(bad, 'source.session', () => str(src.session, 'session', { min: 1, max: 8, pattern: SESSION_ID })),
    kernelVersion: guard(bad, 'source.kernelVersion', () => str(src.kernelVersion, 'kernelVersion', { min: 1, max: 64 })),
  };
  const op = exact(o.open, 'open', bad, ['url', 'profile', 'viewport', 'touch', 'readonly', 'allow']);
  const open = {
    url: guard(bad, 'open.url', () => httpUrl(op.url, 'url')),
    profile: guard(bad, 'open.profile', () => str(op.profile, 'profile', { min: 1, max: 65, pattern: PROFILE_KEY })),
    viewport: parseViewport(op.viewport, 'open.viewport'),
    touch: parseFlag(op.touch, 'open.touch'),
    readonly: parseFlag(op.readonly, 'open.readonly'),
    allow: parseAllowList(op.allow, 'open.allow', MAX_ALLOW, false) as AllowItem[],
  };
  if (!Array.isArray(o.steps) || o.steps.length < 1 || o.steps.length > MAX_STEPS) throw bad('steps');
  const steps = o.steps.map((s: unknown, i) => parseStep(s, `steps[${i}]`));
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]!.seq <= steps[i - 1]!.seq) throw bad(`steps[${i}].seq`);
  }
  const allow = parseAllowList(o.allow, 'allow', MAX_CASE_ALLOW, true) as (AllowItem & { seq: number })[];
  // run 把同一个序号的声明挂在同一批上，一批最多 MAX_ALLOW 条。
  const perSeq = new Map<number, number>();
  for (const a of allow) perSeq.set(a.seq, (perSeq.get(a.seq) ?? 0) + 1);
  if ([...perSeq.values()].some((n) => n > MAX_ALLOW)) throw bad('allow');
  if (!Array.isArray(o.findings) || o.findings.length > MAX_FINDINGS) throw bad('findings');
  const findings = o.findings.map((f: unknown, i) => {
    const fo = exact(f, `findings[${i}]`, bad, ['claim']);
    return { claim: guard(bad, `findings[${i}].claim`, () => str(fo.claim, 'claim', { min: 1, max: 500 })) };
  });
  return { e2kCase: 1, name, source, open, steps, allow, findings, containsWrites: parseFlag(o.containsWrites, 'containsWrites') };
}

// 读用例文件：符号链接、不是普通文件、超大都当 usage 拒绝（报错里不带路径）。
export function readCaseFile(path: string): CaseFile {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EISDIR' || code === 'EPERM') throw bad('文件打不开（不存在、是符号链接或没有权限）');
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw bad('不是普通文件');
    if (st.size > MAX_CASE_BYTES) throw bad(`文件超过 ${MAX_CASE_BYTES} 字节`);
    return parseCase(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

// ---- buildCase：把 result.json 当不信任的输入 ----

interface RecordedAction { seq: number; op: Record<string, unknown>; target: { given: string; stable: { selector: string } | null } | null; outcome: string }

function readActions(v: unknown): RecordedAction[] {
  if (!Array.isArray(v)) throw refuse('actions 的形状不对');
  let last = 0;
  return v.map((a: unknown) => {
    if (!isObject(a)) throw refuse('actions 的形状不对');
    const op = a.op;
    if (typeof a.seq !== 'number' || !Number.isSafeInteger(a.seq) || a.seq <= last) throw refuse('actions 的序号不对');
    last = a.seq;
    if (!isObject(op) || typeof op.op !== 'string') throw refuse('actions 的形状不对');
    if (typeof a.outcome !== 'string' || !OUTCOMES.includes(a.outcome)) throw refuse('actions 的形状不对');
    let target: RecordedAction['target'] = null;
    if (a.target !== undefined) {
      const t = a.target;
      if (!isObject(t) || typeof t.given !== 'string') throw refuse('actions 的形状不对');
      let stable: { selector: string } | null = null;
      if (t.stable !== null) {
        if (!isObject(t.stable) || typeof t.stable.selector !== 'string') throw refuse('actions 的形状不对');
        stable = { selector: t.stable.selector };
      }
      target = { given: t.given, stable };
    }
    return { seq: a.seq, op, target, outcome: a.outcome };
  });
}

function readViewport(v: unknown): Viewport | null {
  if (v === null) return null;
  if (!isObject(v)) throw refuse('start.viewport 的形状不对');
  return guard(refuse, 'start.viewport 的形状不对', () => ({ width: int(v.width, 'w', { min: 320, max: 3840 }), height: int(v.height, 'h', { min: 240, max: 2160 }) }));
}

function readAllowEntry(v: unknown, where: string): { method: string; url: string; operation: string | null } {
  if (!isObject(v) || typeof v.method !== 'string' || typeof v.url !== 'string' || (v.operation !== null && v.operation !== undefined && typeof v.operation !== 'string')) {
    throw refuse(`${where} 的形状不对`);
  }
  const operation = typeof v.operation === 'string' ? v.operation : null;
  if (hasRedacted(v.url) || (operation !== null && hasRedacted(operation))) throw refuse(`${where} 的地址已被脱敏`);
  return { method: v.method, url: v.url, operation };
}

function toAllowItem(e: { method: string; url: string; operation: string | null }, where: string): AllowItem {
  return guard(refuse, `${where} 的形状不对`, () => allowItem({ method: e.method, url: e.url, ...(e.operation === null ? {} : { operation: e.operation }) }, 'allow'));
}

function pickedSteps(v: unknown): number[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_PICKED_STEPS) throw new E2kError('usage', `--steps 要是 1-${MAX_PICKED_STEPS} 个整数的数组`);
  let last = 0;
  for (const n of v as unknown[]) {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n <= last) throw new E2kError('usage', '--steps 要是从小到大、不重复的正整数');
    last = n;
  }
  return v as number[];
}

function skipOp(a: RecordedAction): string {
  return SKIP_OP.test(String(a.op.op)) ? String(a.op.op) : 'unknown';
}

function skipFor(a: RecordedAction, why: string): CaseStep {
  return { seq: a.seq, skip: { op: skipOp(a), why } };
}

// 一个选中的动作变成用例里的一步：能重放就是 op，不能就是 skip（R11）。
function stepFor(a: RecordedAction): CaseStep {
  if (a.op.op === 'eval') return skipFor(a, 'eval 不能重放');
  let op: Record<string, unknown> = a.op;
  // 目标是快照引用：换成记录里的稳定选择器；没有就不能重放。等待目标、截图遮罩里的引用记录里没有选择器可换。
  if (typeof op.target === 'string' && isRef(op.target)) {
    const stable = a.target !== null && a.target.given === op.target ? a.target.stable : null;
    if (stable === null) return skipFor(a, '目标是快照引用，没有稳定的选择器');
    op = { ...op, target: stable.selector };
  }
  const waitFor = op.for;
  const refInWait = isObject(waitFor) && typeof waitFor.target === 'string' && isRef(waitFor.target);
  const refInMask = Array.isArray(op.mask) && op.mask.some((t: unknown) => typeof t === 'string' && isRef(t));
  if (refInWait || refInMask) return skipFor(a, '目标是快照引用，没有稳定的选择器');
  // 操作里任一字符串（填的值、等的文字、地址、目标、选择器）含脱敏标记，就不是原来的操作了。
  if (hasRedacted(op)) return skipFor(a, '内容已被脱敏，不能重放');
  try {
    return { seq: a.seq, op: validateOps([op])[0]! };
  } catch (e) {
    if (e instanceof E2kError) return skipFor(a, '操作不合法，不能重放');
    throw e;
  }
}

function isDefaultPick(a: RecordedAction): boolean {
  const op = String(a.op.op);
  return (DEFAULT_KEPT_OPS.has(op) && a.outcome === 'ok') || (op === 'assert' && (a.outcome === 'match' || a.outcome === 'mismatch'));
}

export function buildCase(run: unknown, o: { steps?: number[]; name?: string }): CaseFile {
  const picked = pickedSteps(o.steps);
  if (!isObject(run)) throw refuse('记录的形状不对');
  const session = guard(refuse, 'session 的格式不对', () => str(run.session, 'session', { min: 1, max: 8, pattern: SESSION_ID }));
  const kernelVersion = guard(refuse, 'kernelVersion 的形状不对', () => str(run.kernelVersion, 'kernelVersion', { min: 1, max: 64 }));
  const name = o.name ?? run.name;
  if (o.name !== undefined) {
    guard((p) => new E2kError('usage', `用例名字不对：${p}`), '要 1-40 个小写字母、数字或连字符，首字符不能是连字符', () => str(o.name, 'name', { min: 1, max: 40, pattern: SESSION_NAME }));
  } else {
    guard(refuse, '会话名不能当用例名（名字被脱敏或格式不对）', () => str(name, 'name', { min: 1, max: 40, pattern: SESSION_NAME }));
  }

  const st = run.start;
  if (!isObject(st)) throw refuse('start 的形状不对');
  if (typeof st.url !== 'string') throw refuse('start.url 的形状不对');
  if (hasRedacted(st.url)) throw refuse('起始地址已被脱敏');
  const url = guard(refuse, 'start.url 的形状不对', () => httpUrl(st.url, 'url'));
  if (typeof st.touch !== 'boolean' || typeof st.readonly !== 'boolean') throw refuse('start 的形状不对');
  if (typeof st.profile !== 'string' || !RECORD_PROFILE_KEY.test(st.profile)) throw refuse('start.profile 的形状不对');
  const viewport = readViewport(st.viewport);
  let openAllow: AllowItem[] = [];
  if (st.deny !== null && st.deny !== undefined) {
    const d = st.deny;
    if (!isObject(d) || !Array.isArray(d.allow)) throw refuse('start.deny 的形状不对');
    openAllow = d.allow.map((x: unknown) => toAllowItem(readAllowEntry(x, 'start.deny.allow'), 'start.deny.allow'));
  }

  const actions = readActions(run.actions);

  const w = run.writes;
  if (!isObject(w) || !Array.isArray(w.allowed)) throw refuse('writes 的形状不对');
  if (!Array.isArray(run.declarations)) throw refuse('declarations 的形状不对');
  const declared = run.declarations as unknown[];
  // 老版本内核写的记录里声明没有序号：用例没法把声明挂回那一批，不导出。
  if (declared.some((d) => !isObject(d) || typeof d.seq !== 'number' || !Number.isSafeInteger(d.seq) || d.seq < 1)) {
    throw refuse('这份记录没有放行声明的序号（旧版内核写的），不能导出');
  }
  const allow = declared.map((d) => {
    const e = readAllowEntry(d, 'declarations');
    const item = toAllowItem(e, 'declarations');
    return { ...item, seq: (d as { seq: number }).seq };
  });
  if (!Array.isArray(run.findings)) throw refuse('findings 的形状不对');
  const findings = run.findings.map((f: unknown) => {
    if (!isObject(f) || typeof f.claim !== 'string') throw refuse('findings 的形状不对');
    return { claim: f.claim };
  });

  let chosen: RecordedAction[];
  if (picked === undefined) {
    chosen = actions.filter(isDefaultPick);
  } else {
    const bySeq = new Map(actions.map((a) => [a.seq, a]));
    chosen = picked.map((n) => {
      const a = bySeq.get(n);
      if (a === undefined) throw new E2kError('usage', '--steps 里有记录里不存在的序号');
      return a;
    });
  }
  if (chosen.length < 1) throw refuse('没有可导出的步骤');
  if (chosen.length > MAX_STEPS) throw refuse(`选中的步骤超过 ${MAX_STEPS} 条`);

  const built: CaseFile = {
    e2kCase: 1,
    name: String(name),
    source: { session, kernelVersion },
    open: { url, profile: st.profile.replace('@', '/'), viewport, touch: st.touch, readonly: st.readonly, allow: openAllow },
    steps: chosen.map(stepFor),
    allow,
    findings,
    containsWrites: w.allowed.length > 0 || declared.length > 0 || openAllow.length > 0,
  };
  // 出口再过一遍 parseCase：导出的永远是 parseCase 认的，认不了就拒绝导出（不写出一份重放不了的文件）。
  try {
    return parseCase(JSON.stringify(built));
  } catch (e) {
    if (e instanceof E2kError) throw refuse(e.message.replace('用例文件不对：', '导出的用例不合格：'));
    throw e;
  }
}
