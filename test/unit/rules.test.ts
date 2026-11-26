import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRulesResolver, hostListed, matchRule, normalizeHost, parseRules } from '../../src/kernel/rules.ts';

type Io = NonNullable<Parameters<typeof createRulesResolver>[1]>;

test('normalizeHost lowercases, drops the port and one trailing dot, applies punycode', () => {
  assert.equal(normalizeHost('App.Example.COM.'), 'app.example.com');
  assert.equal(normalizeHost('app.example.com:8443'), 'app.example.com');
  assert.equal(normalizeHost('例子.example.com'), 'xn--fsqu00a.example.com');
  assert.equal(normalizeHost('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeHost('[::1]'), '[::1]');
  assert.equal(normalizeHost('[::1]:8080'), '[::1]');
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
  assert.equal(m.isLoginHost('sso.example.com'), false);
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
  assert.equal(m.isLoginHost('SSO.example.com.'), true);
  assert.equal(m.isLoginHost('x.example.com'), false);
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
  assert.equal(m.isLoginHost('a b'), false);
});
