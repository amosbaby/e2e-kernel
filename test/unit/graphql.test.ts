import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphqlKind, isMutationLikeUrl, isPersistedOnly, isStrictQuery } from '../../src/kernel/graphql.ts';

const JSON_CT = 'application/json';
const URL_GQL = 'http://localhost/graphql';
const URL_API = 'http://localhost/api/items';
const j = (v: unknown): string => JSON.stringify(v);
const kind = (body: string | null, ct: string | null = JSON_CT, url = URL_API) => graphqlKind(body, ct, url);

test('an anonymous query, a shorthand query and a named query are queries', () => {
  assert.equal(kind(j({ query: '{ viewer { id } }' })), 'query');
  assert.equal(kind(j({ query: 'query Orders($n: Int!) { orders(first: $n) { id } }' })), 'query');
  assert.equal(kind(j({ query: '  \n# note\nquery { a }', operationName: 'x' })), 'query');
});

test('a named or anonymous mutation is a mutation, even after fragments', () => {
  assert.equal(kind(j({ query: 'mutation Save($i: In!) { save(input: $i) { id } }' })), 'mutation');
  assert.equal(kind(j({ query: 'mutation { save { id } }' })), 'mutation');
  assert.equal(kind(j({ query: 'fragment F on Item { id name }\nmutation M { save { ...F } }' })), 'mutation');
  assert.equal(kind(j({ query: 'fragment F on Item { id }\nquery Q { a { ...F } }\nmutation M { b }' })), 'mutation', 'any mutation wins');
  assert.equal(kind(j({ query: 'subscription S { tick }' })), 'subscription');
  assert.equal(kind(j({ query: 'query Q { a } subscription S { b }' })), 'subscription');
});

test('keywords inside strings, block strings, comments and selections do not count', () => {
  assert.equal(kind(j({ query: 'query Q { find(text: "mutation { x }") { id } }' })), 'query');
  assert.equal(kind(j({ query: 'query Q { find(text: "say \\"mutation\\" now") { id } }' })), 'query');
  assert.equal(kind(j({ query: 'query Q { find(text: """\nmutation M { x }\n\\""" mutation\n""") { id } }' })), 'query');
  assert.equal(kind(j({ query: '# mutation M { x }\nquery Q { a }' })), 'query');
  assert.equal(kind(j({ query: 'query Q { mutation subscription }' })), 'query', 'field names inside a selection set');
  assert.equal(kind(j({ query: 'query Q($mutation: Int) { a(x: $mutation) }' })), 'query');
  assert.equal(kind(j({ query: 'query Q @mutation { a }' })), 'query', 'a directive name');
  assert.equal(kind(j({ query: 'query Q { a }\n# trailing mutation' })), 'query');
});

test('a mutation hidden behind a comment-like or string-like prefix is still found', () => {
  assert.equal(kind(j({ query: '{ a(s: "#") } mutation M { b }' })), 'mutation', 'a # inside a string is not a comment');
  assert.equal(kind(j({ query: '{ a }\r# c\rmutation M { b }' })), 'mutation', 'carriage return ends a comment');
  assert.equal(kind(j({ query: '{ a }\u2028mutation M { b }' })), 'unknown', 'a line separator is not GraphQL white space');
  assert.equal(kind(j({ query: '{ a }\u2029mutation M { b }' })), 'unknown');
  assert.equal(kind(j({ query: 'query Q { a } mutation M { b }' })), 'mutation');
});

test('ambiguity is never reported as a query', () => {
  assert.equal(kind(j({ query: 'query Q { a ' })), 'unknown', 'unbalanced braces');
  assert.equal(kind(j({ query: 'query Q { a } }' })), 'unknown', 'extra closer');
  assert.equal(kind(j({ query: 'query Q { a(s: "unterminated) }' })), 'unknown');
  assert.equal(kind(j({ query: 'query Q { a(s: """unterminated) }' })), 'unknown');
  assert.equal(kind(j({ query: '' })), 'unknown');
  assert.equal(kind(j({ query: 'type T { a: Int }' })), 'unknown', 'no operation at all');
  assert.equal(kind(j({ query: 'scalar X\nmutation { a }' })), 'unknown', 'a keyword after a non-operation definition is not trusted');
  assert.equal(kind(j({ query: 42 })), 'unknown');
  assert.equal(kind(j({ query: null })), 'unknown');
});

test('application/graphql bodies are the document itself', () => {
  assert.equal(kind('{ viewer { id } }', 'application/graphql'), 'query');
  assert.equal(kind('mutation { save { id } }', 'application/graphql; charset=utf-8'), 'mutation');
  assert.equal(kind('mutation { save { id } }', 'Application/GraphQL'), 'mutation');
});

test('persisted queries carry no document: unknown', () => {
  assert.equal(kind(j({ extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } })), 'unknown');
  assert.equal(kind(j({ operationName: 'X', extensions: { persistedQuery: {} } }), JSON_CT, URL_GQL), 'unknown');
  assert.equal(kind(j({ query: 'mutation { a }', extensions: { persistedQuery: {} } })), 'mutation', 'a document wins when it is present');
});

test('batches: any mutation wins, all queries stay a query, anything else is unknown', () => {
  assert.equal(kind(j([{ query: '{ a }' }, { query: 'query Q { b }' }])), 'query');
  assert.equal(kind(j([{ query: '{ a }' }, { query: 'mutation { b }' }])), 'mutation');
  assert.equal(kind(j([{ query: 'mutation { b }' }, { extensions: { persistedQuery: {} } }])), 'mutation');
  assert.equal(kind(j([{ query: '{ a }' }, { extensions: { persistedQuery: {} } }])), 'unknown');
  assert.equal(kind(j([{ query: '{ a }' }, { query: 'subscription { b }' }])), 'unknown');
  assert.equal(kind(j([{ query: '{ a }' }, 7])), 'unknown');
  assert.equal(kind(j([]), JSON_CT, URL_GQL), 'unknown');
  assert.equal(kind(j([]), JSON_CT, URL_API), null);
});

test('not GraphQL: null; unparseable bodies on a /graphql path: unknown', () => {
  assert.equal(kind(j({ name: 'x', qty: 2 })), null);
  assert.equal(kind(j([1, 2, 3])), null);
  assert.equal(kind('a=1&b=2', 'application/x-www-form-urlencoded'), null);
  assert.equal(kind(null, null), null);
  assert.equal(kind('{not json', JSON_CT, URL_GQL), 'unknown');
  assert.equal(kind('query=mutation%20%7B%20a%20%7D', 'application/x-www-form-urlencoded', URL_GQL), 'unknown');
  assert.equal(kind(null, null, URL_GQL), 'unknown');
  assert.equal(kind(j({ name: 'x' }), JSON_CT, URL_GQL), 'unknown', 'a /graphql path with a body that has no query');
  assert.equal(kind(j({ name: 'x' }), JSON_CT, 'http://localhost/api/GraphQL/v2'), 'unknown', 'path match ignores case');
  assert.equal(kind('{"query":"mutation { a }', JSON_CT, URL_API), 'unknown', 'a cut-off JSON body that mentions query is not trusted as plain JSON');
  assert.equal(kind(j({ query: 'mutation { a }' }), JSON_CT, 'not a url'), 'mutation');
});

test('the classification does not echo the body', () => {
  const marker = 'marker-value-0451';
  for (const v of [kind(j({ query: `mutation { a(x: "${marker}") }` })), kind(`{"query":"${marker}`, JSON_CT, URL_GQL), kind(j({ n: marker }))]) {
    assert.ok(v === null || ['query', 'mutation', 'subscription', 'unknown'].includes(v));
  }
});

test('adversarial documents finish quickly', () => {
  const N = 40_000;
  const cases: string[] = [
    '"'.repeat(N), '"""'.repeat(N), '\\"'.repeat(N), '"""\\'.repeat(N), '#'.repeat(N), '#\n'.repeat(N), '{'.repeat(N), '}'.repeat(N),
    '{ '.repeat(N), '(['.repeat(N), 'query '.repeat(N), 'mutation'.repeat(N), '{a}'.repeat(N), '"a" '.repeat(N), '"""a""" '.repeat(N),
    'fragment F on T { a } '.repeat(N / 8), '\\'.repeat(N), ' '.repeat(N), `${'a'.repeat(N)} mutation`,
  ];
  for (const doc of cases) {
    const t0 = Date.now();
    const doc64 = doc.slice(0, 64 * 1024);
    graphqlKind(doc64, 'application/graphql', URL_GQL);
    graphqlKind(JSON.stringify({ query: doc64 }), JSON_CT, URL_GQL);
    assert.ok(Date.now() - t0 < 2000, `slow on ${JSON.stringify(doc.slice(0, 12))}`);
  }
  const t0 = Date.now();
  graphqlKind(`[${'{"query":"{a}"},'.repeat(4000)}{"query":"{a}"}]`, JSON_CT, URL_GQL);
  graphqlKind('['.repeat(N), JSON_CT, URL_GQL);
  graphqlKind(`[${'['.repeat(30_000)}]`, JSON_CT, URL_GQL);
  assert.ok(Date.now() - t0 < 2000);
});

// 驱动的做法：先按字节截到 64 KB，再按 utf8 解码。
const driverCut = (text: string): string => Buffer.from(text, 'utf8').subarray(0, 64 * 1024).toString('utf8');
const DOC = 'application/graphql';

test('a body that reaches the driver cap may be cut off: only a mutation already seen is kept', () => {
  assert.equal(kind(driverCut(`query A{a}${' '.repeat(70_000)}mutation B{x}`), DOC), 'unknown', 'the mutation is past the cut');
  assert.equal(kind(driverCut(`query A{a}${' '.repeat(65_525)}mutat`), DOC), 'unknown', 'cut in the middle of the keyword');
  assert.equal(kind(driverCut(`mutation B{x}${' '.repeat(70_000)}`), DOC), 'mutation');
  // 截在多字节字符中间：解码后的字符数可以少于字节数，不能靠字符数判断。
  const cutMid = driverCut(`query A{a}${' '.repeat(65_525 - 1)}€ mutation B{x}`);   // 欧元符号 3 字节，只留下前 1 个字节
  assert.ok(cutMid.endsWith('�'));
  assert.equal(kind(cutMid, DOC), 'unknown');
  const twoByte = driverCut(`query A{a}${' '.repeat(65_525)}${'é'.repeat(10)} mutation B{x}`);
  assert.equal(kind(twoByte, DOC), 'unknown');
  // JSON 也一样：被截断的解析不了，含 "query" 就是 unknown；恰好合法但到了上限的也不信。
  assert.equal(kind(driverCut(j({ query: `query A{a}${' '.repeat(70_000)}mutation B{x}` }))), 'unknown');
  assert.equal(kind(driverCut(j({ pad: 'x'.repeat(70_000), query: 'mutation { a }' }))), 'unknown');
  const exact = (q: string): string => { const head = `{"query":"${q}","pad":"`; return `${head}${'x'.repeat(65_536 - head.length - 2)}"}`; };
  assert.equal(Buffer.byteLength(exact('{ a }'), 'utf8'), 65_536);
  assert.equal(kind(exact('{ a }')), 'unknown', 'valid JSON of cap size, still not trusted');
  assert.equal(kind(exact('mutation { a }')), 'mutation');
  // 低于上限、没被截断的不受影响；和 GraphQL 无关的大请求体仍是 null。
  assert.equal(kind(`query A{a}${' '.repeat(65_000)}`, DOC), 'query');
  assert.equal(kind(`a=${'x'.repeat(70_000)}`, 'application/x-www-form-urlencoded'), null);
});

test('a Description before an operation does not hide it', () => {
  assert.equal(kind(j({ query: 'query Q{a} "d" mutation M{b}' })), 'mutation');
  assert.equal(kind(j({ query: '"""d""" mutation M{b}' })), 'mutation');
  assert.equal(kind(j({ query: '"d" query Q{a}' })), 'query');
  assert.equal(kind(j({ query: 'query Q{a} """d\nmore""" subscription S{b}' })), 'subscription');
});

test('the Content-Type does not decide: JSON is tried first, a document only if it is not JSON', () => {
  assert.equal(kind('{"query":"mutation M{a}"}', DOC), 'mutation');
  assert.equal(kind('[{"query":"{a}"},{"query":"mutation M{a}"}]', DOC), 'mutation');
  assert.equal(kind('{"query":"{a}"}', DOC), 'query');
  assert.equal(kind('{"name":"x"}', DOC), 'unknown');
  assert.equal(kind('{}', DOC), 'unknown');
  assert.equal(kind('{ a }', DOC), 'query', 'a shorthand document is not JSON');
  assert.equal(kind('{"query":"mutation M{a}"}', 'text/plain'), 'mutation');
});

test('a non-operation definition with directive arguments is not read as an operation', () => {
  assert.equal(kind(j({ query: 'type T @d(x:1) { a }' })), 'unknown');
  assert.equal(kind(j({ query: 'scalar X @d(a: 1) { a }' })), 'unknown');
  assert.equal(kind(j({ query: 'type T @d(x:1) { a } mutation M { b }' })), 'mutation');
});

test('a character GraphQL does not allow makes a query ambiguous', () => {
  assert.equal(kind(j({ query: '{ a } ¿ query { b }' })), 'unknown');
  assert.equal(kind(j({ query: '{ a } ¿ mutation { b }' })), 'unknown', 'never a query');
});

test('a query parameter in the URL counts too: a mutation on either side is a mutation, anything else is unknown', () => {
  const withQ = (q: string, path = 'http://localhost/graphql'): string => `${path}?query=${encodeURIComponent(q)}`;
  assert.equal(kind(j({ query: '{ a }' }), JSON_CT, withQ('mutation { b }')), 'mutation', 'the URL parameter decides on some servers');
  assert.equal(kind('{ a }', 'application/graphql', withQ('mutation M { b }')), 'mutation');
  assert.equal(kind(null, null, withQ('mutation { b }')), 'mutation', 'a body-less write too');
  assert.equal(kind(j({ query: 'mutation { b }' }), JSON_CT, withQ('{ a }')), 'mutation');
  assert.equal(kind(j({ query: '{ a }' }), JSON_CT, withQ('{ a }')), 'unknown', 'never a query when two documents compete');
  assert.equal(kind(null, null, withQ('{ a }')), 'unknown');
  assert.equal(kind(j({ n: 1 }), JSON_CT, withQ('{ a }', 'http://localhost/api/x')), 'unknown');
  assert.equal(kind(j({ query: '{ a }' }), JSON_CT, 'http://localhost/graphql?Query=mutation%20%7B%20b%20%7D'), 'mutation', 'the key is case-insensitive');
  assert.equal(kind(j({ query: '{ a }' }), JSON_CT, 'http://localhost/graphql?x=1&QUERY=%7B%20a%20%7D&query=mutation%7Bb%7D'), 'mutation', 'every occurrence is read');
  assert.equal(kind(j({ query: '{ a }' }), JSON_CT, 'http://localhost/graphql?operationName=a&q=1'), 'query', 'other parameters do not matter');
  assert.equal(kind(j({ query: '{ a }' }), JSON_CT, 'http://localhost/graphql?query=mutation{b}#x'), 'mutation');
});

test('a JSON key that is "query" in another case is not ignored', () => {
  assert.equal(kind(j({ Query: 'mutation { b }' })), 'mutation');
  assert.equal(kind(j({ QUERY: '{ a }' })), 'unknown', 'only a lower-case key is read as a plain query');
  assert.equal(kind(j({ query: '{ a }', Query: 'mutation { b }' })), 'mutation');
  assert.equal(kind(j({ query: '{ a }', QUERY: '{ b }' })), 'unknown', 'two matching keys');
  assert.equal(kind(j({ Query: 7 })), 'unknown');
  assert.equal(kind(j([{ query: '{ a }' }, { Query: 'mutation { b }' }])), 'mutation');
  assert.equal(kind(j({ query: '{ a }', variables: { query: 'x' } })), 'query', 'a nested "query" key (variables.query) is not the operation');
  assert.equal(kind(j({ name: 'x', variables: { query: 'x' } })), null);
});

test('a definition that starts with another word, or brackets that do not pair, are never a query', () => {
  assert.equal(kind(j({ query: '{a} scalar S mutation M{b}' })), 'unknown');
  assert.equal(kind(j({ query: '{a} extend type T { x: Int } query Q { b }' })), 'unknown');
  assert.equal(kind(j({ query: '{a] mutation M{b}' })), 'unknown');
  assert.equal(kind(j({ query: 'query Q { a(x: [1, 2) } }' })), 'unknown');
  assert.equal(kind(j({ query: 'query Q { a(x: [1, 2}) }' })), 'unknown');
  assert.equal(kind(j({ query: '{a} } mutation M{b}' })), 'unknown');
  assert.equal(kind(j({ query: 'fragment F on T { a } query Q { ...F }' })), 'query');
  assert.equal(kind(j({ query: 'query Q { a(x: [1, {k: 2}]) { b } }' })), 'query');
  assert.equal(kind(j({ query: 'scalar S mutation M{b} mutation N{c}' })), 'mutation', 'a mutation that is seen is kept');
});

test('the cut-off check counts bytes, not characters', () => {
  // 注释里放 21000 个 3 字节字符：解码后的字符数远小于 64K，字节数却到了上限；欧元符号只留下 1 个字节，落在注释里。
  const text = `query A{a}\n#${'€'.repeat(21_000)}${'x'.repeat(2_523)}€\nmutation B{x}`;
  const cut = driverCut(text);
  assert.ok(cut.endsWith('�') && cut.length < 64 * 1024 && Buffer.byteLength(cut, 'utf8') >= 64 * 1024);
  assert.ok(!cut.includes('mutation'), 'the mutation is past the cut');
  assert.equal(kind(cut, DOC), 'unknown');
});

// ---- isPersistedOnly / isStrictQuery ----

test('isPersistedOnly: a persistedQuery extension without a string query', () => {
  const ext = { persistedQuery: { version: 1, sha256Hash: 'x' } };
  assert.equal(isPersistedOnly(j({ extensions: ext })), true);
  assert.equal(isPersistedOnly(j({ query: 5, extensions: ext })), true);
  assert.equal(isPersistedOnly(j([{ query: 'query{a}' }, { extensions: ext }])), true);
  assert.equal(isPersistedOnly(j({ query: 'query{a}', extensions: ext })), false, 'the document is in the body');
  assert.equal(isPersistedOnly(j({ query: 'query{a}' })), false);
  assert.equal(isPersistedOnly(j({ extensions: { other: 1 } })), false);
  assert.equal(isPersistedOnly(j([])), false);
  assert.equal(isPersistedOnly(j('x')), false);
  assert.equal(isPersistedOnly('{"extensions":{"persistedQuery":'), false);
  assert.equal(isPersistedOnly('query { a }'), false);
  assert.equal(isPersistedOnly(null), false);
});

test('isStrictQuery: accepts only a POST query with a selection set in a known content type', () => {
  const q = j({ query: 'query{a}' });
  assert.equal(isStrictQuery('POST', q, JSON_CT), true);
  assert.equal(isStrictQuery('post', q, 'Application/JSON; charset=utf-8'), true);
  assert.equal(isStrictQuery('POST', j({ query: '{a}' }), JSON_CT), true);
  assert.equal(isStrictQuery('POST', '{ a }', 'application/graphql'), true);
  assert.equal(isStrictQuery('POST', '# c\nquery Q { a }', 'application/graphql; charset=utf-8'), true);
  assert.equal(isStrictQuery('POST', j([{ query: 'query{a}' }, { query: '{b}' }]), JSON_CT), true);
  assert.equal(isStrictQuery('GET', q, JSON_CT), false);
  assert.equal(isStrictQuery('DELETE', q, JSON_CT), false);
  assert.equal(isStrictQuery('POST', q, 'text/plain'), false);
  assert.equal(isStrictQuery('POST', q, null), false);
  assert.equal(isStrictQuery('POST', q, 'application/x-www-form-urlencoded'), false);
  assert.equal(isStrictQuery('POST', null, JSON_CT), false);
});

test('isStrictQuery: a query without a selection set, a mutation, a subscription, a batch with one bad item, or garbage is rejected', () => {
  assert.equal(isStrictQuery('POST', j({ query: 'query builder' }), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j({ query: 'query Q($a: Int)' }), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j({ query: 'query Q # {\n' }), JSON_CT), false, 'a brace inside a comment does not count');
  assert.equal(isStrictQuery('POST', 'query Q # {\n', 'application/graphql'), false);
  assert.equal(isStrictQuery('POST', j({ query: 'mutation{a}' }), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j({ query: 'subscription{a}' }), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j([{ query: 'query{a}' }, { query: 'mutation{b}' }]), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j([{ query: 'query{a}' }, { query: 'query builder' }]), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j([{ query: 'query{a}' }, { x: 1 }]), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j({ query: 1 }), JSON_CT), false);
  assert.equal(isStrictQuery('POST', '{"query":"query{', JSON_CT), false);
  assert.equal(isStrictQuery('POST', j({ extensions: { persistedQuery: { sha256Hash: 'x' } } }), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j({ a: 1 }), JSON_CT), false);
  assert.equal(isStrictQuery('POST', 'a=1', JSON_CT), false);
});

test('isStrictQuery: an optional url makes a query parameter count too', () => {
  const q = j({ query: 'query{a}' });
  assert.equal(isStrictQuery('POST', q, JSON_CT, 'http://localhost/graphql'), true);
  assert.equal(isStrictQuery('POST', q, JSON_CT, 'http://localhost/graphql?query=query%7Ba%7D'), false, 'a url query parameter is ambiguous, so it fails closed');
  assert.equal(isStrictQuery('POST', q, JSON_CT, 'http://localhost/graphql?query=mutation%7Ba%7D'), false);
});

test('isStrictQuery: a repeated query key is rejected, however it is written', () => {
  assert.equal(isStrictQuery('POST', '{"query":"mutation{b}","query":"query{a}"}', JSON_CT), false);
  assert.equal(isStrictQuery('POST', '{"query":"query{a}","query":"query{a}"}', JSON_CT), false);
  assert.equal(isStrictQuery('POST', '{"query":"mutation{b}","quer\\u0079":"query{a}"}', JSON_CT), false);
  assert.equal(isStrictQuery('POST', '{"query":"query{a}","Query":"mutation{b}"}', JSON_CT), false);
  assert.equal(isStrictQuery('POST', '[{"query":"query{a}"},{"query":"query{b}","query":"query{c}"}]', JSON_CT), false);
  assert.equal(isStrictQuery('POST', '{"query":"query{a}","variables":{"query":1}}', JSON_CT), true, 'a nested object is not an operation');
  assert.equal(isStrictQuery('POST', '[{"query":"query{a}"},{"query":"query{b}"}]', JSON_CT), true, 'one key per operation is fine');
  assert.equal(isStrictQuery('POST', '{"query":"query{a(s: \\"query\\":)}"}', JSON_CT), true, 'text inside a string is not a key');
});

test('isStrictQuery: a url-side query parameter in any separator style is rejected', () => {
  const q = j({ query: 'query{a}' });
  assert.equal(isStrictQuery('POST', q, JSON_CT, 'http://localhost/graphql?x=1;query=mutation%7Bb%7D'), false);
  assert.equal(isStrictQuery('POST', q, JSON_CT, 'http://localhost/graphql?x=1;QUERY=query%7Ba%7D'), false);
  assert.equal(isStrictQuery('POST', q, JSON_CT, 'http://localhost/graphql?x=1&query=query%7Ba%7D'), false);
  assert.equal(isStrictQuery('POST', q, JSON_CT, 'http://localhost/graphql?x=1&notquery=1'), true);
});

test('isStrictQuery: an operation object may only carry the standard keys', () => {
  assert.equal(isStrictQuery('POST', j({ query: '{a}', variables: { a: 1 }, operationName: 'X', extensions: { tracing: true } }), JSON_CT), true);
  assert.equal(isStrictQuery('POST', j({ query: '{status: open}', name: 'x' }), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j({ query: '{a}', extra: 1 }), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j([{ query: '{a}' }, { query: '{b}', name: 'x' }]), JSON_CT), false);
  assert.equal(isStrictQuery('POST', j({ query: '{a}', extensions: { persistedQuery: { sha256Hash: 'x' } } }), JSON_CT), false);
});

test('isMutationLikeUrl: a mutation, or an unreadable query parameter that mentions one, in any separator style', () => {
  const u = (q: string): string => `http://localhost/graphql${q}`;
  assert.equal(isMutationLikeUrl(u('?query=mutation%7Ba%7D')), true);
  assert.equal(isMutationLikeUrl(u('?query=%0Bmutation%7Ba%7D')), true, 'vertical tab');
  assert.equal(isMutationLikeUrl(u('?query=%0Cmutation%7Ba%7D')), true, 'form feed');
  assert.equal(isMutationLikeUrl(u('?query=%C2%A0mutation%7Ba%7D')), true, 'no-break space');
  assert.equal(isMutationLikeUrl(u('?x=1;query=mutation%7Ba%7D')), true);
  assert.equal(isMutationLikeUrl(u('?x=1;QUERY=%0Bmutation%7Ba%7D')), true);
  assert.equal(isMutationLikeUrl(u('?query=query%7Ba%7D')), false);
  assert.equal(isMutationLikeUrl(u('?query=query%7Ba%7D&note=mutation')), false);
  assert.equal(isMutationLikeUrl(u('?q=mutation')), false);
  assert.equal(isMutationLikeUrl(u('')), false);
  assert.equal(isMutationLikeUrl(u('?query=%0Bmutational%7Ba%7D')), false, 'a longer word is not the keyword');
});
