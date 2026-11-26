import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, isSensitiveKey, redactBody, redactDeep, redactText, redactUrl } from '../../src/shared/redact.ts';

// token 形态的串都在运行时拼，不写成字面量。
const jwt = 'eyJ' + 'a'.repeat(21) + '.' + 'b'.repeat(24) + '.' + 'c'.repeat(24);
const hex64 = 'ab12'.repeat(16);
const mixed42 = 'Ab1'.repeat(14);

test('token shapes are replaced', () => {
  assert.equal(redactText(`x ${jwt} y`), 'x [REDACTED] y');
  assert.equal(redactText(hex64), '[REDACTED]');
  assert.equal(redactText(`k: ${mixed42}`), 'k: [REDACTED]');
  assert.equal(redactText('Authorization: Bearer ' + 'k'.repeat(24)), 'Authorization: Bearer [REDACTED]');
});

test('ordinary identifiers survive', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';                       // 36 位 UUID
  const name40 = 'a' + 'b1-'.repeat(13);                                     // 40 位的会话名形态
  const selector = '[data-testid="order-list-row-action-button-primary-large-variant"]';
  for (const s of [uuid, name40, selector, 'order 1042 saved', 's-a41f00', '20261126-153000-s-a41f00', 'a=1'])
    assert.equal(redactText(s), s);
});

test('urls inside text, relative or absolute', () => {
  assert.equal(redactText('see /cb?code=1&auth=abc123 and http://localhost/x?sid=s9#id_token=zz9'),
    'see /cb?code=1&auth=[REDACTED] and http://localhost/x?sid=[REDACTED]#id_token=[REDACTED]');
  assert.ok(!redactText('http://user:pw9@example.com/a').includes('pw9'));
});

test('cookie strings', () => {
  assert.equal(redactText('Cookie: a=1; b=2'), 'Cookie: [REDACTED]');
  assert.equal(redactText('"theme=dark; sid=abc"'), '"theme=[REDACTED]; sid=[REDACTED]"');
});

test('redactUrl', () => {
  const r = redactUrl('http://localhost/a?access_token=abc123&page=2#state=ok&id_token=zz9');
  for (const gone of ['abc123', 'zz9']) assert.ok(!r.includes(gone));
  assert.ok(r.includes('page=2')); assert.ok(r.includes('state=ok'));
  assert.ok(!redactUrl('http://user:pw9@example.com/').includes('pw9'));
});

test('redactBody', () => {
  assert.deepEqual(JSON.parse(redactBody(`{"name":"n","password":"p1","nested":{"apiToken":"t1","note":"${jwt}"}}`, 'application/json')!),
    { name: 'n', password: '[REDACTED]', nested: { apiToken: '[REDACTED]', note: '[REDACTED]' } });
  const form = redactBody('user=u&pw=p2', 'application/x-www-form-urlencoded')!;
  assert.ok(form.includes('user=u')); assert.ok(!form.includes('p2'));
  const mp = '--b\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello\r\n--b\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nRAWDATA\r\n--b--';
  assert.equal(redactBody(mp, 'multipart/form-data; boundary=b'), '[multipart: title, file]');
  assert.ok(redactBody('x '.repeat(2500), 'text/plain')!.endsWith('…[truncated 5000]'));
  assert.equal(redactBody(null, null), null);
});

test('isSensitiveKey', () => {
  for (const k of ['password', 'Authorization', 'x-csrf-token', 'sessionId', 'sid', 'oauth_state', 'credentials', 'X-Amz-Signature', 'pw', 'auth'])
    assert.ok(isSensitiveKey(k), k);
  for (const k of ['author', 'authors', 'session', 'sessions', 'name', 'id', 'pageUrl', 'status', 'inside', 'selector'])
    assert.ok(!isSensitiveKey(k), k);
});

test('redactDeep: sensitive keys, extra keys, skip keys', () => {
  const input = { a: { cookie: 'c1', list: [{ Authorization: 'Bearer zzz' }], ok: 'fine', n: 3 }, tenantKey: 'k',
    name: 'a'.repeat(40), runDir: '/x/' + hex64, note: hex64, url: 'http://localhost/?token=abc123' };
  assert.deepEqual(redactDeep(input, { extraKeys: ['tenantKey'], skipKeys: ['name', 'runDir'] }),
    { a: { cookie: '[REDACTED]', list: [{ Authorization: '[REDACTED]' }], ok: 'fine', n: 3 }, tenantKey: '[REDACTED]',
      name: 'a'.repeat(40), runDir: '/x/' + hex64, note: '[REDACTED]', url: 'http://localhost/?token=[REDACTED]' });
  assert.equal(redactDeep(input).name, '[REDACTED]');     // 不给跳过键时照常脱敏
  assert.equal(input.a.cookie, 'c1');                      // 不改入参
  assert.equal(redactDeep({ password: 'p' }, { skipKeys: ['password'] }).password, '[REDACTED]');   // 敏感键优先于跳过键
});

// 以下是简报之外补的边界用例。

test('REDACTED constant', () => assert.equal(REDACTED, '[REDACTED]'));

test('kernel-shaped values survive redactText', () => {
  for (const s of ['/state/runs/session/20261126-153000-s-a41f00/shots/01.jpg', 'session', 'sessions: 2', 'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u',
    '#main > .list li:nth-child(2)', 'text=Order saved', 'http://localhost:4173/page?id=1&tab=2'])
    assert.equal(redactText(s), s);
});

test('redactText: more token and url shapes', () => {
  assert.equal(redactText('x-csrf: ' + 'f0'.repeat(16) + '.'), 'x-csrf: [REDACTED].');
  assert.equal(redactText(`a <b>${mixed42}</b>`), 'a <b>[REDACTED]</b>');
  assert.equal(redactText('/cb?acc%65ss_token=v1'), '/cb?acc%65ss_token=[REDACTED]');
  assert.equal(redactText('Set-Cookie: sid=v2; Path=/\nnext line'), 'Set-Cookie: [REDACTED]\nnext line');
  assert.ok(!redactText('git clone https://tok3n@example.com/r').includes('tok3n'));
  assert.equal(redactText('note: a=1; b=2'), 'note: a=1; b=2');      // 不是整行 cookie 形态（第一段名字里有空白）
});

test('redactText stays fast on adversarial input', () => {
  const inputs = ['eyJ'.repeat(20000), 'a'.repeat(60000) + '!', '?'.repeat(30000) + '=', '&a'.repeat(30000),
    '://'.repeat(20000), '://a:' + 'b:'.repeat(30000), 'Bearer '.repeat(10000), ('A1b-'.repeat(10) + '.').repeat(5000),
    'x=1; '.repeat(20000), ' '.repeat(60000) + 'x', 'a' + '\t'.repeat(60000) + 'b'];
  const start = performance.now();
  for (const s of inputs) redactText(s);
  redactBody('Content-Disposition: x; '.repeat(20000), 'multipart/form-data; boundary=b');
  assert.ok(performance.now() - start < 2000);
});

test('redactUrl: fragment-only, encoded names, unparseable, user name only', () => {
  assert.equal(redactUrl('http://localhost/cb#access_token=t9&type=x'), 'http://localhost/cb#access_token=[REDACTED]&type=x');
  assert.equal(redactUrl('http://localhost/?acc%65ss_token=t9'), 'http://localhost/?acc%65ss_token=[REDACTED]');
  assert.equal(redactUrl('/relative?token=t9&a=1'), '/relative?token=[REDACTED]&a=1');
  assert.ok(!redactUrl('https://tok3n@example.com/').includes('tok3n'));
  assert.equal(redactUrl('http://localhost/x?a=1&b=2'), 'http://localhost/x?a=1&b=2');
  assert.ok(!redactUrl(`http://localhost/x?state=${jwt}`).includes(jwt));
});

test('redactBody: sniffing, invalid json, quotes, truncation size', () => {
  assert.equal(redactBody('{"password":"p3"}', 'text/plain;charset=UTF-8'), '{"password":"[REDACTED]"}');
  assert.ok(!redactBody('password=p4&x=1', null)!.includes('p4'));
  assert.equal(redactBody('{"password": broken', 'application/json'), '{"password": broken');
  assert.equal(redactBody('[1,"ok"]', 'application/vnd.api+json'), '[1,"ok"]');
  assert.equal(redactBody('abc', 'text/plain', 2), 'ab…[truncated 3]');
  assert.equal(redactBody('', 'text/plain'), '');
});

test('redactDeep: __proto__ key and non-string leaves', () => {
  const parsed: unknown = JSON.parse('{"__proto__":{"token":"t"},"x":[null,true,1]}');
  const out = redactDeep(parsed) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(out, '__proto__')?.value, { token: '[REDACTED]' });
  assert.deepEqual(out['x'], [null, true, 1]);
  assert.equal(redactDeep('Bearer abc'), 'Bearer [REDACTED]');
  assert.equal(redactDeep({ API_KEY: 'k' }, { extraKeys: ['api_key'] }).API_KEY, '[REDACTED]');
  assert.equal(redactDeep({ myField: 'v' }, { extraKeys: ['MYFIELD'] }).myField, '[REDACTED]');   // extraKeys 不分大小写
});
