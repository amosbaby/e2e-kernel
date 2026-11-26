import type { AssertKind, Cmp } from '../shared/ops.ts';

// 判定纯函数：确定的值由代码判，不调驱动、不做 I/O。结果只叫相符 / 不符。
export interface Comparison {
  match: boolean;
  actual: string | number | boolean | null;
  expected: string | number | boolean;
}

type Value = string | number | boolean;

// 整串锚定：值前后多出任何字符（标点、括号、第二个值）都不匹配，返回 null。
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d+(?:\.\d+)?|\.\d+)\s*)?\)$/i;
const LENGTH = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i;

export function normalizeColor(s: string): string | null {
  const v = s.trim();
  const hex = HEX_COLOR.exec(v);
  if (hex !== null) {
    const h = hex[1] as string;
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    const n = (i: number): number => Number.parseInt(full.slice(i, i + 2), 16);
    return `rgba(${n(0)},${n(2)},${n(4)},1)`;
  }
  const rgb = RGB_COLOR.exec(v);
  if (rgb === null) return null;
  const channels = [rgb[1], rgb[2], rgb[3]].map(Number);
  if (channels.some((c) => c > 255)) return null;
  const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if (!(alpha >= 0 && alpha <= 1)) return null;
  return `rgba(${channels.join(',')},${alpha})`;
}

export function normalizeLength(v: string | number): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v + 0 : null;
  const s = v.trim();
  if (!LENGTH.test(s)) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n + 0 : null; // + 0 把 -0 变成 0
}

// 字符串或有限数字才有文字形式；其余（布尔、NaN、Infinity）不参与 css 比较。
function asText(v: Value | null): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function equality(cmp: Cmp, same: boolean): boolean {
  if (cmp === 'eq') return same;
  if (cmp === 'ne') return !same;
  return false;
}

// 只对两个有限数字调用；其余比较符（含 contains）一律不符。
function ordered(cmp: Cmp, a: number, b: number): boolean {
  switch (cmp) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'contains': return false;
  }
}

function cssMatch(cmp: Cmp, actual: Value, expected: Value, property: string | undefined): boolean {
  const a = asText(actual);
  const e = asText(expected);
  if (a === null || e === null) return false;
  if (property !== undefined && property.toLowerCase().includes('color')) {
    const ca = normalizeColor(a);
    const ce = normalizeColor(e);
    if (ca !== null && ce !== null) return equality(cmp, ca === ce);
    return equality(cmp, a === e); // 不能归一就按字符串比；颜色没有大小
  }
  const la = normalizeLength(a);
  const le = normalizeLength(e);
  if (la !== null && le !== null) return ordered(cmp, la, le);
  // 任一边不是数值：只有 eq、ne 能按字符串比；大小比较不符，绝不按字典序。
  return equality(cmp, a === e);
}

function textMatch(cmp: Cmp, actual: Value, expected: Value): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (cmp === 'contains') return actual.includes(expected);
  return equality(cmp, actual === expected);
}

function countMatch(cmp: Cmp, actual: Value, expected: Value): boolean {
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return ordered(cmp, actual, expected);
}

function visibleMatch(cmp: Cmp, actual: Value, expected: Value): boolean {
  if (typeof actual !== 'boolean' || typeof expected !== 'boolean') return false;
  return equality(cmp, actual === expected);
}

export function compare(kind: AssertKind, cmp: Cmp, actual: Value | null, expected: Value, property?: string): Comparison {
  let match = false;
  if (actual !== null) {
    switch (kind) {
      case 'text':
      case 'url':
        match = textMatch(cmp, actual, expected);
        break;
      case 'count':
        match = countMatch(cmp, actual, expected);
        break;
      case 'css':
        match = cmp !== 'contains' && cssMatch(cmp, actual, expected, property);
        break;
      case 'visible':
        match = visibleMatch(cmp, actual, expected);
        break;
    }
  }
  return { match, actual, expected };
}
