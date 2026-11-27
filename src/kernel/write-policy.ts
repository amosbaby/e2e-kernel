import type { Decision, RequestInfo } from '../driver/types.ts';
import type { Mode } from '../shared/protocol.ts';
import { graphqlKind, isMutationLikeUrl, isPersistedOnly, isStrictQuery } from './graphql.ts';

// 写策略（设计 5.3）。只读模式里只放行读（GET/HEAD/OPTIONS）和严格的 GraphQL query，其余一律拦；拿不准的也拦（失败关闭）。
// reason 只给报告分组用，放行时是 null。
export type BlockReason = 'method' | 'graphql-mutation' | 'persisted-query' | 'redirected-write' | 'unattributed' | 'other-group';
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

// 跨组导航的提示（组名只含小写字母、数字、_、-）：写进 403 页面，也进 step 的 notices。
export function otherGroupMessage(targetGroup: string, ownGroup: string): string {
  return `这个域名属于组 ${targetGroup}，当前 profile 是组 ${ownGroup} 的。请用 --profile ${targetGroup} 另开会话。`;
}

// 顶层导航去了别的组的域名：回一张 403 页面，不放行。host 是已脱敏的目标主机；页面上的转义由这里做。
export function blockOtherGroup(host: string, targetGroup: string, ownGroup: string): PolicyVerdict {
  const esc = host.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><meta charset="utf-8"><title>e2k</title><p>${otherGroupMessage(targetGroup, ownGroup)}</p><p>目标主机：${esc}</p>`;
  return { decision: { action: 'fulfill', status: 403, contentType: 'text/html; charset=utf-8', body }, reason: 'other-group' };
}

// 会话已冻结（页面经重定向进了别的组的域名）：它所有页的所有请求，含 GET，一律 403，原因记 other-group。
// 组名只含小写字母、数字、_、-，不用转义。
// group 为 null 是判断不出归属（失败关闭）。
export function frozenMessage(group: string | null): string {
  return group === null ? '会话已冻结：页面经重定向去了判断不出归属的域名。请关掉这个会话，重新开。'
    : `会话已冻结：页面经重定向进了组 ${group} 的域名。请关掉这个会话，用 --profile ${group} 另开。`;
}

export function blockFrozen(req: RequestInfo, group: string | null): PolicyVerdict {
  const decision: Decision = req.isNavigation
    ? { action: 'fulfill', status: 403, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>e2k</title><p>${frozenMessage(group)}</p>` }
    : { action: 'fulfill', status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'blocked by e2k: session frozen after a cross-group redirect' }) };
  return { decision, reason: 'other-group' };
}

function decideReadonly(req: RequestInfo): PolicyVerdict {
  // 带体的 GET/HEAD/OPTIONS 不算读（浏览器不会发，没有误伤）：和其他方法一样走下面的写检查，过不了 isStrictQuery，最后落到 method。
  if (isSafeMethod(req.method) && req.body === null) {
    return isMutationLikeUrl(req.url) ? block(req, 'graphql-mutation') : PASS;
  }
  if (isPersistedOnly(req.body)) return block(req, 'persisted-query');
  if (graphqlKind(req.body, req.contentType, req.url) === 'mutation' || isMutationLikeUrl(req.url)) return block(req, 'graphql-mutation');
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
