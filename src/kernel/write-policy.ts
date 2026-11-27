import type { Decision, RequestInfo } from '../driver/types.ts';
import type { Mode } from '../shared/protocol.ts';
import type { Declaration } from './approval-store.ts';
import { graphqlKind, isMutationLikeUrl, isPersistedOnly, isStrictQuery, looksGraphql, operationsAre, persistedHashes } from './graphql.ts';
import { matchEndpoint, parseEndpoint } from './rules.ts';
import type { Endpoint, PersistedSet } from './rules.ts';

// 写策略（设计 5.3）。只读模式里只放行读（GET/HEAD/OPTIONS）、严格的 GraphQL query，和组级白名单里的写（读型 POST、持久化查询、
// 经批准的放行声明）；其余一律拦，拿不准的也拦（失败关闭）。登出先于一切：命中就拦。
// reason 只给报告分组用，放行时是 null；allowedBy 是白名单放行的依据，其余放行和所有拦截都是 null。
export type BlockReason = 'method' | 'graphql-mutation' | 'persisted-query' | 'redirected-write' | 'unattributed' | 'other-group' | 'logout';
export type AllowedBy = 'read-post' | 'persisted-query' | 'declared';
export interface PolicyVerdict { decision: Decision; reason: BlockReason | null; allowedBy: AllowedBy | null }

// 一次判定要用的上下文：有效模式，和已经按组选好的清单（内核组装，策略不认识组）。
export interface PolicyCtx {
  mode: Mode;
  logout: readonly Endpoint[];
  readPosts: readonly Endpoint[];
  persisted: readonly PersistedSet[];
  declared: readonly Declaration[];
}
export const DEFAULT_CTX: PolicyCtx = Object.freeze({ mode: 'default', logout: Object.freeze([]), readPosts: Object.freeze([]), persisted: Object.freeze([]), declared: Object.freeze([]) });

export interface WritePolicy {
  decide(req: RequestInfo, ctx: PolicyCtx): PolicyVerdict;                                                   // 属于某个会话的页发出的请求
  // 归不到任何会话或登录页的请求；logout 是请求目标主机所在组的登出接口（只读时命中就拦）。不放行任何白名单里的写。
  decideUnattributed(req: RequestInfo, ctx: { anyReadonly: boolean; logout: readonly Endpoint[] }): PolicyVerdict;
}

export const BLOCK_MESSAGE = 'blocked by e2k read-only mode';

const PASS: PolicyVerdict = Object.freeze({ decision: Object.freeze({ action: 'continue' as const }), reason: null, allowedBy: null });
const PASS_NO_REDIRECT: PolicyVerdict = Object.freeze({ decision: Object.freeze({ action: 'continue' as const, followRedirects: false as const }), reason: null, allowedBy: null });

// 白名单放行：一律不跟重定向（写不能被 307/308 带到没判过的地方；跨源的保证见 README Known gaps）。
function allow(allowedBy: AllowedBy): PolicyVerdict {
  return Object.freeze({ decision: Object.freeze({ action: 'continue' as const, followRedirects: false as const }), reason: null, allowedBy });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isSafeMethod = (method: string): boolean => SAFE_METHODS.has(method.toUpperCase());

function block(req: RequestInfo, reason: BlockReason): PolicyVerdict {
  const decision: Decision = req.isNavigation
    ? { action: 'fulfill', status: 403, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>e2k</title><p>${BLOCK_MESSAGE}</p>` }
    : { action: 'fulfill', status: 403, contentType: 'application/json', body: JSON.stringify({ error: BLOCK_MESSAGE }) };
  return { decision, reason, allowedBy: null };
}

// 跨组导航的提示（组名只含小写字母、数字、_、-）：写进 403 页面，也进 step 的 notices。
export function otherGroupMessage(targetGroup: string, ownGroup: string): string {
  return `这个域名属于组 ${targetGroup}，当前 profile 是组 ${ownGroup} 的。请用 --profile ${targetGroup} 另开会话。`;
}

// 顶层导航去了别的组的域名：回一张 403 页面，不放行。host 是已脱敏的目标主机；页面上的转义由这里做。
export function blockOtherGroup(host: string, targetGroup: string, ownGroup: string): PolicyVerdict {
  const esc = host.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><meta charset="utf-8"><title>e2k</title><p>${otherGroupMessage(targetGroup, ownGroup)}</p><p>目标主机：${esc}</p>`;
  return { decision: { action: 'fulfill', status: 403, contentType: 'text/html; charset=utf-8', body }, reason: 'other-group', allowedBy: null };
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
  return { decision, reason: 'other-group', allowedBy: null };
}

const DECLARABLE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

const anyMatch = (list: readonly Endpoint[], req: RequestInfo): boolean => list.some((e) => matchEndpoint(e, req.method, req.url));

// 放行声明命中：方法和 URL 命中（URL 按接口写法匹配，带查询串的请求不会命中）；带 operation 的，请求体每一项的 operationName 都要等于它。
// 不带 operation 的声明只放行「这个地址上的写」：mutation 不归它（调用方已先判过），只带哈希的持久化查询也不归它（文档看不到）。
// 声明读不懂就当没命中（失败关闭）。mutationOnly：只认带 operation 的声明。
function declaredHit(req: RequestInfo, declared: readonly Declaration[], mutationOnly: boolean): boolean {
  return declared.some((d) => {
    if (mutationOnly && d.operation === null) return false;
    try {
      const e = parseEndpoint({ method: d.method, url: d.url }, 'declaration', { methods: DECLARABLE_METHODS });
      if (!matchEndpoint(e, req.method, req.url)) return false;
    } catch {
      return false;
    }
    return d.operation === null ? !isPersistedOnly(req.body) : operationsAre(req.body, d.operation);
  });
}

// 只读模式的判定顺序（顺序就是语义，不能换）：
// ① 命中登出 → 拦（任何方法，先于一切）；② 安全方法无体 → 照 M2a；③ 判出 mutation → 只有带 operation 的声明命中才放行，否则拦；
// ④ 命中读型 POST 且体不像 GraphQL → 放行；⑤ 持久化查询：体形状严格、URL 命中某个接口、哈希全在它的白名单里 → 放行；
// ⑥ 命中放行声明 → 放行；⑦ M2a 其余：持久化查询拦、严格 query 放行、其余拦 method。
function decideReadonly(req: RequestInfo, ctx: PolicyCtx): PolicyVerdict {
  if (anyMatch(ctx.logout, req)) return block(req, 'logout');
  if (isSafeMethod(req.method) && req.body === null) {
    return isMutationLikeUrl(req.url) ? block(req, 'graphql-mutation') : PASS;
  }
  if (graphqlKind(req.body, req.contentType, req.url) === 'mutation' || isMutationLikeUrl(req.url)) {
    return declaredHit(req, ctx.declared, true) ? allow('declared') : block(req, 'graphql-mutation');
  }
  // application/graphql 的体是一份文档，不是 JSON：也算 GraphQL。
  const isDoc = (req.contentType ?? '').split(';')[0]!.trim().toLowerCase() === 'application/graphql';
  if (anyMatch(ctx.readPosts, req) && !looksGraphql(req.body) && !isDoc) return allow('read-post');
  const hashes = persistedHashes(req.method, req.body, req.contentType);
  if (hashes !== null && ctx.persisted.some((p) => matchEndpoint(p.endpoint, req.method, req.url) && hashes.every((h) => p.hashes.includes(h)))) {
    return allow('persisted-query');
  }
  if (declaredHit(req, ctx.declared, false)) return allow('declared');
  if (isPersistedOnly(req.body)) return block(req, 'persisted-query');
  if (isStrictQuery(req.method, req.body, req.contentType, req.url)) return PASS_NO_REDIRECT;
  return block(req, 'method');
}

export const policy: WritePolicy = Object.freeze({
  decide(req: RequestInfo, ctx: PolicyCtx): PolicyVerdict {
    if (ctx.mode === 'default') return PASS;
    if (ctx.mode === 'readonly') return decideReadonly(req, ctx);
    return { decision: { action: 'abort' }, reason: 'method', allowedBy: null };   // denied 和不认识的模式
  },
  decideUnattributed(req: RequestInfo, ctx: { anyReadonly: boolean; logout: readonly Endpoint[] }): PolicyVerdict {
    if (!ctx.anyReadonly) return PASS;
    if (anyMatch(ctx.logout, req)) return block(req, 'logout');
    if (isSafeMethod(req.method)) return PASS;
    return block({ ...req, isNavigation: false }, 'unattributed');
  },
});

// 留给测试：一律放行。
export const allowAllPolicy: WritePolicy = Object.freeze({ decide: (): PolicyVerdict => PASS, decideUnattributed: (): PolicyVerdict => PASS });
