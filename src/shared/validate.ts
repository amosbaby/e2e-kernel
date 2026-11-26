import { E2kError } from './errors.ts';

// 外部输入校验。不合格一律抛 E2kError('usage')；消息只说字段名和要求，不回显原值。

const MAX_URL_LENGTH = 2048;
const MAX_KEY_SHOWN = 40;

function usage(message: string): E2kError {
  return new E2kError('usage', message);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown, name: string, o: { min?: number; max: number; pattern?: RegExp }): string {
  const min = o.min ?? 0;
  if (typeof v !== 'string') throw usage(`${name} must be a string`);
  if (v.length < min || v.length > o.max) throw usage(`${name} must be ${min}-${o.max} characters long`);
  if (o.pattern !== undefined && !o.pattern.test(v)) throw usage(`${name} has an invalid format`);
  return v;
}

export function int(v: unknown, name: string, o: { min: number; max: number }): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw usage(`${name} must be an integer`);
  if (v < o.min || v > o.max) throw usage(`${name} must be between ${o.min} and ${o.max}`);
  return v;
}

export function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw usage(`${name} must be true or false`);
  return v;
}

export function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw usage(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

export function httpUrl(v: unknown, name: string): string {
  const rule = `${name} must be an http or https URL of at most ${MAX_URL_LENGTH} characters, without user name or password`;
  if (typeof v !== 'string' || v.length > MAX_URL_LENGTH) throw usage(rule);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw usage(rule);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw usage(rule);
  if (url.username !== '' || url.password !== '') throw usage(rule);
  if (url.href.length > MAX_URL_LENGTH) throw usage(rule);
  return url.href;
}

export function plainObject(v: unknown, name: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw usage(`${name} must be an object`);
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw usage(`${name} must be a plain object`);
  for (const key of Object.keys(v)) {
    if (!allowedKeys.includes(key)) {
      // 键名来自外部：JSON 引号转义控制字符，并截短，避免把超长内容带进输出。
      const shown = key.length > MAX_KEY_SHOWN ? `${key.slice(0, MAX_KEY_SHOWN)}...` : key;
      throw usage(`${name} has an unexpected key ${JSON.stringify(shown)}`);
    }
  }
  return v as Record<string, unknown>;
}
