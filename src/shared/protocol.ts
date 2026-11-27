import { E2kError } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { validateOps } from './ops.ts';
import type { Op, Viewport } from './ops.ts';
import { bool, httpUrl, int, oneOf, plainObject, str } from './validate.ts';

// 内核和 CLI 之间的 socket 协议：一条连接一问一答，各一行 JSON，以 \n 结束。

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 1_048_576;
export const MAX_OPS_BYTES = 1_000_000;   // CLI 发送前对 ops 的 JSON 文本做的长度上限

export const ExitCode = { OK: 0, INTERNAL: 1, USAGE: 2, MISMATCH: 10, ACTION_FAILED: 11, WAIT_LOGIN: 20, WAIT_APPROVAL: 21, NEEDS_HUMAN: 22 } as const;

const EXIT_BY_CODE: Record<ErrorCode, number> = {
  'usage': ExitCode.USAGE,
  'not-found': ExitCode.USAGE,
  'busy': ExitCode.USAGE,
  'action-failed': ExitCode.ACTION_FAILED,
  'internal': ExitCode.INTERNAL,
  'needs-human': ExitCode.NEEDS_HUMAN,
  'wait-login': ExitCode.WAIT_LOGIN,
  'wait-approval': ExitCode.WAIT_APPROVAL,
};

export function exitCodeFor(code: ErrorCode): number {
  return EXIT_BY_CODE[code];
}

// 脱敏时值是字符串就原样保留的键（传给 redactDeep 的 skipKeys）。这些键下的值都是内核自己产生的标识和路径，
// 或调用方给定的标识；来自页面的字符串不得放在这些键下面。
// 已知的边界：target、given、selector 的值是 agent 写的或内核生成的选择器，里面可能带页面上的文字
// （data-testid、id、可访问名）。为了能重放，它们必须原样保留。
// 不收 host：主机名照常过脱敏。
export const KERNEL_SKIP_KEYS: readonly string[] = Object.freeze([
  'session', 'name', 'id', 'loginId', 'home', 'runDir', 'reportPath', 'resultPath', 'shot', 'target', 'given', 'selector',
]);

export type Method = 'status' | 'open' | 'step' | 'close' | 'login.begin' | 'login.end';
export type Mode = 'default' | 'readonly' | 'denied';
export interface Request { v: 1; id: string; method: Method; params: unknown }
export type Response =
  | { v: 1; id: string; ok: true; result: unknown }
  | { v: 1; id: string; ok: false; error: { code: ErrorCode; message: string; next?: string } };
export type VerdictValue = 'pass' | 'fail' | 'exists' | 'absent' | 'undetermined';
export interface Verdict { value: VerdictValue; because?: string }
export interface Finding { claim: string; basis: string; verdict?: VerdictValue }
// 「序号 failed 的失败 / 未执行，由之后的序号 by 的成功操作取代」。序号是整个会话从 1 起的序号（OpResult.seq）。
export interface Supersede { failed: number; by: number }
// profile：`组` 或 `组/槽`（只在协议层校验类型和长度，规范化和选择在内核里做）。
export interface OpenParams { url: string; viewport?: Viewport; name?: string; touch?: boolean; readonly?: boolean; profile?: string }
export interface LoginBeginParams { url: string; profile?: string }
// 放行声明（只在 step 上提，一律要人批准）：协议层只查形状和长度，规范化（地址写法、operation 名）在内核里做。
export interface AllowItem { method: string; url: string; operation?: string }
export interface StepParams { session: string; ops: Op[]; keepGoing?: boolean; allow?: AllowItem[] }
export interface CloseParams { session: string; verdict?: Verdict; findings?: Finding[]; notDone?: string[]; superseded?: Supersede[] }
export type Outcome = 'ok' | 'match' | 'mismatch' | 'failed' | 'not-run';
export interface RequestSummary { id: string; method: string; url: string; status: number | null; resourceType: string }
export interface OpResult {
  index: number; op: Op['op']; outcome: Outcome;
  seq: number;   // 整个会话从 1 起的序号，和记录、报告里的序号一致（未执行的也占号）
  output?: string | { level: string; text: string }[] | RequestSummary[];
  actual?: string | number | boolean | null; expected?: string | number | boolean; error?: string; shot?: string;
  hints?: string[];   // 失败时的诊断（匹配了哪几个、谁挡住了点击），已脱敏，每条不超过 300 字符，最多 6 条
}
export interface Tallies { ok: number; match: number; mismatch: number; failed: number; notRun: number }

export function tally(items: readonly { outcome: Outcome }[]): Tallies {
  const t: Tallies = { ok: 0, match: 0, mismatch: 0, failed: 0, notRun: 0 };
  for (const { outcome } of items) {
    if (outcome === 'not-run') t.notRun++;
    else t[outcome]++;
  }
  return t;
}
export interface SessionInfo { session: string; name: string; url: string; idleSec: number }
export interface OpenResult {
  session: string; name: string; url: string; title: string; mode: Mode; runDir: string; snapshot: string; blocked: 'login' | null; next: string | null;
  profile: string;     // 会话用的 profile key（`组` 或 `组@槽`）
  borrowed: boolean;   // 借用了别的组的登录（域名没编组、却指定了某个组的 profile）
  // 身份探针对首屏的结果：组没配身份为 null；前提不满足（页面不在本组的主机上、借用、身份元素 0 个匹配且页面有密码框）为 skipped；mismatch 时会话照样开着，下一次 step 起是 22。
  // 页面有密码框也照常比较（登录墙只是提示，不关探针），所以 blocked 为 'login' 时 identity 也可能是 mismatch。
  identity: 'ok' | 'mismatch' | 'skipped' | null;
}
export interface StepResult {
  session: string; results: OpResult[]; tallies: Tallies; exit: 0 | 10 | 11 | 20; blocked: 'login' | null; next: string | null;
  // 只读模式的提示：writesBlocked 是本批执行期间本会话被拦下的写请求数；notices 是给人和 agent 看的整句提示，退出码不受影响。
  writesBlocked: number; notices: string[];
}
// 结论为 pass 时和记录矛盾的原因（每种至多出现一次，顺序固定）。
export type ConflictReason = 'mismatch' | 'unresolved-failed' | 'unresolved-not-run' | 'not-done' | 'finding-fail';
export const CONFLICT_TEXT: Record<ConflictReason, string> = {
  'mismatch': '有不符的断言', 'unresolved-failed': '有未解决的执行失败', 'unresolved-not-run': '有未解决的未执行操作',
  'not-done': 'agent 自己列了没做的事', 'finding-fail': '有一条结论的判定是不通过',
};
// 不认识的原因（含 'constructor' 这类原型上的名字）一律给固定说明。
export function conflictText(c: unknown): string {
  return typeof c === 'string' && Object.hasOwn(CONFLICT_TEXT, c) ? CONFLICT_TEXT[c as ConflictReason] : '未知原因';
}
export interface CloseResult {
  session: string; runDir: string; reportPath: string; resultPath: string; tallies: Tallies; consistency: 'ok' | 'conflict'; exit: 0 | 10;
  conflicts?: ConflictReason[];   // consistency 为 conflict 时的原因，和 result.json 的 conflicts 一致
}

export const METHODS: readonly Method[] = ['status', 'open', 'step', 'close', 'login.begin', 'login.end'];
const VERDICT_VALUES: readonly VerdictValue[] = ['pass', 'fail', 'exists', 'absent', 'undetermined'];
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const SESSION_ID = /^s-[0-9a-f]{6}$/;
const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGIN_ID = /^l-[0-9a-f]{6}$/;
const MAX_LIST = 20;
const MAX_SUPERSEDED = 50;
const MAX_ALLOW = 12;
const ALLOW_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const MAX_PROFILE_ARG = 65;   // 组 32 + "/" + 槽 32

function usage(message: string): E2kError {
  return new E2kError('usage', message);
}

function list(v: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw usage(`${name} must be an array of at most ${max} items`);
  return v;
}

function text500(v: unknown, name: string): string {
  return str(v, name, { min: 1, max: 500 });
}

export function parseRequest(line: string): Request {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw usage(`request line must be at most ${MAX_LINE_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw usage('request must be one line of JSON');
  }
  const o = plainObject(parsed, 'request', ['v', 'id', 'method', 'params']);
  if (o.v !== PROTOCOL_VERSION) throw usage(`request.v must be ${PROTOCOL_VERSION}`);
  return {
    v: PROTOCOL_VERSION,
    id: str(o.id, 'request.id', { min: 1, max: 64, pattern: REQUEST_ID }),
    method: oneOf(o.method, 'request.method', METHODS),
    params: o.params,
  };
}

function viewport(v: unknown, name: string): Viewport {
  const o = plainObject(v, name, ['width', 'height']);
  return { width: int(o.width, `${name}.width`, { min: 320, max: 3840 }), height: int(o.height, `${name}.height`, { min: 240, max: 2160 }) };
}

function verdict(v: unknown, name: string): Verdict {
  const o = plainObject(v, name, ['value', 'because']);
  const value = oneOf(o.value, `${name}.value`, VERDICT_VALUES);
  if (o.because === undefined) {
    if (value === 'undetermined') throw usage(`${name}.because is required when ${name}.value is undetermined`);
    return { value };
  }
  return { value, because: str(o.because, `${name}.because`, { min: 1, max: 1000 }) };
}

function finding(v: unknown, name: string): Finding {
  const o = plainObject(v, name, ['claim', 'basis', 'verdict']);
  const out: Finding = { claim: text500(o.claim, `${name}.claim`), basis: text500(o.basis, `${name}.basis`) };
  if (o.verdict !== undefined) out.verdict = oneOf(o.verdict, `${name}.verdict`, VERDICT_VALUES);
  return out;
}

function supersede(v: unknown, name: string): Supersede {
  const o = plainObject(v, name, ['failed', 'by']);
  const range = { min: 1, max: Number.MAX_SAFE_INTEGER };
  const failed = int(o.failed, `${name}.failed`, range);
  const by = int(o.by, `${name}.by`, range);
  if (failed >= by) throw usage(`${name}.failed must be smaller than ${name}.by`);
  return { failed, by };
}

function allowItem(v: unknown, name: string): AllowItem {
  const o = plainObject(v, name, ['method', 'url', 'operation']);
  const out: AllowItem = { method: oneOf(o.method, `${name}.method`, ALLOW_METHODS), url: str(o.url, `${name}.url`, { min: 1, max: 2048 }) };
  if (o.operation !== undefined) out.operation = str(o.operation, `${name}.operation`, { min: 1, max: 100 });
  return out;
}

function session(v: unknown): string {
  return str(v, 'params.session', { min: 1, max: 8, pattern: SESSION_ID });
}

export function validateParams(method: 'status', p: unknown): Record<string, never>;
export function validateParams(method: 'open', p: unknown): OpenParams;
export function validateParams(method: 'step', p: unknown): StepParams;
export function validateParams(method: 'close', p: unknown): CloseParams;
export function validateParams(method: 'login.begin', p: unknown): LoginBeginParams;
export function validateParams(method: 'login.end', p: unknown): { loginId: string };
export function validateParams(method: Method, p: unknown): unknown {
  switch (method) {
    case 'status':
      plainObject(p, 'params', []);
      return {};
    case 'open': {
      const o = plainObject(p, 'params', ['url', 'viewport', 'name', 'touch', 'readonly', 'profile']);
      const out: OpenParams = { url: httpUrl(o.url, 'params.url') };
      if (o.viewport !== undefined) out.viewport = viewport(o.viewport, 'params.viewport');
      if (o.name !== undefined) out.name = str(o.name, 'params.name', { min: 1, max: 40, pattern: SESSION_NAME });
      if (o.touch !== undefined) out.touch = bool(o.touch, 'params.touch');
      if (o.readonly !== undefined) out.readonly = bool(o.readonly, 'params.readonly');
      if (o.profile !== undefined) out.profile = str(o.profile, 'params.profile', { min: 1, max: MAX_PROFILE_ARG });
      return out;
    }
    case 'step': {
      const o = plainObject(p, 'params', ['session', 'ops', 'keepGoing', 'allow']);
      const out: StepParams = { session: session(o.session), ops: validateOps(o.ops) };
      if (o.keepGoing !== undefined) out.keepGoing = bool(o.keepGoing, 'params.keepGoing');
      if (o.allow !== undefined) out.allow = list(o.allow, 'params.allow', MAX_ALLOW).map((x, i) => allowItem(x, `params.allow[${i}]`));
      return out;
    }
    case 'close': {
      const o = plainObject(p, 'params', ['session', 'verdict', 'findings', 'notDone', 'superseded']);
      const out: CloseParams = { session: session(o.session) };
      if (o.verdict !== undefined) out.verdict = verdict(o.verdict, 'params.verdict');
      if (o.findings !== undefined) {
        out.findings = list(o.findings, 'params.findings', MAX_LIST).map((f, i) => finding(f, `params.findings[${i}]`));
      }
      if (o.notDone !== undefined) {
        out.notDone = list(o.notDone, 'params.notDone', MAX_LIST).map((s, i) => text500(s, `params.notDone[${i}]`));
      }
      if (o.superseded !== undefined) {
        out.superseded = list(o.superseded, 'params.superseded', MAX_SUPERSEDED).map((x, i) => supersede(x, `params.superseded[${i}]`));
      }
      return out;
    }
    case 'login.begin': {
      const o = plainObject(p, 'params', ['url', 'profile']);
      const out: LoginBeginParams = { url: httpUrl(o.url, 'params.url') };
      if (o.profile !== undefined) out.profile = str(o.profile, 'params.profile', { min: 1, max: MAX_PROFILE_ARG });
      return out;
    }
    case 'login.end': {
      const o = plainObject(p, 'params', ['loginId']);
      return { loginId: str(o.loginId, 'params.loginId', { min: 1, max: 8, pattern: LOGIN_ID }) };
    }
  }
}
