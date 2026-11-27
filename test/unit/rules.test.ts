import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRulesResolver, groupOf, hostListed, matchEndpoint, matchRule, normalizeHost, parseEndpoint, parseRules } from '../../src/kernel/rules.ts';

type Io = NonNullable<Parameters<typeof createRulesResolver>[1]>;

test('normalizeHost lowercases, drops the port and one trailing dot, applies punycode', () => {
  assert.equal(normalizeHost('App.Example.COM.'), 'app.example.com');
  assert.equal(normalizeHost('app.example.com:8443'), 'app.example.com');
  assert.equal(normalizeHost('例子.example.com'), 'xn--fsqu00a.example.com');
  assert.equal(normalizeHost('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeHost('[::1]'), '[::1]');
  assert.equal(normalizeHost('[::1]:8080'), '[::1]');
});

test('normalizeHost folds an IPv4-mapped IPv6 literal to the dotted IPv4 and leaves other IPv6 alone', () => {
  assert.equal(normalizeHost('[::ffff:127.0.0.1]'), '127.0.0.1');
  assert.equal(normalizeHost('[::ffff:7f00:1]'), '127.0.0.1');
  assert.equal(normalizeHost('[::FFFF:C0A8:101]:8080'), '192.168.1.1');
  assert.equal(new URL('http://[::ffff:127.0.0.1]/').hostname, '[::ffff:7f00:1]');   // 浏览器给出的就是这种写法
  assert.equal(normalizeHost('[::1]'), '[::1]');
  assert.equal(normalizeHost('[2001:db8::1]'), '[2001:db8::1]');
  assert.equal(normalizeHost('[::ffff:1:2:3]'), '[::ffff:1:2:3]');
  const r = parseRules('{"version":1,"rules":[{"match":"127.0.0.1","mode":"readonly"}],"loginHosts":["[::ffff:10.0.0.1]"]}');
  assert.equal(matchRule(r.rules, '[::ffff:7f00:1]')?.mode, 'readonly');
  assert.equal(hostListed(r.loginHosts, '[::ffff:a00:1]'), true);
});

test('normalizeHost rejects anything that is not a bare host', () => {
  for (const bad of ['evil.com/app.example.com', 'a@example.com', 'a b.com', '', 'a?b.com', 'a#b.com', 'a\\b.com', 'a\tb.com', 'a:b', '.', 'a..b.com', '.a.com']) {
    assert.throws(() => normalizeHost(bad), { code: 'usage' }, JSON.stringify(bad));
  }
});

test('parseRules and matchRule: exact beats wildcard, longer suffix beats shorter, boundaries are strict', () => {
  const r = parseRules(JSON.stringify({ version: 1, rules: [
    { match: '*.example.com', mode: 'readonly' }, { match: 'app.example.com', mode: 'default' }], loginHosts: ['sso.example.com'] }));
  assert.equal(matchRule(r.rules, 'app.example.com')?.mode, 'default');
  assert.equal(matchRule(r.rules, 'x.example.com')?.mode, 'readonly');
  assert.equal(matchRule(r.rules, 'X.Example.com.')?.mode, 'readonly');
  assert.equal(matchRule(r.rules, 'example.com'), null);
  assert.equal(matchRule(r.rules, 'evilexample.com'), null);
  assert.equal(matchRule(r.rules, 'example.com.evil.org'), null);
  assert.equal(matchRule(parseRules('{"version":1,"rules":[{"match":"*.example.com","mode":"readonly"},{"match":"*.b.example.com","mode":"default"}]}').rules, 'a.b.example.com')?.mode, 'default');
  assert.equal(matchRule(parseRules('{"version":1,"rules":[{"match":"*.b.example.com","mode":"default"},{"match":"*.example.com","mode":"readonly"}]}').rules, 'a.b.example.com')?.mode, 'default');
  assert.deepEqual(r.loginHosts, ['sso.example.com']);
});

test('IPs match exactly only, and a wildcard never matches an IP', () => {
  const r = parseRules('{"version":1,"rules":[{"match":"127.0.0.1","mode":"readonly"},{"match":"[::1]","mode":"readonly"},{"match":"*.com","mode":"readonly"}]}');
  assert.equal(matchRule(r.rules, '127.0.0.1:3000')?.mode, 'readonly');
  assert.equal(matchRule(r.rules, '[::1]')?.mode, 'readonly');
  assert.equal(matchRule(r.rules, '127.0.0.2'), null);
  assert.equal(matchRule(r.rules, '8.8.8.8'), null);
});

test('hostListed uses the same matching', () => {
  assert.equal(hostListed(['sso.example.com', '*.example.org'], 'SSO.example.com.'), true);
  assert.equal(hostListed(['sso.example.com', '*.example.org'], 'a.example.org'), true);
  assert.equal(hostListed(['sso.example.com', '*.example.org'], 'example.org'), false);
  assert.equal(hostListed(['sso.example.com'], 'evilsso.example.com'), false);
  assert.equal(hostListed([], 'a.example.com'), false);
});

test('invalid patterns and files are config errors that do not echo the value', () => {
  for (const bad of ['*', '*.', '**.example.com', 'a.*.com', '*example.com', '*.127.0.0.1', '*.*.example.com', 'a b.com', '']) {
    assert.throws(() => parseRules(JSON.stringify({ version: 1, rules: [{ match: bad, mode: 'readonly' }] })), { code: 'usage' }, JSON.stringify(bad));
  }
  for (const bad of ['a.example.com:8443', '*.example.com:80', '[::1']) assert.throws(() => parseRules(JSON.stringify({ version: 1, rules: [{ match: bad, mode: 'readonly' }] })), { code: 'usage' }, bad);
  for (const bad of ['*', 'a.*.com']) assert.throws(() => parseRules(JSON.stringify({ version: 1, rules: [], loginHosts: [bad] })), { code: 'usage' });
  assert.throws(() => parseRules('{"version":1,"rules":[{"match":"a.example.com","mode":"deny"}]}'), /M3/);
  assert.throws(() => parseRules('{"version":1,"rules":[{"match":"a.example.com","mode":"bogus"}]}'), { code: 'usage' });
  assert.throws(() => parseRules('{"version":1,"rules":[{"match":"A.example.com","mode":"readonly"},{"match":"a.example.com.","mode":"default"}]}'), { code: 'usage' });
  assert.throws(() => parseRules('{"version":1,"rules":[],"loginHosts":["a.example.com","A.example.com."]}'), { code: 'usage' });
  assert.throws(() => parseRules('{"version":1,"rules":[{"match":"a.example.com","mode":"readonly","x":1}]}'), { code: 'usage' });
  assert.throws(() => parseRules('{"version":2,"rules":[]}'), { code: 'usage' });
  assert.throws(() => parseRules('{"rules":[]}'), { code: 'usage' });
  assert.throws(() => parseRules('{"version":1,"rules":[],"extra":1}'), { code: 'usage' });
  assert.throws(() => parseRules('{"version":1,"rules":{}}'), { code: 'usage' });
  assert.throws(() => parseRules('{"version":1,"rules":null}'), { code: 'usage', message: /rules must be an array/ });
  assert.throws(() => parseRules('{"version":1,"rules":[],"loginHosts":null}'), { code: 'usage', message: /loginHosts must be an array/ });
  assert.deepEqual(parseRules('{"version":1}'), { rules: [], loginHosts: [], groups: [] });   // 键不写才是空
  assert.throws(() => parseRules('[]'), { code: 'usage' });
  assert.throws(() => parseRules('not json'), { code: 'usage' });
  const secret = 'secret-host-name.example.com';
  try { parseRules(JSON.stringify({ version: 1, rules: [{ match: secret + '/x', mode: 'readonly' }] })); assert.fail('should throw'); } catch (e) {
    assert.ok(!(e as Error).message.includes('secret-host-name'));
  }
  try { parseRules('{"version":1,"secret-key-name":1}'); assert.fail('should throw'); } catch (e) { assert.equal((e as { code: string }).code, 'usage'); }
});

test('parseRules enforces the size limits', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ match: `h${i}.example.com`, mode: 'readonly' }));
  assert.equal(parseRules(JSON.stringify({ version: 1, rules: many(200) })).rules.length, 200);
  assert.throws(() => parseRules(JSON.stringify({ version: 1, rules: many(201) })), { code: 'usage' });
  const logins = (n: number) => Array.from({ length: n }, (_, i) => `l${i}.example.com`);
  assert.equal(parseRules(JSON.stringify({ version: 1, rules: [], loginHosts: logins(50) })).loginHosts.length, 50);
  assert.throws(() => parseRules(JSON.stringify({ version: 1, rules: [], loginHosts: logins(51) })), { code: 'usage' });
});

function fakeIo(initial: string | null) {
  const f = { text: initial, isFile: true, size: undefined as number | undefined, statCalls: 0, readCalls: 0, readThrows: false };
  const io: Io = {
    stat: () => { f.statCalls++; return f.text === null ? null : { isFile: f.isFile, size: f.size ?? Buffer.byteLength(f.text) }; },
    read: () => { f.readCalls++; if (f.readThrows) throw new Error('EACCES'); return f.text ?? ''; },
  };
  return { f, io };
}
const good = JSON.stringify({ version: 1, rules: [{ match: '*.example.com', mode: 'readonly' }, { match: 'app.example.com', mode: 'default' }], loginHosts: ['sso.example.com'] });

test('resolver: no file means no rules', () => {
  const { io } = fakeIo(null);
  const m = createRulesResolver('/x/rules.json', io);
  assert.equal(m.resolve('anything.example.com'), 'default');
  assert.equal(m.ruleFor('anything.example.com'), null);
  assert.equal(m.isLoginHost('sso.example.com', 'default'), false);
  assert.deepEqual(m.state(), { count: 0, hash: null, error: null });
});

test('resolver: a good file takes effect on refresh, not before', () => {
  const { f, io } = fakeIo(null);
  const m = createRulesResolver('/x/rules.json', io);
  f.text = good;
  assert.equal(m.resolve('x.example.com'), 'default');  // resolve never touches the file
  m.refresh();
  assert.equal(m.resolve('x.example.com'), 'readonly');
  assert.equal(m.resolve('X.example.com.'), 'readonly');
  assert.equal(m.resolve('app.example.com.'), 'default');
  assert.equal(m.ruleFor('x.example.com'), 'readonly');
  assert.equal(m.ruleFor('app.example.com'), 'default');
  assert.equal(m.ruleFor('other.example.org'), null);
  assert.equal(m.isLoginHost('SSO.example.com.', 'default'), true);
  assert.equal(m.isLoginHost('x.example.com', 'default'), false);
  const s = m.state();
  assert.equal(s.count, 2); assert.equal(s.error, null);
  assert.match(s.hash ?? '', /^sha256:[0-9a-f]{16}$/);
});

test('resolver: loads at construction', () => {
  const { io } = fakeIo(good);
  const m = createRulesResolver('/x/rules.json', io);
  assert.equal(m.resolve('x.example.com'), 'readonly');
  assert.equal(m.state().count, 2);
});

test('resolver: an unchanged file keeps the same hash; a same-size edit is noticed', () => {
  const { f, io } = fakeIo(good);
  const m = createRulesResolver('/x/rules.json', io);
  const h1 = m.state().hash;
  m.refresh();
  assert.equal(m.state().hash, h1);
  f.text = good.replace('"readonly"', '"default" ');   // 字节数不变
  assert.equal(Buffer.byteLength(f.text), Buffer.byteLength(good));
  m.refresh();
  assert.notEqual(m.state().hash, h1);
  assert.equal(m.resolve('x.example.com'), 'default');
});

test('resolver: a broken file keeps the last good rules and reports the error; a fix clears it', () => {
  const { f, io } = fakeIo(good);
  const m = createRulesResolver('/x/rules.json', io);
  const h1 = m.state().hash;
  f.text = '{"version":1,"rules":[{"match":"*","mode":"readonly"}]}';
  m.refresh();
  assert.equal(m.resolve('x.example.com'), 'readonly');
  assert.equal(m.resolve('app.example.com'), 'default');
  assert.deepEqual({ ...m.state(), error: m.state().error === null ? null : 'set' }, { count: 2, hash: h1, error: 'set' });
  f.text = good;   // 改回原内容：错误清掉
  m.refresh();
  assert.deepEqual(m.state(), { count: 2, hash: h1, error: null });
});

test('resolver: a file broken from the start means no rules and an error', () => {
  const { io } = fakeIo('nope');
  const m = createRulesResolver('/x/rules.json', io);
  assert.equal(m.state().count, 0); assert.equal(m.state().hash, null); assert.notEqual(m.state().error, null);
  assert.equal(m.resolve('x.example.com'), 'default');
});

test('resolver: deleting the file goes back to no rules', () => {
  const { f, io } = fakeIo(good);
  const m = createRulesResolver('/x/rules.json', io);
  f.text = null;
  m.refresh();
  assert.deepEqual(m.state(), { count: 0, hash: null, error: null });
  assert.equal(m.resolve('x.example.com'), 'default');
});

test('resolver: not a regular file, too large, or unreadable is an error and keeps the old rules', () => {
  const { f, io } = fakeIo(good);
  const m = createRulesResolver('/x/rules.json', io);
  const reads = f.readCalls;
  f.isFile = false; m.refresh();
  assert.notEqual(m.state().error, null); assert.equal(f.readCalls, reads);
  assert.equal(m.resolve('x.example.com'), 'readonly');
  f.isFile = true; f.size = 256 * 1024 + 1; m.refresh();
  assert.notEqual(m.state().error, null); assert.equal(f.readCalls, reads);
  f.size = undefined; m.refresh();
  assert.equal(m.state().error, null);
  f.text = good + ' '; f.readThrows = true; m.refresh();
  assert.notEqual(m.state().error, null);
  assert.equal(m.state().count, 2);
});

test('resolver: a file that grows past the limit between stat and read is rejected', () => {
  const { f, io } = fakeIo(good);
  const m = createRulesResolver('/x/rules.json', io);
  f.text = good + ' '.repeat(256 * 1024); f.size = 10; m.refresh();
  assert.notEqual(m.state().error, null);
});

test('resolver: an invalid host fails closed to readonly in resolve, and is not a login host', () => {
  const m = createRulesResolver('/x/rules.json', fakeIo(null).io);
  assert.equal(m.resolve('a b'), 'readonly');
  assert.equal(m.resolve(''), 'readonly');
  assert.equal(m.resolve('evil.com/x'), 'readonly');
  assert.equal(m.ruleFor('a b'), null);
  assert.equal(m.isLoginHost('a b', 'default'), false);
});

// ---- 域名组（M2b） ----

const HASH = 'a'.repeat(64);
const GROUP_FILE = {
  version: 1,
  rules: [{ match: '*.example.com', mode: 'readonly' }],
  loginHosts: ['sso.example.org'],
  groups: [{
    name: 'admin',
    hosts: ['admin.example.com', 'api.example.com'],
    loginHosts: ['sso.example.org'],
    readPosts: [{ method: 'POST', url: 'https://api.example.com/v1/search' }],
    persistedQueries: [{ url: 'https://api.example.com/graphql', hashes: [HASH] }],
    logout: [{ url: 'https://admin.example.com/logout' }],
    identity: { selector: '[data-testid=tenant-name]', expect: 'Test Tenant' },
  }],
};
type Obj = Record<string, unknown>;
const withGroups = (...groups: Obj[]): string => JSON.stringify({ version: 1, rules: [], loginHosts: [], groups });
const grp = (over: Obj = {}): Obj => ({ name: 'a', hosts: ['a.example.com'], ...over });

describe('groups', () => {
  test('parses a group and finds it by host', () => {
    const r = parseRules(JSON.stringify(GROUP_FILE));
    const g = groupOf(r, 'admin.example.com');
    assert.equal(g.name, 'admin');
    assert.deepEqual(g.hosts, ['admin.example.com', 'api.example.com']);
    assert.deepEqual(g.readPosts, [{ method: 'POST', origin: 'https://api.example.com', path: ['v1', 'search'] }]);
    assert.deepEqual(g.persistedQueries, [{ endpoint: { method: 'POST', origin: 'https://api.example.com', path: ['graphql'] }, hashes: [HASH] }]);
    assert.deepEqual(g.logout, [{ method: '*', origin: 'https://admin.example.com', path: ['logout'] }]);
    assert.deepEqual(g.identity, { selector: '[data-testid=tenant-name]', expect: 'Test Tenant' });
    assert.equal(groupOf(r, 'API.example.com.').name, 'admin');
    const d = groupOf(r, 'other.example.com');
    assert.equal(d.name, 'default');
    assert.deepEqual(d.loginHosts, ['sso.example.org']);
    assert.deepEqual([d.hosts, d.readPosts, d.persistedQueries, d.logout, d.identity], [[], [], [], [], null]);
    assert.equal(groupOf(r, 'a b').name, 'default');   // 主机不合格：default 组
    assert.deepEqual(parseRules('{"version":1}').groups, []);
  });

  test('rejects bad groups', () => {
    const bad = (text: string, re?: RegExp): void => { assert.throws(() => parseRules(text), re === undefined ? { code: 'usage' } : { code: 'usage', message: re }, text.slice(0, 120)); };
    bad(withGroups(grp({ name: 'Default' })));
    bad(withGroups(grp({ name: 'default' })), /reserved/);
    bad(withGroups(grp({ name: 'Admin' })));
    bad(withGroups(grp({ name: '' })));
    bad(withGroups(grp({ name: 'a'.repeat(33) })));
    bad(withGroups(grp({ name: 'a b' })));
    bad(withGroups(grp({ name: 'admin' }), grp({ name: 'ADMIN', hosts: ['b.example.com'] })));   // 大写一律拒
    bad(withGroups(grp({ name: 'admin' }), grp({ name: 'admin', hosts: ['b.example.com'] })), /repeats an earlier group/);
    bad(withGroups(grp({ name: 'x' }), grp({ name: 'y' })), /also in another group/);                // 同一 hosts 写法在两个组
    bad(withGroups(grp({ name: 'x', hosts: ['*.example.com'] }), grp({ name: 'y', hosts: ['*.EXAMPLE.com.'] })), /also in another group/);
    bad(withGroups(grp({ name: 'x' }), grp({ name: 'y', hosts: ['b.example.com'], loginHosts: ['a.example.com'] })), /another group's hosts/);
    bad(withGroups(grp({ name: 'x', hosts: ['a.example.com'] }), grp({ name: 'y', hosts: ['b.example.com'], loginHosts: ['*.example.com'] })), /another group's hosts/);
    bad(withGroups(grp({ name: 'x', hosts: ['*.example.org'] }), grp({ name: 'y', hosts: ['b.example.com'], loginHosts: ['sso.example.org'] })), /another group's hosts/);
    bad(withGroups(grp({ name: 'x', hosts: ['a.example.com'] }), grp({ name: 'y', hosts: ['b.example.com'], loginHosts: ['a.example.com'] })), /host of another group/);   // 精确写法落在别组
    bad(withGroups(grp({ readPosts: [{ method: 'POST', url: 'https://other.example.net/x' }] })), /host must be in this group/);
    bad(withGroups(grp({ logout: [{ url: 'https://other.example.net/logout' }] })), /host must be in this group/);
    bad(withGroups(grp({ persistedQueries: [{ url: 'https://other.example.net/g', hashes: [HASH] }] })), /host must be in this group/);
    bad(withGroups(grp({ hosts: [] })), /must not be empty/);
    bad(withGroups({ name: 'a' }));
    bad(JSON.stringify({ version: 1, groups: Array.from({ length: 21 }, (_, i) => grp({ name: `g${i}`, hosts: [`h${i}.example.com`] })) }), /at most 20/);
    bad(withGroups(grp({ hosts: Array.from({ length: 51 }, (_, i) => `h${i}.example.com`) })));
    bad(withGroups(grp({ loginHosts: Array.from({ length: 51 }, (_, i) => `l${i}.example.org`) })));
    bad(withGroups(grp({ readPosts: Array.from({ length: 51 }, () => ({ method: 'POST', url: 'https://a.example.com/x' })) })));
    bad(withGroups(grp({ logout: Array.from({ length: 51 }, () => ({ url: 'https://a.example.com/x' })) })));
    bad(withGroups(grp({ persistedQueries: Array.from({ length: 21 }, (_, i) => ({ url: `https://a.example.com/g${i}`, hashes: [HASH] })) })), /at most 20/);
    bad(withGroups(grp({ persistedQueries: [
      { url: 'https://a.example.com/g1', hashes: Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, '0')) },
      { url: 'https://a.example.com/g2', hashes: Array.from({ length: 100 }, (_, i) => (i + 1000).toString(16).padStart(64, '0')) }] })), /at most 200 hashes/);
    bad(withGroups(grp({ persistedQueries: [{ url: 'https://a.example.com/g', hashes: [] }] })));
    bad(withGroups(grp({ persistedQueries: [{ url: 'https://a.example.com/g', hashes: ['A'.repeat(64)] }] })));
    bad(withGroups(grp({ persistedQueries: [{ url: 'https://a.example.com/g', hashes: ['abc'] }] })));
    bad(withGroups(grp({ persistedQueries: [{ url: 'https://a.example.com/g', hashes: [HASH, HASH] }] })));
    bad(withGroups(grp({ extra: 1 })), /unexpected key/);
    bad(withGroups(grp({ persistedQueries: [{ url: 'https://a.example.com/g', hashes: [HASH], method: 'GET' }] })), /unexpected key/);
    bad(withGroups(grp({ readPosts: [{ method: 'GET', url: 'https://a.example.com/x' }] })));
    bad(withGroups(grp({ readPosts: [{ url: 'https://a.example.com/x' }] })), /method is required/);
    bad('{"version":1,"groups":{}}', /groups must be an array/);
    bad(withGroups(grp({ identity: null })));
    // 合法的边界：每个上限刚好
    parseRules(JSON.stringify({ version: 1, groups: Array.from({ length: 20 }, (_, i) => grp({ name: `g${i}`, hosts: [`h${i}.example.com`] })) }));
    parseRules(withGroups(grp({ hosts: Array.from({ length: 50 }, (_, i) => `h${i}.example.com`), logout: Array.from({ length: 50 }, () => ({ url: 'https://h1.example.com/x' })) })));
  });

  test('an exact login host inside its own more specific group is fine even under another group\'s wildcard', () => {
    const r = parseRules(withGroups({ name: 'wide', hosts: ['*.example.com'] }, { name: 'sso', hosts: ['sso.example.com'], loginHosts: ['sso.example.com'] }));
    assert.equal(groupOf(r, 'sso.example.com').name, 'sso');
    assert.deepEqual(groupOf(r, 'sso.example.com').loginHosts, ['sso.example.com']);
    // 反过来：通配组把别组的精确主机当登录主机，仍然拒
    assert.throws(() => parseRules(withGroups({ name: 'wide', hosts: ['*.example.com'], loginHosts: ['sso.example.com'] }, { name: 'sso', hosts: ['sso.example.com'] })), { code: 'usage' });
  });

  test('two groups may share a login host that is in no group', () => {
    const r = parseRules(withGroups(grp({ name: 'x', loginHosts: ['sso.example.org'] }), grp({ name: 'y', hosts: ['b.example.com'], loginHosts: ['sso.example.org'] })));
    assert.equal(r.groups.length, 2);
  });

  test('endpoint patterns', () => {
    const ok = (u: string, m: Parameters<typeof parseEndpoint>[2]['methods'] = ['POST']) => parseEndpoint({ method: 'POST', url: u }, 'e', { methods: m });
    for (const u of ['https://a.example.com/x?y=1', 'https://a.example.com/x#f', 'https://u:p@a.example.com/x', 'https://u@a.example.com/x', 'ftp://a.example.com/x',
      'https://a.example.com/x*', 'https://a.example.com/*x/y', 'https://a.example.com/./x', 'https://a.example.com/../x', 'https://a.example.com/a/%2e%2E/x',
      'https://a.example.com/a%2Fb', 'https://a.example.com//x', '/v1/x', 'a.example.com/x', 'https://a.example.com/x y', 'https://a.example.com\\x', 'https://a.example.com/路径', '', 'https://']) {
      assert.throws(() => ok(u), { code: 'usage' }, u);
    }
    assert.throws(() => parseEndpoint({ method: 'GET', url: 'https://a.example.com/x' }, 'e', { methods: ['POST', 'PUT', 'PATCH', 'DELETE'] }), { code: 'usage' });
    assert.throws(() => parseEndpoint({ method: 'post', url: 'https://a.example.com/x' }, 'e', { methods: ['POST'] }), { code: 'usage' });
    assert.throws(() => parseEndpoint({ method: 'PUT', url: 'https://a.example.com/x' }, 'e', { methods: ['POST'] }), { code: 'usage' });
    assert.throws(() => parseEndpoint({ method: 'GET', url: 'https://a.example.com/x' }, 'e', { methods: 'any' }), { code: 'usage' });
    assert.throws(() => parseEndpoint({ url: 'https://a.example.com/x' }, 'e', { methods: ['POST'] }), { code: 'usage' });
    assert.throws(() => parseEndpoint({ method: 'POST', url: 'https://a.example.com/x', extra: 1 }, 'e', { methods: ['POST'] }), { code: 'usage' });
    assert.throws(() => parseEndpoint('https://a.example.com/x', 'e', { methods: 'any' }), { code: 'usage' });
    assert.deepEqual(parseEndpoint({ url: 'https://A.example.com:8443/logout/' }, 'e', { methods: 'any' }), { method: '*', origin: 'https://a.example.com:8443', path: ['logout', ''] });
    assert.deepEqual(ok('https://a.example.com'), { method: 'POST', origin: 'https://a.example.com', path: [''] });
    assert.deepEqual(ok('http://a.example.com:80/v1/*/search'), { method: 'POST', origin: 'http://a.example.com', path: ['v1', '*', 'search'] });

    const e = ok('https://api.example.com/v1/*/search');
    const hit = (u: string, m = 'POST'): boolean => matchEndpoint(e, m, u);
    assert.equal(hit('https://api.example.com/v1/a/search'), true);
    assert.equal(hit('https://API.example.com:443/v1/a/search'), true);   // 默认端口等价
    assert.equal(hit('https://api.example.com/v1/a/search', 'post'), true);
    assert.equal(hit('https://api.example.com/v1/a/search', 'PUT'), false);
    for (const u of ['https://api.example.com/v1/a/b/search', 'https://api.example.com/v1//search', 'https://api.example.com/v1/a%2Fb/search',
      'https://api.example.com/v1/a%2fb/search', 'https://api.example.com/v1/a%5Cb/search', 'https://api.example.com/v1/../search', 'https://api.example.com/v1/%2e%2e/search',
      'https://api.example.com/v1/%2E/search', 'https://api.example.com/v1/./search',
      'http://api.example.com/v1/a/search', 'https://api.example.com:8443/v1/a/search', 'https://api.example.com/v1/a/search?q=1',
      'https://api.example.com/v1/a/search?_method=DELETE', 'https://api.example.com/v1/a/search?', 'https://api.example.com/v1/a/search#x',
      'https://api.example.com/v1/a/search/', 'https://api.example.com/v1/a', 'https://other.example.com/v1/a/search', 'https://api.example.com.example.org/v1/a/search',
      'https://u:p@api.example.com/v1/a/search', 'https://api.example.com\\v1/a/search', 'https://api.example.com/v1/a/search ', 'not a url', '']) {
      assert.equal(hit(u), false, u);
    }
    assert.equal(hit('https://api.example.com/v1/a.b/search'), true);   // 普通的点放行，只有 `.`、`..` 和编码点不行
    // `*` 段是白名单：路径参数、编码、双重编码都不行
    for (const u of ['https://api.example.com/v1/..;/search', 'https://api.example.com/v1/.;/search', 'https://api.example.com/v1/a;x=1/search',
      'https://api.example.com/v1/%3B/search', 'https://api.example.com/v1/%3b/search', 'https://api.example.com/v1/%252e%252e/search',
      'https://api.example.com/v1/.hidden/search', 'https://api.example.com/v1/a%20b/search', 'https://api.example.com/v1/a,b/search']) {
      assert.equal(hit(u), false, u);
    }
    for (const u of ['https://api.example.com/v1/a/search', 'https://api.example.com/v1/A_b-c~1/search', 'https://api.example.com/v1/_x/search', 'https://api.example.com/v1/9/search']) {
      assert.equal(hit(u), true, u);
    }
    // 接口主机里不能有 `*`（永远不会匹配）
    for (const u of ['https://*.example.com/x', 'https://a.*/x', 'https://*/x']) assert.throws(() => ok(u), { code: 'usage' }, u);
    // 方法 '*'：任何方法
    const any = parseEndpoint({ url: 'https://a.example.com/logout' }, 'e', { methods: 'any' });
    assert.equal(matchEndpoint(any, 'GET', 'https://a.example.com/logout'), true);
    assert.equal(matchEndpoint(any, 'POST', 'https://a.example.com/logout?next=/'), false);
    assert.equal(matchEndpoint(any, 'GET', 'https://a.example.com/logout/x'), false);
    // 字面段区分大小写、不做百分号解码
    const lit = ok('https://a.example.com/v1/Search');
    assert.equal(matchEndpoint(lit, 'POST', 'https://a.example.com/v1/search'), false);
    assert.equal(matchEndpoint(lit, 'POST', 'https://a.example.com/v1/%53earch'), false);
    assert.equal(matchEndpoint(lit, 'POST', 'https://a.example.com/v1/Search'), true);
  });

  test('wildcard group host prefers the more specific group', () => {
    const r = parseRules(withGroups(
      { name: 'wide', hosts: ['*.example.com'] },
      { name: 'mid', hosts: ['*.b.example.com'] },
      { name: 'exact', hosts: ['a.b.example.com'] }));
    assert.equal(groupOf(r, 'x.example.com').name, 'wide');
    assert.equal(groupOf(r, 'x.b.example.com').name, 'mid');
    assert.equal(groupOf(r, 'y.x.b.example.com').name, 'mid');
    assert.equal(groupOf(r, 'a.b.example.com').name, 'exact');
    assert.equal(groupOf(r, 'example.com').name, 'default');
    assert.equal(groupOf(r, 'evilexample.com').name, 'default');
    const r2 = parseRules(withGroups({ name: 'mid', hosts: ['*.b.example.com'] }, { name: 'wide', hosts: ['*.example.com'] }));   // 与写的顺序无关
    assert.equal(groupOf(r2, 'x.b.example.com').name, 'mid');
  });

  test('identity selector shapes', () => {
    const sel = (selector: string, expect = 'T'): string => withGroups(grp({ identity: { selector, expect } }));
    for (const bad of ['e12', 'f1e3', ' e12 ', 'text=x', 'css=a', 'text =x', '(//div)[1]', '((//div))[1]', 'h1=x', '*=x', 'a+b=c', 'css:light=a', ' text=x', 'role=button[name="x"]', 'a >> b', 'role:button', 'getByRole("button")', 'getByText("x")',
      'internal:role=button', '//div', '../x', '"text"', "'text'", '', 'a'.repeat(301), 'a\nb']) {
      assert.throws(() => parseRules(sel(bad)), { code: 'usage' }, JSON.stringify(bad));
    }
    for (const good of ['[data-testid=tenant-name]', 'header .tenant', '#tenant', 'a:hover', 'div > span', 'e12x', 'a'.repeat(300)]) {
      assert.deepEqual(parseRules(sel(good)).groups[0]!.identity, { selector: good, expect: 'T' }, good);
    }
    assert.throws(() => parseRules(sel('#t', '')), { code: 'usage' });
    assert.throws(() => parseRules(sel('#t', 'x'.repeat(201))), { code: 'usage' });
    assert.throws(() => parseRules(sel('#t', 'a\nb')), { code: 'usage' });
    assert.throws(() => parseRules(withGroups(grp({ identity: { selector: '#t', expect: 'x', script: '1' } }))), { code: 'usage' });
    parseRules(sel('#t', 'x'.repeat(200)));
  });

  test('resolver: groups and isLoginHost are per group', () => {
    const io: Io = { stat: () => ({ isFile: true, size: 10 }), read: () => JSON.stringify(GROUP_FILE) };
    const m = createRulesResolver('/x/rules.json', io);
    assert.equal(m.groupOf('admin.example.com').name, 'admin');
    assert.equal(m.groupOf('other.example.com').name, 'default');
    assert.equal(m.group('admin')?.name, 'admin');
    assert.equal(m.group('default')?.name, 'default');
    assert.deepEqual(m.group('default')?.loginHosts, ['sso.example.org']);
    assert.equal(m.group('nope'), null);
    assert.equal(m.isLoginHost('sso.example.org', 'default'), true);
    assert.equal(m.isLoginHost('sso.example.org', 'admin'), true);
    assert.equal(m.isLoginHost('admin.example.com', 'admin'), false);   // 组的 hosts 不等于登录主机
    assert.equal(m.isLoginHost('sso.example.org', 'nope'), false);
    assert.equal(m.isLoginHost('a b', 'admin'), false);
  });
});
