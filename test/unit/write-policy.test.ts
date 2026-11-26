import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestInfo } from '../../src/driver/types.ts';
import { BLOCK_MESSAGE, allowAllPolicy, policy } from '../../src/kernel/write-policy.ts';
import type { BlockReason } from '../../src/kernel/write-policy.ts';

const JSON_CT = 'application/json';
const j = (v: unknown): string => JSON.stringify(v);
const req = (o: Partial<RequestInfo> = {}): RequestInfo => ({
  id: 'r1', pageId: 'p1', openerPageId: null, method: 'GET', url: 'http://localhost/api', resourceType: 'fetch',
  isNavigation: false, topFrame: false, topUrl: 'http://localhost/', initiatorUrl: 'http://localhost/', contentType: null, body: null, fromLoginForm: null, ...o,
});
const post = (body: string | null, contentType: string | null = JSON_CT, o: Partial<RequestInfo> = {}): RequestInfo =>
  req({ method: 'POST', url: 'http://localhost/graphql', contentType, body, ...o });
const ro = (r: RequestInfo) => policy.decide(r, { mode: 'readonly' });

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
    assert.deepEqual(ro(req({ method })), { decision: { action: 'continue' }, reason: null });
  }
});

test('a GET whose url query parameter is a mutation is blocked; other GET queries pass', () => {
  blocked(ro(req({ url: 'http://localhost/graphql?query=mutation%7Ba%7D' })), 'graphql-mutation');
  blocked(ro(req({ method: 'HEAD', url: 'http://localhost/graphql?query=mutation%7Ba%7D' })), 'graphql-mutation');
  assert.deepEqual(ro(req({ url: 'http://localhost/graphql?query=query%7Ba%7D' })), { decision: { action: 'continue' }, reason: null });
  assert.deepEqual(ro(req({ url: 'http://localhost/graphql' })), { decision: { action: 'continue' }, reason: null });
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
    assert.deepEqual(policy.decide(req({ method, body: 'x' }), { mode: 'default' }), { decision: { action: 'continue' }, reason: null });
  }
  assert.deepEqual(policy.decide(req(), { mode: 'denied' }), { decision: { action: 'abort' }, reason: 'method' });
  assert.deepEqual(policy.decide(req(), { mode: 'bogus' as never }), { decision: { action: 'abort' }, reason: 'method' });
});

test('unattributed requests are only blocked when some session is read-only, and only writes', () => {
  assert.deepEqual(policy.decideUnattributed(req({ method: 'POST' }), { anyReadonly: false }), { decision: { action: 'continue' }, reason: null });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'GET' }), { anyReadonly: true }), { decision: { action: 'continue' }, reason: null });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'head' }), { anyReadonly: true }), { decision: { action: 'continue' }, reason: null });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'OPTIONS' }), { anyReadonly: true }), { decision: { action: 'continue' }, reason: null });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'POST' }), { anyReadonly: true }), { decision: BLOCK_JSON, reason: 'unattributed' });
  assert.deepEqual(policy.decideUnattributed(req({ method: 'purge' }), { anyReadonly: true }), { decision: BLOCK_JSON, reason: 'unattributed' });
});

test('allowAllPolicy allows everything and is frozen', () => {
  assert.deepEqual(allowAllPolicy.decide(req({ method: 'POST' }), { mode: 'readonly' }), { decision: { action: 'continue' }, reason: null });
  assert.deepEqual(allowAllPolicy.decideUnattributed(req({ method: 'POST' }), { anyReadonly: true }), { decision: { action: 'continue' }, reason: null });
  assert.ok(Object.isFrozen(allowAllPolicy));
});

test('OPTIONS with a body is not a safe read: it goes through the write checks', () => {
  blocked(ro(req({ method: 'OPTIONS', url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: 'mutation{b}' }) })), 'graphql-mutation');
  blocked(ro(req({ method: 'OPTIONS', url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: 'query{a}' }) })), 'method');
  blocked(ro(req({ method: 'options', body: '' })), 'method');
  assert.deepEqual(ro(req({ method: 'OPTIONS' })), { decision: { action: 'continue' }, reason: null });
});

test('a GET whose query parameter hides a mutation behind odd whitespace or a semicolon is blocked', () => {
  for (const q of ['%0Bmutation%7Ba%7D', '%0Cmutation%7Ba%7D', '%C2%A0mutation%7Ba%7D']) {
    blocked(ro(req({ url: `http://localhost/graphql?query=${q}` })), 'graphql-mutation');
  }
  blocked(ro(req({ url: 'http://localhost/graphql?x=1;query=mutation%7Ba%7D' })), 'graphql-mutation');
  blocked(ro(req({ method: 'HEAD', url: 'http://localhost/graphql?x=1;query=%0Bmutation%7Ba%7D' })), 'graphql-mutation');
  assert.deepEqual(ro(req({ url: 'http://localhost/graphql?query=query%7Ba%7D&x=mutation' })), { decision: { action: 'continue' }, reason: null });
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
  const v = policy.decideUnattributed(req({ method: 'POST', isNavigation: true, topFrame: true }), { anyReadonly: true });
  assert.deepEqual(v, { decision: BLOCK_JSON, reason: 'unattributed' });
});

test('a percent-encoded query key behind a semicolon cannot hide a mutation, in GET and POST alike', () => {
  for (const tail of ['x=1;%71uery=mutation%7Ba%7D', 'x=1;%51uery=mutation%7Ba%7D', 'x=1;que%72y=%0Bmutation%7Ba%7D', 'x=1;%zzuery=mutation%7Ba%7D']) {
    const url = `http://localhost/graphql?${tail}`;
    blocked(ro(req({ url })), 'graphql-mutation');
    blocked(ro(post(j({ query: 'query{a}' }), JSON_CT, { url })), 'graphql-mutation');
  }
  assert.deepEqual(ro(req({ url: 'http://localhost/graphql?x=1;%71uery=query%7Ba%7D' })), { decision: { action: 'continue' }, reason: null });
  blocked(ro(post(j({ query: 'query{a}' }), JSON_CT, { url: 'http://localhost/graphql?x=1;%71uery=query%7Ba%7D' })), 'method');
});

test('any safe method that carries a body goes through the write checks', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    blocked(ro(req({ method, url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: 'mutation{b}' }) })), 'graphql-mutation');
    blocked(ro(req({ method, url: 'http://localhost/graphql', contentType: JSON_CT, body: j({ query: 'query{a}' }) })), 'method');
  }
  assert.deepEqual(ro(req({ method: 'GET', body: null })), { decision: { action: 'continue' }, reason: null });
});
