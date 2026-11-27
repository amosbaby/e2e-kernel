import { E2kError } from '../shared/errors.ts';
import { plainObject } from '../shared/validate.ts';
import type { Declaration } from './approval-store.ts';
import { parseEndpoint } from './rules.ts';

// 放行声明的规范化（设计 5.4）。协议层只查类型和长度，写法在这里判：方法只收四个写方法，地址照接口写法（绝对 http(s)、
// 不带查询串、片段和账号密码，`*` 只能是整段），operation 是 GraphQL 的名字。规范化之后的值才拿去弹框、比对、落盘。
export const DECLARABLE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const MAX_DECLARATIONS = 12;
const OPERATION_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,99}$/;

// 一条声明的全部内容，当比较和排序的键。
export const declarationKey = (d: Declaration): string => JSON.stringify([d.method, d.url, d.operation]);

export const sameDeclaration = (a: Declaration, b: Declaration): boolean => declarationKey(a) === declarationKey(b);

// 去重、按码点排序：同一组声明不管怎么写、什么顺序，规范化后都是同一个列表。不合格一律 usage，消息只说字段名，不回显原值。
export function normalizeDeclarations(raw: readonly unknown[]): Declaration[] {
  if (raw.length > MAX_DECLARATIONS) throw new E2kError('usage', `allow must have at most ${MAX_DECLARATIONS} entries`);
  const byKey = new Map<string, Declaration>();
  raw.forEach((item, i) => {
    const name = `allow[${i}]`;
    const o = plainObject(item, name, ['method', 'url', 'operation']);
    const e = parseEndpoint({ method: o.method, url: o.url }, name, { methods: DECLARABLE_METHODS });
    let operation: string | null = null;
    if (o.operation !== undefined) {
      if (typeof o.operation !== 'string' || !OPERATION_NAME.test(o.operation)) {
        throw new E2kError('usage', `${name}.operation must match ${OPERATION_NAME.source}`);
      }
      operation = o.operation;
    }
    const d: Declaration = { method: e.method, url: `${e.origin}/${e.path.join('/')}`, operation };
    byKey.set(declarationKey(d), d);
  });
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, d]) => d);
}
