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

// 回归：嵌套在别的参数值里的敏感参数、深层嵌套 JSON。
test('nested sensitive params inside another param value are replaced', () => {
  const v = 'V' + 'q7'.repeat(3);
  for (const out of [redactText(`see /login?next=/cb?token=${v}`), redactUrl(`http://localhost/login?next=/cb?access_token=${v}`),
    redactUrl(`http://localhost/#state=ok?id_token=${v}`), redactText(`/login?returnTo=http://localhost/cb?auth=${v}`)])
    assert.ok(!out.includes(v), out);
  assert.equal(redactText(`see /login?next=/cb?token=${v}`), 'see /login?next=/cb?token=[REDACTED]');
  assert.equal(redactText(`/x?token=ab(${v})&a=1`), '/x?token=[REDACTED]&a=1');
  assert.equal(redactText(`/x?auth={${v}}`), '/x?auth=[REDACTED]');
});

// 敏感参数的值里有 `?` 时，`?` 不结束值：值一直到 `&`、`#`、空白、`"`、`<`、`>` 或结尾。
test('a sensitive value runs past `?` to the next delimiter', () => {
  const v = 'V' + 'q7'.repeat(3);
  assert.equal(redactText(`/x?password=p?ss${v}`), '/x?password=[REDACTED]');
  assert.equal(redactText(`?token=?${v}`), '?token=[REDACTED]');
  assert.equal(redactText(`?token=a?pw=${v}&x=1`), '?token=[REDACTED]&x=1');
  // 嵌套：不敏感的值里再出现的 `?名字=` 仍单独判断
  assert.equal(redactText(`?next=/cb?token=${v}`), '?next=/cb?token=[REDACTED]');
  assert.equal(redactText(`?q=a?b&token=${v}`), '?q=a?b&token=[REDACTED]');
  assert.equal(redactText(`/x#id_token=a?${v}&state=1`), '/x#id_token=[REDACTED]&state=1');
  // 空值也换掉（失败关闭）
  assert.equal(redactText('?token='), '?token=[REDACTED]');
  assert.equal(redactText('?token=&a=1'), '?token=[REDACTED]&a=1');
  assert.equal(redactText('?token=?'), '?token=[REDACTED]');
  // 相邻的标记和标点：结束符之外的字符都算进值里，宁可多换
  assert.equal(redactText(`<a href="/x?token=${v}?y">go</a>`), '<a href="/x?token=[REDACTED]">go</a>');
  assert.equal(redactText(`see /x?token=${v}?**!… next`), 'see /x?token=[REDACTED] next');
  assert.equal(redactText(`(/x?token=${v}?) and '/y?pw=?${v}'`), "(/x?token=[REDACTED] and '/y?pw=[REDACTED]");
  assert.equal(redactText(`<p>/x?pw=${v}?</p>`), '<p>/x?pw=[REDACTED]</p>');
  assert.equal(redactText(`/x?token=a?b\t${v}`), `/x?token=[REDACTED]\t${v}`);
  // 很长的值和很多 `?`：结果对（扫描是线性的）
  assert.equal(redactText('?token=' + '?'.repeat(100_000)), '?token=[REDACTED]');
  assert.equal(redactText('?a=?'.repeat(20_000) + 'token=' + v), '?a=?'.repeat(20_000) + 'token=[REDACTED]');
});

test('deeply nested json never throws and never leaks', () => {
  for (const depth of [2000, 5000]) {
    const body = '['.repeat(depth) + '{"password":"p9"}' + ']'.repeat(depth);
    const out = redactBody(body, 'application/json')!;
    assert.ok(!out.includes('p9'));
    assert.doesNotThrow(() => redactDeep(JSON.parse(body)));
  }
  const deepObj = '{"a":'.repeat(3000) + '"' + 'f0'.repeat(4) + '"' + '}'.repeat(3000);
  assert.ok(!redactBody(deepObj, null)!.includes('f0f0f0f0'));
});
