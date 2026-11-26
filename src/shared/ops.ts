import { E2kError } from './errors.ts';
import { bool, httpUrl, int, oneOf, plainObject, str } from './validate.ts';

// step 里的操作（设计 5.6）。校验只用 validate.ts 的小函数拼；多余的键一律拒绝，报错只说字段名。

export type Target = string;   // 快照里的引用（/^(f\d+)?e\d+$/），或选择器字符串，长度 1..500
export interface Viewport { width: number; height: number }   // 宽 320..3840，高 240..2160
export type AssertKind = 'text' | 'count' | 'css' | 'url' | 'visible';
export type Cmp = 'eq' | 'ne' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
export type WaitCond = { text: string } | { target: Target; state: 'visible' | 'hidden' } | { urlContains: string } | { ms: number };
export type Op =
  | { op: 'snapshot'; depth?: number }
  | { op: 'text'; target?: Target; max?: number }
  | { op: 'screenshot'; fullPage?: boolean }
  | { op: 'console' } | { op: 'network' }
  | { op: 'click'; target: Target } | { op: 'hover'; target: Target }
  | { op: 'fill'; target: Target; value: string }
  | { op: 'press'; key: string; target?: Target }
  | { op: 'scroll'; target?: Target; dx?: number; dy?: number }
  | { op: 'goto'; url: string }
  | { op: 'viewport'; width: number; height: number }
  | { op: 'wait'; for: WaitCond; timeoutMs?: number }
  | { op: 'assert'; kind: AssertKind; target?: Target; property?: string; cmp: Cmp; expected: string | number | boolean }
  | { op: 'eval'; js: string };

type OpName = Op['op'];

// 没有正则比较：不把外部输入当正则用。
export const CMP_BY_KIND: Record<AssertKind, readonly Cmp[]> = Object.freeze({
  text: Object.freeze(['eq', 'ne', 'contains'] as const),
  url: Object.freeze(['eq', 'ne', 'contains'] as const),
  count: Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const),
  visible: Object.freeze(['eq', 'ne'] as const),
  css: Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const),
});

export const READ_OPS: ReadonlySet<OpName> = new Set<OpName>(['snapshot', 'text', 'screenshot', 'console', 'network']);

const REF = /^(f\d+)?e\d+$/;
const KEY = /^[\x21-\x7E]{1,50}$/;
const CSS_PROPERTY = /^[a-z-]{1,40}$/;
const MAX_OPS = 50;
const MAX_EXPECTED_TEXT = 2000;

export function isRef(t: Target): boolean {
  return REF.test(t);
}

const KEYS_BY_OP: Record<OpName, readonly string[]> = {
  snapshot: ['op', 'depth'],
  text: ['op', 'target', 'max'],
  screenshot: ['op', 'fullPage'],
  console: ['op'],
  network: ['op'],
  click: ['op', 'target'],
  hover: ['op', 'target'],
  fill: ['op', 'target', 'value'],
  press: ['op', 'key', 'target'],
  scroll: ['op', 'target', 'dx', 'dy'],
  goto: ['op', 'url'],
  viewport: ['op', 'width', 'height'],
  wait: ['op', 'for', 'timeoutMs'],
  assert: ['op', 'kind', 'target', 'property', 'cmp', 'expected'],
  eval: ['op', 'js'],
};
const OP_NAMES = Object.keys(KEYS_BY_OP) as OpName[];
const ALL_OP_KEYS = [...new Set(Object.values(KEYS_BY_OP).flat())];

const WAIT_VARIANTS: readonly (readonly string[])[] = [['text'], ['target', 'state'], ['urlContains'], ['ms']];
const ALL_WAIT_KEYS = WAIT_VARIANTS.flat();

function target(v: unknown, name: string): Target {
  return str(v, name, { min: 1, max: 500 });
}

function waitCond(v: unknown, name: string): WaitCond {
  const o = plainObject(v, name, ALL_WAIT_KEYS);
  const first = Object.keys(o)[0] ?? '';
  // 由第一个键定变体，再按这个变体的键重新检查：混了别的变体的键、或一个键都没有，都拒绝。
  const variant = WAIT_VARIANTS.find((keys) => keys.includes(first));
  if (variant === undefined) throw new E2kError('usage', `${name} must have exactly one of: text, target and state, urlContains, ms`);
  plainObject(o, name, variant);
  if ('text' in o) return { text: str(o.text, `${name}.text`, { min: 1, max: 500 }) };
  if ('urlContains' in o) return { urlContains: str(o.urlContains, `${name}.urlContains`, { min: 1, max: 500 }) };
  if ('ms' in o) return { ms: int(o.ms, `${name}.ms`, { min: 0, max: 10000 }) };
  return { target: target(o.target, `${name}.target`), state: oneOf(o.state, `${name}.state`, ['visible', 'hidden'] as const) };
}

function expectedFor(kind: AssertKind, v: unknown, name: string): string | number | boolean {
  switch (kind) {
    case 'count':
      return int(v, name, { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
    case 'visible':
      return bool(v, name);
    case 'css':
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new E2kError('usage', `${name} must be a finite number or a string`);
        return v;
      }
      if (typeof v !== 'string') throw new E2kError('usage', `${name} must be a finite number or a string`);
      return str(v, name, { max: MAX_EXPECTED_TEXT });
    case 'text':
    case 'url':
      return str(v, name, { max: MAX_EXPECTED_TEXT });
  }
}

// 只放值不是 undefined 的键：返回值和输入逐键一致，可选字段没给就不出现。
function present<T extends Op>(x: T): T {
  return Object.fromEntries(Object.entries(x).filter(([, val]) => val !== undefined)) as T;
}

function assertOp(o: Record<string, unknown>, name: string): Op {
  const kind = oneOf(o.kind, `${name}.kind`, ['text', 'count', 'css', 'url', 'visible'] as const);
  if (kind === 'url' && o.target !== undefined) throw new E2kError('usage', `${name}.target is not allowed when kind is url`);
  if (kind !== 'css' && o.property !== undefined) throw new E2kError('usage', `${name}.property is only allowed when kind is css`);
  return present({
    op: 'assert',
    kind,
    target: kind === 'url' ? undefined : target(o.target, `${name}.target`),
    property: kind === 'css' ? str(o.property, `${name}.property`, { max: 40, pattern: CSS_PROPERTY }) : undefined,
    cmp: oneOf(o.cmp, `${name}.cmp`, CMP_BY_KIND[kind]),
    expected: expectedFor(kind, o.expected, `${name}.expected`),
  });
}

function validateOp(v: unknown, name: string): Op {
  const raw = plainObject(v, name, ALL_OP_KEYS);
  const op = oneOf(raw.op, `${name}.op`, OP_NAMES);
  const o = plainObject(raw, name, KEYS_BY_OP[op]);
  const optTarget = (): Target | undefined => (o.target === undefined ? undefined : target(o.target, `${name}.target`));
  const optInt = (key: string, min: number, max: number): number | undefined =>
    (o[key] === undefined ? undefined : int(o[key], `${name}.${key}`, { min, max }));

  switch (op) {
    case 'snapshot':
      return present({ op, depth: optInt('depth', 1, 50) });
    case 'text':
      return present({ op, target: optTarget(), max: optInt('max', 1, 20000) });
    case 'screenshot':
      return present({ op, fullPage: o.fullPage === undefined ? undefined : bool(o.fullPage, `${name}.fullPage`) });
    case 'console':
    case 'network':
      return { op };
    case 'click':
    case 'hover':
      return { op, target: target(o.target, `${name}.target`) };
    case 'fill':
      return { op, target: target(o.target, `${name}.target`), value: str(o.value, `${name}.value`, { max: 10000 }) };
    case 'press':
      return present({ op, key: str(o.key, `${name}.key`, { min: 1, max: 50, pattern: KEY }), target: optTarget() });
    case 'scroll':
      return present({ op, target: optTarget(), dx: optInt('dx', -10000, 10000), dy: optInt('dy', -10000, 10000) });
    case 'goto':
      return { op, url: httpUrl(o.url, `${name}.url`) };
    case 'viewport':
      return { op, width: int(o.width, `${name}.width`, { min: 320, max: 3840 }), height: int(o.height, `${name}.height`, { min: 240, max: 2160 }) };
    case 'wait':
      return present({ op, for: waitCond(o.for, `${name}.for`), timeoutMs: optInt('timeoutMs', 0, 60000) });
    case 'assert':
      return assertOp(o, name);
    case 'eval':
      return { op, js: str(o.js, `${name}.js`, { min: 1, max: 20000 }) };
  }
}

export function validateOps(v: unknown): Op[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_OPS) throw new E2kError('usage', `ops must be an array of 1-${MAX_OPS} operations`);
  return v.map((op: unknown, i) => validateOp(op, `ops[${i}]`));
}
