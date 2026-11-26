import { E2kError } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { validateOps } from './ops.ts';
import type { Op, Viewport } from './ops.ts';
import { httpUrl, int, oneOf, plainObject, str } from './validate.ts';

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
export interface Finding { claim: string; basis: string }
export interface OpenParams { url: string; viewport?: Viewport; name?: string }
export interface StepParams { session: string; ops: Op[] }
export interface CloseParams { session: string; verdict?: Verdict; findings?: Finding[]; notDone?: string[] }
export type Outcome = 'ok' | 'match' | 'mismatch' | 'failed' | 'not-run';
export interface RequestSummary { id: string; method: string; url: string; status: number | null; resourceType: string }
export interface OpResult {
  index: number; op: Op['op']; outcome: Outcome;
  output?: string | { level: string; text: string }[] | RequestSummary[];
  actual?: string | number | boolean | null; expected?: string | number | boolean; error?: string; shot?: string;
}
export interface Tallies { ok: number; match: number; mismatch: number; failed: number; notRun: number }
export interface SessionInfo { session: string; name: string; url: string; idleSec: number }
export interface OpenResult {
  session: string; name: string; url: string; title: string; mode: Mode; runDir: string; snapshot: string; blocked: 'login' | null; next: string | null;
}
export interface StepResult {
  session: string; results: OpResult[]; tallies: Tallies; exit: 0 | 10 | 11 | 20; blocked: 'login' | null; next: string | null;
}
export interface CloseResult {
  session: string; runDir: string; reportPath: string; resultPath: string; tallies: Tallies; consistency: 'ok' | 'conflict'; exit: 0 | 10;
}

const METHODS: readonly Method[] = ['status', 'open', 'step', 'close', 'login.begin', 'login.end'];
const VERDICT_VALUES: readonly VerdictValue[] = ['pass', 'fail', 'exists', 'absent', 'undetermined'];
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const SESSION_ID = /^s-[0-9a-f]{6}$/;
const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGIN_ID = /^l-[0-9a-f]{6}$/;
const MAX_LIST = 20;

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
  const o = plainObject(v, name, ['claim', 'basis']);
  return { claim: text500(o.claim, `${name}.claim`), basis: text500(o.basis, `${name}.basis`) };
}

function session(v: unknown): string {
  return str(v, 'params.session', { min: 1, max: 8, pattern: SESSION_ID });
}

export function validateParams(method: 'status', p: unknown): Record<string, never>;
export function validateParams(method: 'open', p: unknown): OpenParams;
export function validateParams(method: 'step', p: unknown): StepParams;
export function validateParams(method: 'close', p: unknown): CloseParams;
export function validateParams(method: 'login.begin', p: unknown): { url: string };
export function validateParams(method: 'login.end', p: unknown): { loginId: string };
export function validateParams(method: Method, p: unknown): unknown {
  switch (method) {
    case 'status':
      plainObject(p, 'params', []);
      return {};
    case 'open': {
      const o = plainObject(p, 'params', ['url', 'viewport', 'name']);
      const out: OpenParams = { url: httpUrl(o.url, 'params.url') };
      if (o.viewport !== undefined) out.viewport = viewport(o.viewport, 'params.viewport');
      if (o.name !== undefined) out.name = str(o.name, 'params.name', { min: 1, max: 40, pattern: SESSION_NAME });
      return out;
    }
    case 'step': {
      const o = plainObject(p, 'params', ['session', 'ops']);
      return { session: session(o.session), ops: validateOps(o.ops) };
    }
    case 'close': {
      const o = plainObject(p, 'params', ['session', 'verdict', 'findings', 'notDone']);
      const out: CloseParams = { session: session(o.session) };
      if (o.verdict !== undefined) out.verdict = verdict(o.verdict, 'params.verdict');
      if (o.findings !== undefined) {
        out.findings = list(o.findings, 'params.findings', MAX_LIST).map((f, i) => finding(f, `params.findings[${i}]`));
      }
      if (o.notDone !== undefined) {
        out.notDone = list(o.notDone, 'params.notDone', MAX_LIST).map((s, i) => text500(s, `params.notDone[${i}]`));
      }
      return out;
    }
    case 'login.begin': {
      const o = plainObject(p, 'params', ['url']);
      return { url: httpUrl(o.url, 'params.url') };
    }
    case 'login.end': {
      const o = plainObject(p, 'params', ['loginId']);
      return { loginId: str(o.loginId, 'params.loginId', { min: 1, max: 8, pattern: LOGIN_ID }) };
    }
  }
}
