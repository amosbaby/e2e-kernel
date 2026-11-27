import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestInfo } from '../../src/driver/types.ts';
import { BLOCK_MESSAGE, DEFAULT_CTX, allowAllPolicy, blockFrozen, blockOtherGroup, frozenMessage, otherGroupMessage, policy } from '../../src/kernel/write-policy.ts';
import type { BlockReason, PolicyCtx } from '../../src/kernel/write-policy.ts';
import { parseEndpoint } from '../../src/kernel/rules.ts';
import type { Declaration } from '../../src/kernel/approval-store.ts';

const JSON_CT = 'application/json';
const j = (v: unknown): string => JSON.stringify(v);
const req = (o: Partial<RequestInfo> = {}): RequestInfo => ({
  id: 'r1', pageId: 'p1', openerPageId: null, method: 'GET', url: 'http://localhost/api', resourceType: 'fetch',
  isNavigation: false, topFrame: false, topUrl: 'http://localhost/', initiatorUrl: 'http://localhost/', contentType: null, body: null, fromLoginForm: null, ...o,
});
const post = (body: string | null, contentType: string | null = JSON_CT, o: Partial<RequestInfo> = {}): RequestInfo =>
  req({ method: 'POST', url: 'http://localhost/graphql', contentType, body, ...o });
const ro = (r: RequestInfo) => policy.decide(r, { ...DEFAULT_CTX, mode: 'readonly' });

const BLOCK_JSON = { action: 'fulfill', status: 403, contentType: 'application/json', body: `{"error":"${BLOCK_MESSAGE}"}` };
const BLOCK_HTML = { action: 'fulfill', status: 403, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>e2k</title><p>${BLOCK_MESSAGE}</p>` };

function blocked(v: ReturnType<typeof ro>, reason: BlockReason): void {
  assert.deepEqual(v.decision, BLOCK_JSON);
  assert.equal(v.reason, reason);
}
function allowed(v: ReturnType<typeof ro>): void {
  assert.deepEqual(v.decision, { action: 'continue', followRedirects: false });
  assert.equal(v.reason, null);
}

test('the block message is fixed', () => {
  assert.equal(BLOCK_MESSAGE, 'blocked by e2k read-only mode');
});

test('safe methods are allowed in read-only mode', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
    assert.deepEqual(ro(req({ method })), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  }
});

test('a GET whose url query parameter is a mutation is blocked; other GET queries pass', () => {
  blocked(ro(req({ url: 'http://localhost/graphql?query=mutation%7Ba%7D' })), 'graphql-mutation');
  blocked(ro(req({ method: 'HEAD', url: 'http://localhost/graphql?query=mutation%7Ba%7D' })), 'graphql-mutation');
  assert.deepEqual(ro(req({ url: 'http://localhost/graphql?query=query%7Ba%7D' })), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  assert.deepEqual(ro(req({ url: 'http://localhost/graphql' })), { decision: { action: 'continue' }, reason: null, allowedBy: null });
});

test('a strict GraphQL query over POST is allowed without following redirects', () => {
  allowed(ro(post(j({ query: 'query{a}' }))));
  allowed(ro(post(j({ query: '{a}' }))));
  allowed(ro(post(j({ query: 'query Q($n: Int) { a(n: $n) { id } }', variables: { n: 1 } }), 'application/json; charset=utf-8')));
  allowed(ro(post('{ a }', 'application/graphql')));
  allowed(ro(post('[{"query":"query{a}"},{"query":"{b}"}]')));
  allowed(ro(post(j({ query: '# note\n{a}' }))));
  allowed(ro(req({ method: 'post', url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: '{a}' }) })));
});

test('a mutation is blocked as graphql-mutation, including inside a batch', () => {
  blocked(ro(post(j({ query: 'mutation{b}' }))), 'graphql-mutation');
  blocked(ro(post(j([{ query: 'query{a}' }, { query: 'mutation{b}' }]))), 'graphql-mutation');
  blocked(ro(post('mutation { b }', 'application/graphql')), 'graphql-mutation');
  blocked(ro(post(j({ query: 'query{a}' }), JSON_CT, { url: 'http://localhost/graphql?query=mutation%7Bb%7D' })), 'graphql-mutation');
  blocked(ro(req({ method: 'PUT', url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: 'mutation{b}' }) })), 'graphql-mutation');
});

test('a persisted query carried only by its hash is blocked', () => {
  blocked(ro(post(j({ extensions: { persistedQuery: { sha256Hash: 'x' } } }))), 'persisted-query');
  blocked(ro(post(j([{ query: 'query{a}' }, { extensions: { persistedQuery: { sha256Hash: 'x' } } }]))), 'persisted-query');
  blocked(ro(post(j({ query: 5, extensions: { persistedQuery: { sha256Hash: 'x' } } }))), 'persisted-query');
});

test('everything that is not a strict query is blocked as method', () => {
  blocked(ro(req({ method: 'DELETE', url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: '{a}' }) })), 'method');
  blocked(ro(post(j({ query: '{a}' }), 'text/plain')), 'method');
  blocked(ro(post(j({ query: '{a}' }), null)), 'method');
  blocked(ro(post(j({ query: 'query builder' }))), 'method');
  blocked(ro(post(j({ query: 1 }))), 'method');
  blocked(ro(post('{"query":"query{')), 'method');
  blocked(ro(post(j({ query: 'subscription{a}' }))), 'method');
  blocked(ro(post('a=1&b=2', 'application/x-www-form-urlencoded')), 'method');
  blocked(ro(post(null)), 'method');
  blocked(ro(post(j({ query: '{a}' }), JSON_CT, { url: 'http://localhost/graphql?query=garbage%20%23' })), 'method');
  blocked(ro(req({ method: 'patch' })), 'method');
  blocked(ro(req({ method: 'PROPFIND' })), 'method');
});

test('a navigation is answered with an HTML page, a subresource with JSON', () => {
  const nav = ro(post('a=1', 'application/x-www-form-urlencoded', { isNavigation: true, topFrame: true }));
  assert.deepEqual(nav.decision, BLOCK_HTML);
  assert.equal(nav.reason, 'method');
  const navMutation = ro(req({ url: 'http://localhost/graphql?query=mutation%7Ba%7D', isNavigation: true }));
  assert.deepEqual(navMutation.decision, BLOCK_HTML);
  assert.equal(navMutation.reason, 'graphql-mutation');
  blocked(ro(post('a=1', 'application/x-www-form-urlencoded')), 'method');
});

test('default mode lets everything through; denied and unknown modes abort', () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.deepEqual(policy.decide(req({ method, body: 'x' }), { ...DEFAULT_CTX, mode: 'default' }), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  }
  assert.deepEqual(policy.decide(req(), { ...DEFAULT_CTX, mode: 'denied' }), { decision: { action: 'abort' }, reason: 'method', allowedBy: null });
  assert.deepEqual(policy.decide(req(), { ...DEFAULT_CTX, mode: 'bogus' as never }), { decision: { action: 'abort' }, reason: 'method', allowedBy: null });
});

test('unattributed requests are only blocked when some session is read-only, and only writes', () => {
  assert.deepEqual(policy.decideUnattributed(req({ method: 'POST' }), { anyReadonly: false, logout: [] }), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'GET' }), { anyReadonly: true, logout: [] }), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'head' }), { anyReadonly: true, logout: [] }), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'OPTIONS' }), { anyReadonly: true, logout: [] }), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'POST' }), { anyReadonly: true, logout: [] }), { decision: BLOCK_JSON, reason: 'unattributed', allowedBy: null });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'purge' }), { anyReadonly: true, logout: [] }), { decision: BLOCK_JSON, reason: 'unattributed', allowedBy: null });
});

test('unattributed requests get the same read-only check as session requests: a safe method with a mutation-like URL or with a body is blocked', () => {
  const un = (r: RequestInfo) => policy.decideUnattributed(r, { anyReadonly: true, logout: [] });
  const mutationUrl = 'https://api.example.com/graphql?query=mutation%7BdeleteAll%7D';
  assert.deepEqual(un(req({ method: 'GET', url: mutationUrl })), { decision: BLOCK_JSON, reason: 'graphql-mutation', allowedBy: null });
  assert.deepEqual(un(req({ method: 'HEAD', url: mutationUrl })), { decision: BLOCK_JSON, reason: 'graphql-mutation', allowedBy: null });
  // 同一个请求在会话路径上也是这个原因：两条路径口径一致
  assert.equal(ro(req({ method: 'GET', url: mutationUrl })).reason, 'graphql-mutation');
  assert.deepEqual(un(req({ method: 'OPTIONS', url: 'http://localhost/api', contentType: JSON_CT, body: '{"a":1}' })), { decision: BLOCK_JSON, reason: 'unattributed', allowedBy: null });
  assert.deepEqual(un(req({ method: 'GET', url: 'http://localhost/api', contentType: JSON_CT, body: '{"query":"query{a}"}' })), { decision: BLOCK_JSON, reason: 'unattributed', allowedBy: null });
  // 导航也回 JSON（不给未归属的页面画 403 页）
  assert.deepEqual(un(req({ method: 'GET', url: mutationUrl, isNavigation: true, topFrame: true })), { decision: BLOCK_JSON, reason: 'graphql-mutation', allowedBy: null });
  // 普通 GET/HEAD/OPTIONS、带普通查询串的 GET 仍放行；没有只读会话时什么都不拦
  for (const r of [req({ method: 'GET' }), req({ method: 'HEAD' }), req({ method: 'OPTIONS' }), req({ method: 'GET', url: 'http://localhost/api?page=2&q=hello' })]) {
    assert.deepEqual(un(r), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  }
  assert.deepEqual(policy.decideUnattributed(req({ method: 'GET', url: mutationUrl }), { anyReadonly: false, logout: [] }), { decision: { action: 'continue' }, reason: null, allowedBy: null });
});

test('allowAllPolicy allows everything and is frozen', () => {
  assert.deepEqual(allowAllPolicy.decide(req({ method: 'POST' }), { ...DEFAULT_CTX, mode: 'readonly' }), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  assert.deepEqual(allowAllPolicy.decideUnattributed(req({ method: 'POST' }), { anyReadonly: true, logout: [] }), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  assert.ok(Object.isFrozen(allowAllPolicy));
});

test('OPTIONS with a body is not a safe read: it goes through the write checks', () => {
  blocked(ro(req({ method: 'OPTIONS', url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: 'mutation{b}' }) })), 'graphql-mutation');
  blocked(ro(req({ method: 'OPTIONS', url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: 'query{a}' }) })), 'method');
  blocked(ro(req({ method: 'options', body: '' })), 'method');
  assert.deepEqual(ro(req({ method: 'OPTIONS' })), { decision: { action: 'continue' }, reason: null, allowedBy: null });
});

test('a GET whose query parameter hides a mutation behind odd whitespace or a semicolon is blocked', () => {
  for (const q of ['%0Bmutation%7Ba%7D', '%0Cmutation%7Ba%7D', '%C2%A0mutation%7Ba%7D']) {
    blocked(ro(req({ url: `http://localhost/graphql?query=${q}` })), 'graphql-mutation');
  }
  blocked(ro(req({ url: 'http://localhost/graphql?x=1;query=mutation%7Ba%7D' })), 'graphql-mutation');
  blocked(ro(req({ method: 'HEAD', url: 'http://localhost/graphql?x=1;query=%0Bmutation%7Ba%7D' })), 'graphql-mutation');
  assert.deepEqual(ro(req({ url: 'http://localhost/graphql?query=query%7Ba%7D&x=mutation' })), { decision: { action: 'continue' }, reason: null, allowedBy: null });
});

test('a strict query body is not enough when the url carries a query parameter in semicolon style', () => {
  blocked(ro(post(j({ query: 'query{a}' }), JSON_CT, { url: 'http://localhost/graphql?x=1;query=mutation%7Bb%7D' })), 'graphql-mutation');
  blocked(ro(post(j({ query: 'query{a}' }), JSON_CT, { url: 'http://localhost/graphql?x=1;query=query%7Ba%7D' })), 'method');
});

test('a repeated query key or an extra key in the body is blocked', () => {
  blocked(ro(post('{"query":"mutation{b}","query":"query{a}"}')), 'method');
  blocked(ro(post('{"query":"mutation{b}","quer\\u0079":"query{a}"}')), 'method');
  blocked(ro(post('{"query":"query{a}","query":"query{a}"}')), 'method');
  blocked(ro(req({ method: 'POST', url: 'http://localhost/api/saved-searches', contentType: JSON_CT, body: j({ query: '{status: open}', name: 'x' }) })), 'method');
});

test('an unattributed block answers with JSON even for a navigation', () => {
  const v = policy.decideUnattributed(req({ method: 'POST', isNavigation: true, topFrame: true }), { anyReadonly: true, logout: [] });
  assert.deepEqual(v, { decision: BLOCK_JSON, reason: 'unattributed', allowedBy: null });
});

test('a percent-encoded query key behind a semicolon cannot hide a mutation, in GET and POST alike', () => {
  for (const tail of ['x=1;%71uery=mutation%7Ba%7D', 'x=1;%51uery=mutation%7Ba%7D', 'x=1;que%72y=%0Bmutation%7Ba%7D', 'x=1;%zzuery=mutation%7Ba%7D']) {
    const url = `http://localhost/graphql?${tail}`;
    blocked(ro(req({ url })), 'graphql-mutation');
    blocked(ro(post(j({ query: 'query{a}' }), JSON_CT, { url })), 'graphql-mutation');
  }
  assert.deepEqual(ro(req({ url: 'http://localhost/graphql?x=1;%71uery=query%7Ba%7D' })), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  blocked(ro(post(j({ query: 'query{a}' }), JSON_CT, { url: 'http://localhost/graphql?x=1;%71uery=query%7Ba%7D' })), 'method');
});

test('any safe method that carries a body goes through the write checks', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    blocked(ro(req({ method, url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: 'mutation{b}' }) })), 'graphql-mutation');
    blocked(ro(req({ method, url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: 'query{a}' }) })), 'method');
  }
  assert.deepEqual(ro(req({ method: 'GET', body: null })), { decision: { action: 'continue' }, reason: null, allowedBy: null });
});

test('a cross-group navigation gets a fixed 403 page with the group names and the redacted host, escaped; the reason is other-group', () => {
  const sentence = '这个域名属于组 b，当前 profile 是组 a 的。请用 --profile b 另开会话。';
  assert.equal(otherGroupMessage('b', 'a'), sentence);
  const v = blockOtherGroup('b.example.com', 'b', 'a');
  assert.equal(v.reason, 'other-group');
  assert.deepEqual(v.decision, { action: 'fulfill', status: 403, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8"><title>e2k</title><p>${sentence}</p><p>目标主机：b.example.com</p>` });
  const odd = blockOtherGroup('<b>"x"&\'y\'', 'b', 'a');
  assert.ok(odd.decision.action === 'fulfill' && !odd.decision.body.includes('<b>') && odd.decision.body.includes('&#60;b&#62;'));
});

test('a frozen session answers every request with a fixed 403 (HTML for navigations, JSON otherwise) and reason other-group, GET included', () => {
  const sentence = '会话已冻结：页面经重定向进了组 b 的域名。请关掉这个会话，用 --profile b 另开。';
  assert.equal(frozenMessage('b'), sentence);
  const nav = blockFrozen(req({ method: 'GET', isNavigation: true, topFrame: true }), 'b');
  assert.equal(nav.reason, 'other-group');
  assert.deepEqual(nav.decision, { action: 'fulfill', status: 403, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>e2k</title><p>${sentence}</p>` });
  for (const method of ['GET', 'HEAD', 'POST']) {
    const v = blockFrozen(req({ method }), 'b');
    assert.equal(v.reason, 'other-group');
    assert.ok(v.decision.action === 'fulfill' && v.decision.status === 403 && v.decision.contentType === 'application/json' && v.decision.body.includes('session frozen'));
  }
  assert.ok(frozenMessage(null).includes('判断不出归属'));
});

// ---- 组级白名单（M2b 任务 8） ----

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const API = 'http://api.example.com';
const ep = (method: string, url: string) => parseEndpoint(method === '*' ? { url } : { method, url }, 'x', { methods: 'any' });
const ctxOf = (o: Partial<PolicyCtx> = {}): PolicyCtx => ({ ...DEFAULT_CTX, mode: 'readonly', ...o });
const readPostCtx = ctxOf({ readPosts: [ep('POST', `${API}/v1/*/search`)] });
const pqBody = (hash: string, extra: Record<string, unknown> = {}): string =>
  j({ operationName: 'Q', variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } }, ...extra });
const pqCtx = ctxOf({ persisted: [{ endpoint: ep('POST', `${API}/graphql`), hashes: [HASH_A] }] });
const pqPost = (body: string | null, o: Partial<RequestInfo> = {}): RequestInfo => post(body, JSON_CT, { url: `${API}/graphql`, ...o });
const searchPost = (body: string | null, o: Partial<RequestInfo> = {}): RequestInfo =>
  req({ method: 'POST', url: `${API}/v1/t1/search`, contentType: JSON_CT, body, ...o });

function allowedAs(v: ReturnType<typeof ro>, by: string): void {
  assert.deepEqual(v.decision, { action: 'continue', followRedirects: false });
  assert.deepEqual([v.reason, v.allowedBy], [null, by]);
}

test('a read-POST endpoint lets a POST through without following redirects and says why', () => {
  allowedAs(policy.decide(searchPost(j({ term: 'x' })), readPostCtx), 'read-post');
  allowedAs(policy.decide(searchPost(null), readPostCtx), 'read-post');
  allowedAs(policy.decide(searchPost('term=x', { contentType: 'application/x-www-form-urlencoded' }), readPostCtx), 'read-post');
});

test('a read-POST endpoint is matched exactly: method, origin, path shape, and any query string means no match', () => {
  const verdict = (r: RequestInfo) => policy.decide(r, readPostCtx);
  blocked(verdict(searchPost(j({ term: 'x' }), { url: `${API}/v1/t1/search?x=1` })), 'method');
  blocked(verdict(searchPost(j({ term: 'x' }), { method: 'PUT' })), 'method');
  blocked(verdict(searchPost(j({ term: 'x' }), { url: `${API}/v1/t1/other` })), 'method');
  blocked(verdict(searchPost(j({ term: 'x' }), { url: 'http://other.example.com/v1/t1/search' })), 'method');
  blocked(verdict(searchPost(j({ term: 'x' }), { url: `${API}/v1//search` })), 'method');
});

test('a mutation on a read-POST url is still blocked as graphql-mutation, in every shape', () => {
  const verdict = (r: RequestInfo) => policy.decide(r, readPostCtx);
  blocked(verdict(searchPost(j({ query: 'mutation{a}' }))), 'graphql-mutation');
  blocked(verdict(searchPost(j([{ query: '{a}' }, { query: 'mutation{b}' }]))), 'graphql-mutation');
  blocked(verdict(searchPost(j({ Query: 'mutation{a}' }))), 'graphql-mutation');
  blocked(verdict(searchPost('mutation{a}', { contentType: 'application/graphql' })), 'graphql-mutation');
  blocked(verdict(searchPost(j({ term: 'x' }), { url: `${API}/v1/t1/search?query=mutation%7Ba%7D` })), 'graphql-mutation');
});

test('a GraphQL-looking body on a read-POST url is not a read-post: a strict query goes the strict-query way, the rest is blocked', () => {
  const verdict = (r: RequestInfo) => policy.decide(r, readPostCtx);
  const q = verdict(searchPost(j({ query: '{a}' })));
  assert.deepEqual([q.decision, q.reason, q.allowedBy], [{ action: 'continue', followRedirects: false }, null, null]);   // 严格 query：allowedBy 为 null
  blocked(verdict(searchPost(j({ Query: '{a}' }))), 'method');
  blocked(verdict(searchPost(j({ query: 5 }))), 'method');
  blocked(verdict(searchPost(j([{ term: 1 }, { query: '{a}' }]))), 'method');
  blocked(verdict(searchPost(pqBody(HASH_A))), 'persisted-query');
  blocked(verdict(searchPost(j({ extensions: { PersistedQuery: {} } }))), 'method');
  blocked(verdict(searchPost('{"query":"{a}","x":"cut', {})), 'method');
  blocked(verdict(searchPost('{"term":"x","Query":"{a}', {})), 'method');
  blocked(verdict(searchPost('mutation{a} {b', { contentType: 'application/graphql' })), 'graphql-mutation');
  const doc = verdict(searchPost('{a}', { contentType: 'application/graphql' }));   // 一份文档：不算读型 POST，按严格 query 放行
  assert.deepEqual([doc.reason, doc.allowedBy], [null, null]);
  blocked(verdict(searchPost('subscription { a }', { contentType: 'application/graphql' })), 'method');   // 不是严格 query：拦
});

test('a persisted query is allowed only when the url, the body shape and every hash fit one whitelist entry', () => {
  allowedAs(policy.decide(pqPost(pqBody(HASH_A)), pqCtx), 'persisted-query');
  allowedAs(policy.decide(pqPost(pqBody(HASH_A.toUpperCase())), pqCtx), 'persisted-query');       // 大小写按小写比
  allowedAs(policy.decide(pqPost(`[${pqBody(HASH_A)},${pqBody(HASH_A)}]`), pqCtx), 'persisted-query');
  allowedAs(policy.decide(pqPost(j({ extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A } } })), pqCtx), 'persisted-query');
  const bad = (r: RequestInfo, reason: BlockReason = 'persisted-query') => blocked(policy.decide(r, pqCtx), reason);
  bad(pqPost(pqBody(HASH_B)));                                                                    // 哈希不在白名单
  bad(pqPost(`[${pqBody(HASH_A)},${pqBody(HASH_B)}]`));                                           // 批量里一项不在
  bad(pqPost(pqBody(HASH_A), { url: `${API}/other` }));                                           // URL 不对
  bad(pqPost(pqBody(HASH_A), { url: `${API}/graphql?x=1` }));                                     // 带查询串
  bad(pqPost(pqBody(HASH_A), { url: 'http://evil.example.org/graphql' }));
  bad(pqPost(pqBody(HASH_A), { method: 'PUT' }));                                                 // 方法不对
  bad(pqPost(pqBody(HASH_A), { contentType: 'text/plain' }));                                     // Content-Type 不对
  bad(pqPost(pqBody(HASH_A), { contentType: 'application/x-www-form-urlencoded' }));
  bad(pqPost(pqBody(HASH_A), { contentType: null }));
});

test('a persisted query body with any extra key, case variant, repeated key or truncation is refused', () => {
  // 不论最后落到哪个拦截原因（键对不上时可能是 method，不是 persisted-query），都不能放行、不能有 allowedBy。
  const bad = (body: string) => {
    const v = policy.decide(pqPost(body), pqCtx);
    assert.deepEqual([v.decision.action, v.allowedBy], ['fulfill', null], body.slice(0, 120));
  };
  bad(pqBody(HASH_A, { extra: 1 }));                                                              // 多一个顶层键
  bad(j({ extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A }, other: 1 } }));      // extensions 多一个键
  bad(j({ extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A, extra: 1 } } }));      // persistedQuery 多一个键
  bad(j({ extensions: { persistedQuery: { sha256Hash: HASH_A } } }));                             // 少 version
  bad(j({ Extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A } } }));                 // 键的大小写变体
  bad(j({ extensions: { PersistedQuery: { version: 1, sha256Hash: HASH_A } } }));
  bad(j({ extensions: { persistedQuery: { version: 1, Sha256Hash: HASH_A } } }));
  bad(j({ OperationName: 'Q', extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A } } }));
  bad(j({ query: '{a}', extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A } } }));  // 带查询文档的不是纯持久化查询
  bad(j({ Query: '{a}', extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A } } }));
  bad(j({ extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A.slice(1) } } }));        // 63 位
  bad(j({ extensions: { persistedQuery: { version: 1, sha256Hash: `${HASH_A}0` } } }));
  bad(j({ extensions: { persistedQuery: { version: 1, sha256Hash: `g${HASH_A.slice(1)}` } } }));
  bad(j({ extensions: { persistedQuery: { version: 1, sha256Hash: [HASH_A] } } }));
  bad(j({ extensions: { persistedQuery: { version: '1', sha256Hash: HASH_A } } }));
  bad(j({ operationName: 5, extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A } } }));
  bad(j({ variables: [], extensions: { persistedQuery: { version: 1, sha256Hash: HASH_A } } }));
  bad('[]');
  bad(j([{}]));
  bad(j([pqBody(HASH_A)]));
  bad(`{"extensions":{"persistedQuery":{"version":1,"sha256Hash":"${HASH_B}"}},"extensions":{"persistedQuery":{"version":1,"sha256Hash":"${HASH_A}"}}}`);   // 重复键：前一个被 JSON.parse 丢掉
  bad(`{"extensions":{"persistedQuery":{"version":1,"sha256Hash":"${HASH_A}","sha256Hash":"${HASH_A}"}}}`);
  bad(`{"extensions":{"persistedQuery":{"version":1,"sha256Hash":"${HASH_A}"}},"variables":{"a":1,"a":2}}`);
  bad(pqBody(HASH_A).slice(0, -3));                                                               // 截断
  bad(pqBody(HASH_A, { variables: { pad: 'x'.repeat(64 * 1024) } }));                             // 到了 64 KB：可能被截断
});

test('a persisted query body whose hash is on another endpoint of the group does not borrow that endpoint', () => {
  const ctx = ctxOf({ persisted: [
    { endpoint: ep('POST', `${API}/one`), hashes: [HASH_A] },
    { endpoint: ep('POST', `${API}/two`), hashes: [HASH_B] },
  ] });
  allowedAs(policy.decide(pqPost(pqBody(HASH_B), { url: `${API}/two` }), ctx), 'persisted-query');
  blocked(policy.decide(pqPost(pqBody(HASH_B), { url: `${API}/one` }), ctx), 'persisted-query');
  blocked(policy.decide(pqPost(`[${pqBody(HASH_A)},${pqBody(HASH_B)}]`, { url: `${API}/one` }), ctx), 'persisted-query');
});

test('a persisted query is blocked as before when no whitelist matches (default ctx)', () => {
  blocked(policy.decide(pqPost(pqBody(HASH_A)), ctxOf()), 'persisted-query');
});

test('a logout hit is blocked first, whatever the method, body or other whitelist', () => {
  const ctx = ctxOf({
    logout: [ep('POST', `${API}/auth/logout`), ep('POST', `${API}/graphql`), ep('*', 'http://app.example.com/logout')],
    readPosts: [ep('POST', `${API}/auth/logout`)],
    persisted: [{ endpoint: ep('POST', `${API}/graphql`), hashes: [HASH_A] }],
    declared: [{ method: 'POST', url: `${API}/auth/logout`, operation: null }],
  });
  const nav = policy.decide(req({ method: 'GET', url: 'http://app.example.com/logout', isNavigation: true, topFrame: true }), ctx);
  assert.deepEqual([nav.decision, nav.reason, nav.allowedBy], [BLOCK_HTML, 'logout', null]);
  blocked(policy.decide(req({ method: 'HEAD', url: 'http://app.example.com/logout' }), ctx), 'logout');
  blocked(policy.decide(req({ method: 'POST', url: `${API}/auth/logout`, contentType: JSON_CT, body: '{}' }), ctx), 'logout');
  blocked(policy.decide(pqPost(pqBody(HASH_A)), ctx), 'logout');
  blocked(policy.decide(req({ method: 'GET', url: 'http://app.example.com/logout?next=/' }), ctx), 'logout');   // 登出按路径匹配，忽略查询串
});

test('a logout matches by path: query string, fragment and one trailing slash are ignored, in either direction; other paths and origins do not match', () => {
  const ctx = ctxOf({ logout: [ep('*', 'http://app.example.com/logout'), ep('POST', 'http://app.example.com/session/end/')] });
  const hit = (method: string, url: string) => policy.decide(req({ method, url }), ctx);
  for (const url of ['http://app.example.com/logout?x=1', 'http://app.example.com/logout?returnTo=%2Fa&y=2', 'http://app.example.com/logout/', 'http://app.example.com/logout/?x=1',
    'http://app.example.com/logout#f', 'http://app.example.com/logout?x=1#f', 'http://app.example.com/logout?']) blocked(hit('GET', url), 'logout');
  blocked(hit('POST', 'http://app.example.com/session/end'), 'logout');     // 名单里写了结尾斜杠，请求没有
  blocked(hit('POST', 'http://app.example.com/session/end/?a=b'), 'logout');
  for (const url of ['http://app.example.com/logout/x', 'http://app.example.com/logoutx', 'http://app.example.com//logout', 'http://app.example.com/a/logout', 'http://other.example.com/logout?x=1', 'https://app.example.com/logout?x=1']) {
    assert.equal(hit('GET', url).reason, null, url);
  }
  assert.equal(hit('GET', 'http://app.example.com/session/end').reason, null);   // 方法不对（名单里是 POST）
});

test('logout rules do not matter in the default mode', () => {
  const ctx: PolicyCtx = { ...DEFAULT_CTX, mode: 'default', logout: [ep('*', 'http://app.example.com/logout')] };
  assert.deepEqual(policy.decide(req({ method: 'GET', url: 'http://app.example.com/logout' }), ctx), { decision: { action: 'continue' }, reason: null, allowedBy: null });
  assert.deepEqual(policy.decide(searchPost('x'), { ...ctx, readPosts: [ep('POST', `${API}/v1/*/search`)] }), { decision: { action: 'continue' }, reason: null, allowedBy: null });
});

test('an unattributed logout is blocked while something is read-only; nothing else is whitelisted for unattributed requests', () => {
  const logout = [ep('*', 'http://app.example.com/logout')];
  const nav = policy.decideUnattributed(req({ method: 'GET', url: 'http://app.example.com/logout', isNavigation: true, topFrame: true }), { anyReadonly: true, logout });
  assert.deepEqual([nav.decision, nav.reason, nav.allowedBy], [BLOCK_HTML, 'logout', null]);
  assert.equal(policy.decideUnattributed(req({ method: 'GET', url: 'http://app.example.com/logout' }), { anyReadonly: false, logout }).reason, null);
  assert.equal(policy.decideUnattributed(req({ method: 'GET', url: 'http://app.example.com/other' }), { anyReadonly: true, logout }).reason, null);
  assert.equal(policy.decideUnattributed(searchPost(j({ term: 'x' })), { anyReadonly: true, logout }).reason, 'unattributed');
});

const decl = (method: string, url: string, operation: string | null): Declaration => ({ method, url, operation });

test('a declaration with an operation is the only thing that lets a mutation through, and only when every item names that operation', () => {
  const ctx = ctxOf({ declared: [decl('POST', `${API}/graphql`, 'Save')] });
  const m = (body: string, o: Partial<RequestInfo> = {}) => policy.decide(pqPost(body, o), ctx);
  allowedAs(m(j({ operationName: 'Save', query: 'mutation Save{a}' })), 'declared');
  allowedAs(m(j([{ operationName: 'Save', query: 'mutation Save{a}' }, { operationName: 'Save', query: 'query{b}' }])), 'declared');
  blocked(m(j({ operationName: 'Other', query: 'mutation Other{a}' })), 'graphql-mutation');
  blocked(m(j({ query: 'mutation Save{a}' })), 'graphql-mutation');
  blocked(m(j([{ operationName: 'Save', query: 'mutation Save{a}' }, { operationName: 'Other', query: 'mutation Other{b}' }])), 'graphql-mutation');
  blocked(m(`{"operationName":"Save","operationName":"Other","query":"mutation Save{a}"}`), 'graphql-mutation');
  blocked(m(j({ operationName: 'Save', query: 'mutation Save{a}' }), { url: `${API}/other` }), 'graphql-mutation');
  blocked(m(j({ operationName: 'Save', query: 'mutation Save{a}' }), { url: `${API}/graphql?x=1` }), 'graphql-mutation');
  blocked(m(j({ operationName: 'Save', query: 'mutation Save{a}' }), { method: 'PUT' }), 'graphql-mutation');
  const noOp = ctxOf({ declared: [decl('POST', `${API}/graphql`, null)] });
  blocked(policy.decide(pqPost(j({ operationName: 'Save', query: 'mutation Save{a}' })), noOp), 'graphql-mutation');
});

test('a declaration without an operation covers the address but not a mutation or a hash-only persisted query', () => {
  const ctx = ctxOf({ declared: [decl('POST', `${API}/items/*`, null)] });
  const at = (body: string | null, o: Partial<RequestInfo> = {}) => req({ method: 'POST', url: `${API}/items/7`, contentType: JSON_CT, body, ...o });
  allowedAs(policy.decide(at(j({ name: 'x' })), ctx), 'declared');
  allowedAs(policy.decide(at(null), ctx), 'declared');
  blocked(policy.decide(at(j({ query: 'mutation{a}' })), ctx), 'graphql-mutation');
  blocked(policy.decide(at(pqBody(HASH_A)), ctx), 'persisted-query');
  blocked(policy.decide(at(j({ name: 'x' }), { method: 'DELETE' }), ctx), 'method');
});

test('a declaration with an operation covers non-mutation requests only when they name it too; a bad declaration matches nothing', () => {
  const ctx = ctxOf({ declared: [decl('POST', `${API}/graphql`, 'Save')] });
  allowedAs(policy.decide(pqPost(j({ operationName: 'Save', variables: { a: 1 } })), ctx), 'declared');
  blocked(policy.decide(pqPost(j({ operationName: 'Other', variables: { a: 1 } })), ctx), 'method');
  const bad = ctxOf({ declared: [decl('GET', `${API}/graphql`, null), decl('POST', 'not a url', null), decl('POST', `${API}/graphql?x=1`, null)] });
  blocked(policy.decide(pqPost(j({ a: 1 })), bad), 'method');
});

test('whitelisted allows never come from the strict-query path and carry allowedBy; strict queries and plain reads carry null', () => {
  const strict = policy.decide(post(j({ query: '{a}' })), ctxOf());
  assert.deepEqual([strict.reason, strict.allowedBy], [null, null]);
  assert.equal(policy.decide(req(), ctxOf()).allowedBy, null);
});

// ---- 修复轮 1 ----

test('a hash-only persisted query is never covered by a declaration, with or without an operation; only the persistedQueries whitelist lets it through', () => {
  const body = pqBody(HASH_B, { operationName: 'Save' });
  blocked(policy.decide(pqPost(body), ctxOf({ declared: [decl('POST', `${API}/graphql`, 'Save')] })), 'persisted-query');
  blocked(policy.decide(pqPost(body), ctxOf({ declared: [decl('POST', `${API}/graphql`, null)] })), 'persisted-query');
  blocked(policy.decide(pqPost(j({ operationName: 'Save', extensions: { persistedQuery: { version: 1, sha256Hash: HASH_B } } })), ctxOf({ declared: [decl('POST', `${API}/graphql`, 'Save')] })), 'persisted-query');
  allowedAs(policy.decide(pqPost(pqBody(HASH_A, { operationName: 'Save' })), ctxOf({ declared: [decl('POST', `${API}/graphql`, 'Save')], persisted: pqCtx.persisted })), 'persisted-query');
});

test('a hash-only persisted query whose query is empty or blank is hash-only too: no declaration covers it', () => {
  const ext = { persistedQuery: { version: 1, sha256Hash: HASH_B } };
  const withOp = ctxOf({ declared: [decl('POST', `${API}/graphql`, 'Save')] });
  for (const query of ['', '   ', '\n\t']) {
    blocked(policy.decide(pqPost(j({ operationName: 'Save', query, extensions: ext })), withOp), 'persisted-query');
    blocked(policy.decide(pqPost(j({ operationName: 'Save', query, extensions: ext })), ctxOf({ declared: [decl('POST', `${API}/graphql`, null)] })), 'persisted-query');
  }
  blocked(policy.decide(pqPost(j([{ operationName: 'Save', query: 'query{a}' }, { operationName: 'Save', query: '', extensions: ext }])), withOp), 'persisted-query');
});

test('read-POST: a body whose GraphQL kind is unknown is not a read-post (truncated Apollo-style mutation, multipart upload), while ordinary bodies still are', () => {
  const verdict = (r: RequestInfo) => policy.decide(r, readPostCtx);
  // 驱动在 64 KB 处截断：query 键还没出现，键序 operationName, variables, query
  const truncated = `{"operationName":"M","variables":{"pad":"${'x'.repeat(70 * 1024)}"},"query":"mutation M{a}"}`.slice(0, 64 * 1024);
  assert.ok(Buffer.byteLength(truncated) >= 64 * 1024);
  blocked(verdict(searchPost(truncated)), 'method');
  blocked(verdict(searchPost(truncated, { url: `${API}/v1/t1/search` , contentType: 'text/plain' })), 'method');
  const multipart = '--b\r\nContent-Disposition: form-data; name="operations"\r\n\r\n{"query":"mutation{a}"}\r\n--b--\r\n';
  const mp = { contentType: 'multipart/form-data; boundary=b' };
  blocked(verdict(searchPost(multipart, mp)), 'method');
  const gqlCtx = ctxOf({ readPosts: [ep('POST', `${API}/graphql`)] });
  blocked(policy.decide(pqPost(multipart, mp), gqlCtx), 'method');                              // /graphql 路径：kind 是 unknown，也拦
  blocked(policy.decide(pqPost(j({ term: 'x' })), gqlCtx), 'method');
  allowedAs(verdict(searchPost(j({ term: 'x' }))), 'read-post');
  allowedAs(verdict(searchPost('term=x', { contentType: 'application/x-www-form-urlencoded' })), 'read-post');
  allowedAs(verdict(searchPost('--b\r\nContent-Disposition: form-data; name="file"\r\n\r\nabc\r\n--b--\r\n', mp)), 'read-post');
});
