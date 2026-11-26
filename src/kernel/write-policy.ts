import type { Decision, RequestInfo } from '../driver/types.ts';
import type { Mode } from '../shared/protocol.ts';
import { graphqlKind, isPersistedOnly, isStrictQuery } from './graphql.ts';

// 写策略（设计 5.3）。只读模式里只放行读（GET/HEAD/OPTIONS）和严格的 GraphQL query，其余一律拦；拿不准的也拦（失败关闭）。
// reason 只给报告分组用，放行时是 null。
export type BlockReason = 'method' | 'graphql-mutation' | 'persisted-query' | 'redirected-write' | 'unattributed';
export interface PolicyVerdict { decision: Decision; reason: BlockReason | null }

export interface WritePolicy {
  decide(req: RequestInfo, ctx: { mode: Mode }): PolicyVerdict;                      // 属于某个会话的页发出的请求
  decideUnattributed(req: RequestInfo, ctx: { anyReadonly: boolean }): PolicyVerdict;   // 归不到任何会话或登录页的请求
}

export const BLOCK_MESSAGE = 'blocked by e2k read-only mode';

const PASS: PolicyVerdict = Object.freeze({ decision: Object.freeze({ action: 'continue' as const }), reason: null });
const PASS_NO_REDIRECT: PolicyVerdict = Object.freeze({ decision: Object.freeze({ action: 'continue' as const, followRedirects: false as const }), reason: null });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isSafeMethod = (method: string): boolean => SAFE_METHODS.has(method.toUpperCase());

function block(req: RequestInfo, reason: BlockReason): PolicyVerdict {
  const decision: Decision = req.isNavigation
    ? { action: 'fulfill', status: 403, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>e2k</title><p>${BLOCK_MESSAGE}</p>` }
    : { action: 'fulfill', status: 403, contentType: 'application/json', body: JSON.stringify({ error: BLOCK_MESSAGE }) };
  return { decision, reason };
}

function decideReadonly(req: RequestInfo): PolicyVerdict {
  if (isSafeMethod(req.method)) {
    return graphqlKind(null, null, req.url) === 'mutation' ? block(req, 'graphql-mutation') : PASS;
  }
  if (isPersistedOnly(req.body)) return block(req, 'persisted-query');
  if (graphqlKind(req.body, req.contentType, req.url) === 'mutation') return block(req, 'graphql-mutation');
  if (isStrictQuery(req.method, req.body, req.contentType, req.url)) return PASS_NO_REDIRECT;
  return block(req, 'method');
}

export const policy: WritePolicy = Object.freeze({
  decide(req: RequestInfo, ctx: { mode: Mode }): PolicyVerdict {
    if (ctx.mode === 'default') return PASS;
    if (ctx.mode === 'readonly') return decideReadonly(req);
    return { decision: { action: 'abort' }, reason: 'method' };   // denied 和不认识的模式
  },
  decideUnattributed(req: RequestInfo, ctx: { anyReadonly: boolean }): PolicyVerdict {
    if (!ctx.anyReadonly || isSafeMethod(req.method)) return PASS;
    return block({ ...req, isNavigation: false }, 'unattributed');
  },
});

// 留给测试：一律放行。
export const allowAllPolicy: WritePolicy = Object.freeze({ decide: (): PolicyVerdict => PASS, decideUnattributed: (): PolicyVerdict => PASS });
