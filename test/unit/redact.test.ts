import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, isSensitiveKey, redactBody, redactDeep, redactSelector, redactText, redactUrl } from '../../src/shared/redact.ts';

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
  assert.equal(redactText('x-csrf: ' + 'f0'.repeat(16) + '.'), 'x-csrf: [REDACTED]');
  assert.equal(redactText(`a <b>${mixed42}</b>`), 'a <b>[REDACTED]</b>');
  assert.equal(redactText('/cb?acc%65ss_token=v1'), '/cb?acc%65ss_token=[REDACTED]');
  assert.equal(redactText('Set-Cookie: sid=v2; Path=/\nnext line'), 'Set-Cookie: [REDACTED]\nnext line');
  assert.ok(!redactText('git clone https://tok3n@example.com/r').includes('tok3n'));
  assert.equal(redactText('note: a=1; b=2'), 'note: a=1; b=2');      // 不是整行 cookie 形态（第一段名字里有空白）
});

test('redactText stays fast on adversarial input', () => {
  const inputs = ['eyJ'.repeat(20000), 'a'.repeat(60000) + '!', '?'.repeat(30000) + '=', '&a'.repeat(30000),
    '://'.repeat(20000), '://a:' + 'b:'.repeat(30000), 'Bearer '.repeat(10000), ('A1b-'.repeat(10) + '.').repeat(5000),
    'x=1; '.repeat(20000), ' '.repeat(60000) + 'x', 'a' + '\t'.repeat(60000) + 'b',
    'a@' + 'a.'.repeat(50000), 'a%40'.repeat(30000), '@'.repeat(60000), 'a.'.repeat(50000) + '@',
    '"' + 'a'.repeat(1e5), '"token":"' + '\\'.repeat(1e5), '"token":"' + 'a'.repeat(1e5), '"token":"'.repeat(30000),
    '"a" '.repeat(30000), '"a"' + ' '.repeat(1e5), '\\"token\\":\\"'.repeat(30000), '\\"token\\":\\"' + 'a'.repeat(1e5),
    '\\"token\\":\\"' + '\\"'.repeat(60000), '\\"token\\":\\"' + '\\\\\\"'.repeat(30000), 'a:'.repeat(30000), '-'.repeat(1e5) + ':', ('a-'.repeat(20) + ':\n').repeat(30000),
    ' password="'.repeat(30000), 'password="' + 'a'.repeat(1e5), " password='".repeat(30000), 'password="' + '\\'.repeat(1e5),
    ';a'.repeat(30000), ',a'.repeat(30000), '(a'.repeat(30000), '{a'.repeat(30000), '[a'.repeat(30000), '=a'.repeat(30000)];
  const start = performance.now();
  for (const s of inputs) redactText(s);
  redactBody('Content-Disposition: x; '.repeat(20000), 'multipart/form-data; boundary=b');
  redactBody('a=' + 'Ab1+'.repeat(30000), 'application/x-www-form-urlencoded');
  redactBody('a=Ab1%2B&'.repeat(30000), 'application/x-www-form-urlencoded');
  redactBody('a=%40&'.repeat(30000), 'application/x-www-form-urlencoded');
  redactBody(JSON.stringify({ x: 'A1b+'.repeat(30000), y: 'a@' + 'a.'.repeat(30000) }), 'application/json');
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

// 新规则的测试值都在运行时拼，不写成字面量。
const b64Std = 'Ab1+Cd2/'.repeat(5) + 'Ef3+';                              // 44 位，标准 base64 字符，含 + 和 /
const b64Enc = encodeURIComponent(b64Std);

test('e-mail addresses, plain and percent-encoded', () => {
  assert.equal(redactText('contact ann.lee+x@example.com now'), 'contact [REDACTED] now');
  assert.equal(redactText('a%40b.example.com'), '[REDACTED]');
  assert.equal(redactText('to=u%40example.com&x=1'), 'to=[REDACTED]&x=1');
  assert.equal(redactText('mail ann@example.com.'), 'mail [REDACTED].');
  for (const s of ['@types/node', 'lodash@4.17.21', 'version 1.65.1', 'author: Ann', 'user@host', 'a @ b.example.com'])
    assert.equal(redactText(s), s);
  assert.equal(redactText('http://usr7:pw9@example.com/a'), 'http://[REDACTED]@example.com/a');   // 用户名也不留
});

test('free-text secrets: name=value, json pairs, header lines', () => {
  assert.equal(redactText('password=hunter-x 和后文'), 'password=[REDACTED] 和后文');
  assert.equal(redactText('login failed (password=hunter-x) ok'), 'login failed (password=[REDACTED] ok');   // 值到空白才结束，多换掉一个 `)`
  assert.equal(redactText('note a=1; pwd=hunter-x b=2'), 'note a=1; pwd=[REDACTED] b=2');
  assert.equal(redactText('{"token":"v1","ok":1}'), '{"token":"[REDACTED]","ok":1}');
  assert.equal(redactText('\'"token" : "v\\"q"\' x'), '\'"token" : "[REDACTED]"\' x');
  assert.equal(redactText('{"a":"1","api_key":"k\\\\","b":"2"}'), '{"a":"1","api_key":"[REDACTED]","b":"2"}');
  assert.equal(redactText('{"author":"Ann","note":"x"}'), '{"author":"Ann","note":"x"}');
  assert.equal(redactText('X-Api-Key: v1'), 'X-Api-Key: [REDACTED]');
  assert.equal(redactText('  x-api-key:v1\nnext: ok'), '  x-api-key: [REDACTED]\nnext: ok');
  assert.equal(redactText('Authorization: Basic v1'), 'Authorization: Basic [REDACTED]');
  assert.equal(redactText('Authorization: Digest username="a", response="b"'), 'Authorization: [REDACTED]');
  assert.equal(redactText('Cookie: a=1; b=2'), 'Cookie: [REDACTED]');
  for (const s of ['author: Ann', 'Content-Type: application/json', 'note: a=1; b=2', 'Authors: Ann'])
    assert.equal(redactText(s), s);
});

test('json pairs fail closed when the closing quote is missing', () => {
  const out = redactText('{"token":"abc');
  assert.ok(!out.includes('abc'));
  assert.equal(out, '{"token":"[REDACTED]');
  assert.ok(!redactText('before {"token":"abc"x, "next":"y').includes('abc'));
  assert.equal(redactText('{"token":"v","b":"keep"}'), '{"token":"[REDACTED]","b":"keep"}');   // 找到了就从结束引号之后继续
});

test('json pairs in the doubly encoded shape', () => {
  const out = redactText('{\\"token\\":\\"v\\",\\"b\\":\\"keep\\"}');
  assert.ok(!out.includes('v\\"'));
  assert.equal(out, '{\\"token\\":\\"[REDACTED]\\",\\"b\\":\\"keep\\"}');
  assert.equal(redactText('{\\"token\\":\\"a\\\\\\"b\\",\\"c\\":1}'), '{\\"token\\":\\"[REDACTED]\\",\\"c\\":1}');
});

test('redactBody: form values are decoded before judging and never written back', () => {
  const out = redactBody(`ids=%5B%22u%40example.com%22%5D&state=${b64Enc}&n=1`, 'application/x-www-form-urlencoded');
  assert.equal(out, 'ids=[REDACTED]&state=[REDACTED]&n=1');
  assert.ok(!out!.includes('example.com'));
  assert.equal(redactBody('ids=u%40example.com', null), 'ids=[REDACTED]');
  assert.equal(redactBody('q=a+b&r=hello%20world', 'application/x-www-form-urlencoded'), 'q=a+b&r=hello%20world');
});

test('redactBody: whole-value tokens in unencoded, + containing and JSON shapes', () => {
  assert.equal(redactBody(`state=${b64Std}`, 'application/x-www-form-urlencoded'), 'state=[REDACTED]');
  assert.equal(redactBody(`state=${b64Std}=`, null), 'state=[REDACTED]');
  assert.equal(redactBody(JSON.stringify({ x: b64Std, k: 'v' }), 'application/json'), '{"x":"[REDACTED]","k":"v"}');
  assert.equal(redactUrl(`http://localhost/x?s=${b64Enc}&a=1`), 'http://localhost/x?s=[REDACTED]&a=1');
  assert.equal(redactDeep({ x: b64Std }).x, REDACTED);
});

test('whole-value token rule leaves paths and ordinary values alone', () => {
  const path = '/api/v2/Accounts/Settings/Profile2Overview';
  assert.equal(redactDeep({ p: path }).p, path);
  assert.equal(redactBody(`next=${path}`, 'application/x-www-form-urlencoded'), `next=${path}`);
  assert.equal(redactBody(`next=${encodeURIComponent(path)}`, 'application/x-www-form-urlencoded'), `next=${encodeURIComponent(path)}`);
  assert.equal(redactDeep({ p: '//cdn/Accounts/Settings/Profile2Overview/x' }).p, '//cdn/Accounts/Settings/Profile2Overview/x');
  assert.equal(redactDeep({ p: 'x/' + path }).p, 'x/' + path);                     // 含 // 的不算
  assert.equal(redactDeep({ p: 'Short1Value' }).p, 'Short1Value');
  assert.equal(redactDeep({ p: 'g'.repeat(40) }).p, 'g'.repeat(40));              // 没有大写和数字
  assert.equal(redactUrl(`http://localhost${path}?next=${path}`), `http://localhost${path}?next=${path}`);
});

test('quoted parameter values: only the content between the quotes is replaced', () => {
  assert.equal(redactText('password="a b" ok'), 'password="[REDACTED]" ok');
  assert.equal(redactText('password="hunter2X" ok'), 'password="[REDACTED]" ok');
  assert.equal(redactText("data-token='v1' ok"), "data-token='[REDACTED]' ok");
  assert.equal(redactText('/cb?token="v1"&a=1'), '/cb?token="[REDACTED]"&a=1');
  assert.equal(redactText('password="a\\"b c" ok'), 'password="[REDACTED]" ok');
  assert.equal(redactText('password="a b" pwd="c d"'), 'password="[REDACTED]" pwd="[REDACTED]"');
  assert.ok(!redactText('password="abc').includes('abc'));          // 没有结束引号：换到串尾
  assert.ok(!redactText("password='abc d").includes('abc'));
  assert.equal(redactText('note="a b" ok'), 'note="a b" ok');       // 名字不敏感
});

test('sensitive header lines: non-ascii, symbol-only, line separators, underscores', () => {
  assert.equal(redactText('Password: \u043f\u0430\u0440\u043e\u043b\u044c'), 'Password: [REDACTED]');
  assert.equal(redactText('X-Api-Key: !@#$%^&*()'), 'X-Api-Key: [REDACTED]');
  assert.equal(redactText('Cookie:'), 'Cookie: [REDACTED]');
  assert.equal(redactText('X-Api-Key: v1\u2028tail'), 'X-Api-Key: [REDACTED]');
  assert.equal(redactText('X-Api-Key: v1\u2029tail'), 'X-Api-Key: [REDACTED]');
  assert.equal(redactText('api_key: v1'), 'api_key: [REDACTED]');
  assert.equal(redactText('client_secret: v1\nok: 1'), 'client_secret: [REDACTED]\nok: 1');
  assert.equal(redactText('Authorization: Bearer [REDACTED]'), 'Authorization: Bearer [REDACTED]');
});

test('redactSelector: an unquoted attribute value ends at its closing bracket, so the rest of the selector survives', () => {
  assert.equal(redactSelector('[data-auth=primary][type=button]'), `[data-auth=${REDACTED}][type=button]`);
  assert.equal(redactSelector('div[data-token-state=ready] > span'), `div[data-token-state=${REDACTED}] > span`);
  assert.equal(redactSelector('[data-auth="primary"][type=button]'), `[data-auth=${REDACTED}][type=button]`);
  assert.equal(redactSelector('input[type=password]'), 'input[type=password]');
  assert.equal(redactSelector(`text=${jwt}`), `text=${REDACTED}`);
  // 值里成对的方括号算值的一部分：已脱敏的结果再过一遍不变，`[REDACTED]` 后面藏的东西也一起换掉。
  for (const sel of ['[data-auth=primary][type=button]', '[token=a[b]c]', '[token=[REDACTED]tail][x=1]']) {
    const once = redactSelector(sel);
    assert.equal(redactSelector(once), once, sel);
  }
  assert.equal(redactSelector('[token=[REDACTED]tail][x=1]'), `[token=${REDACTED}][x=1]`);
  // CSS 转义：反斜杠连同下一个字符算进值，`\\]` 不结束值。
  assert.equal(redactSelector('[data-token=ab\\]cd][x=1]'), `[data-token=${REDACTED}][x=1]`);
  assert.equal(redactSelector('[token=a\\[b][x=1]'), `[token=${REDACTED}][x=1]`);
  assert.equal(redactSelector('[token=a\\'), `[token=${REDACTED}`);
  for (const esc of [' ', '"', '#', '&', '<', '>']) assert.equal(redactSelector(`[data-token=ab\\${esc}cd][x=1]`), `[data-token=${REDACTED}][x=1]`, esc);
  assert.equal(redactSelector(redactSelector('[data-token=ab\\]cd][x=1]')), `[data-token=${REDACTED}][x=1]`);
  // 找不到配对的 `]`：换到串尾（失败关闭）。
  assert.equal(redactSelector('[token=a[b'), `[token=${REDACTED}`);
  // `=` 两边有空白、CSS 运算符、引号混在值里、值里有空白：都换到配对的 `]`。
  const cases: Array<[string, string]> = [
    ['[data-token = secret][x=1]', `[data-token = ${REDACTED}][x=1]`],
    ['[ data-token=secret ][x=1]', `[ data-token=${REDACTED}][x=1]`],
    ['[data-token^=abc][x=1]', `[data-token^=${REDACTED}][x=1]`],
    ['[data-token *= "abc"][x=1]', `[data-token *= ${REDACTED}][x=1]`],
    ['[data-token|=abc i][x=1]', `[data-token|=${REDACTED}][x=1]`],
    ['[token="ab"cd][x=1]', `[token=${REDACTED}][x=1]`],
    ['[token="a]b"][x=1]', `[token=${REDACTED}][x=1]`],
    ["[token='a]b'][x=1]", `[token=${REDACTED}][x=1]`],
    ['[token=ab cd][x=1]', `[token=${REDACTED}][x=1]`],
  ];
  for (const [sel, want] of cases) {
    assert.equal(redactSelector(sel), want, sel);
    assert.equal(redactSelector(want), want, `idempotent: ${sel}`);
  }
  // 精确匹配的敏感名加运算符（名字不能把运算符吞进去）。
  assert.equal(redactSelector('[pw^=secret][x=1]'), `[pw^=${REDACTED}][x=1]`);
  assert.equal(redactSelector('[sid |= abc][x=1]'), `[sid |= ${REDACTED}][x=1]`);
  // 不紧跟 `[` 的 `名字=`：换到串尾，不在 `]` 处停下（失败关闭）。
  for (const sel of ['[ a]token=abc]def', '#x token=ab]cd', 'a[href="/cb?token=abc]def"]', 'div;token=ab]cd ef', 'text=x&token=ab]cd', 'token=ab]cd']) {
    const out = redactSelector(sel);
    assert.ok(out.endsWith(REDACTED) && !out.includes('cd') && !out.includes('def'), `${sel} -> ${out}`);
    assert.equal(redactSelector(out), out);
  }
  assert.equal(redactSelector('#x token=abc >> div[x=1]'), `#x token=${REDACTED}`);
  // 名字里的 CSS 转义、命名空间前缀、XPath 的 `@`、`-`/`_` 分段里的精确敏感名：先还原名字再判断。
  const named: Array<[string, string]> = [
    ['[t\\oken=secret][x=1]', `[t\\oken=${REDACTED}][x=1]`],
    ['[\\74oken=secret][x=1]', `[\\74oken=${REDACTED}][x=1]`],
    ['[\\74 oken=secret][x=1]', `[\\74 oken=${REDACTED}][x=1]`],
    ['[\\000074oken = secret][x=1]', `[\\000074oken = ${REDACTED}][x=1]`],
    ['[\\000070ass=secret][x=1]', `[\\000070ass=${REDACTED}][x=1]`],
    ['[token| =secret][x=1]', `[token| =${REDACTED}][x=1]`],
    ['[\\apikey =secret][x=1]', `[\\apikey =${REDACTED}][x=1]`],
    ['[a\\[pw = secret][x=1]', `[a\\[pw = ${REDACTED}][x=1]`],
    ['[a\\[pw^=secret][x=1]', `[a\\[pw^=${REDACTED}][x=1]`],
    ['\\[a\\[ pw = secret][x=1]', `\\[a\\[ pw = ${REDACTED}][x=1]`],
    ['[ns|pw=secret][x=1]', `[ns|pw=${REDACTED}][x=1]`],
    ['[*|pw^=secret][x=1]', `[*|pw^=${REDACTED}][x=1]`],
    ['[|sid=secret][x=1]', `[|sid=${REDACTED}][x=1]`],
    ['[data-pw=secret][x=1]', `[data-pw=${REDACTED}][x=1]`],
    ['[data_pass="secret"][x=1]', `[data_pass=${REDACTED}][x=1]`],
    ['xpath=//input[@pw = "secret"]', `xpath=//input[@pw = ${REDACTED}]`],
  ];
  for (const [sel, want] of named) {
    assert.equal(redactSelector(sel), want, sel);
    assert.equal(redactSelector(want), want, `idempotent: ${sel}`);
  }
  // CSS 注释当空白；XPath 的 `!=`、`@前缀:名字`；`.`、`:` 也是分段符。
  const more: Array<[string, string]> = [
    ['[pw/**/=secret][x=1]', `[pw/**/=${REDACTED}][x=1]`],
    ['[/* c */pw /* c */= secret][x=1]', `[/* c */pw /* c */= ${REDACTED}][x=1]`],
    ['xpath=//input[@ns:pw="secret"]', `xpath=//input[@ns:pw=${REDACTED}]`],
    ['xpath=//input[@pw!="secret"]', `xpath=//input[@pw!=${REDACTED}]`],
    ['[data.pw=secret][x=1]', `[data.pw=${REDACTED}][x=1]`],
  ];
  for (const [sel, want] of more) {
    assert.equal(redactSelector(sel), want, sel);
    assert.equal(redactSelector(want), want, `idempotent: ${sel}`);
  }
  // 敏感名后面的注释没闭合：从名字结尾换到串尾（失败关闭）。
  assert.equal(redactSelector('[pw/* =secret][x=1]'), `[pw${REDACTED}`);
  // 认注释不能比不认注释时漏得多：开头注释没闭合、注释里的 `[`、名字中间的注释、前缀里非法的 `%`、值里注释中的 `]`。
  for (const sel of [
    '[/*-pw =secret', '[/*sessionid =secret', '[x=1][/*/data-pw $= "secret" ]',
    '[/* [pw = secret] */ x]', '[pw /* [token = secret] */ = secret]',
    '[x/**/-pw = secret]', '[&/**/data_pass ^= secret]',
    '[%|p%77=secret', '[x%|p%61ss=secret][a=1]', '[%|%61pi_key=secret]', '[a%|%61pi-key=secret]', '[data%2epw=secret]',
    '[pw=/*]*/secret]',
  ]) {
    const out = redactSelector(sel);
    assert.ok(!out.includes('secret'), `${sel} -> ${out}`);
    assert.equal(redactSelector(out), out, `idempotent: ${sel}`);
  }
  assert.equal(redactSelector('xpath=//input[@pw !="secret"]'), `xpath=//input[@pw !=${REDACTED}]`);
  // 路径或文字里按分段认出的精确敏感名：换到串尾。
  for (const sel of ['[href="/cb/pw=secret"][x=1]', 'text=data-pw=secret >> div']) {
    const out = redactSelector(sel);
    assert.ok(out.endsWith(REDACTED) && !out.includes('secret'), `${sel} -> ${out}`);
  }
  // 含 `; ` 的选择器（会碰到自由文本的 cookie 行规则）也要幂等。
  for (const sel of ['[token=x]; s=', '[a=1]; [token=x]; b=2', 'text=a=1; token=b']) {
    const once = redactSelector(sel);
    assert.equal(redactSelector(once), once, sel);
    assert.ok(!once.includes('token=x') && !once.includes('token=b'), `${sel} -> ${once}`);
  }
  // 引号里、或紧跟 `=` 的 `名字=`（`text=token=…`、可访问名里的 `token=…`）：换到串尾。
  for (const sel of ['role=textbox[name="token=abc"]', 'text="token=abc"', "text='token=abc'", ':has-text("token=abc")', 'text=token=abc >> div']) {
    const out = redactSelector(sel);
    assert.ok(out.endsWith(REDACTED) && !out.includes('abc'), `${sel} -> ${out}`);
    assert.equal(redactSelector(out), out);
  }
  // 不敏感的照旧（含转义名、引号里的 `名字=`）。
  for (const sel of ['[d\\61ta-x=1][y=2]', '[data-x="a=b"]', 'role=button[name="Author=me"]', '[data-passage=1]', 'text="Sign in"', 'a[href="/cb/path=1"]', '[a/**/=1][b=2]']) {
    assert.equal(redactSelector(sel), sel);
  }
  // 引号没闭合：换到串尾（失败关闭）。
  assert.equal(redactSelector('[token=ab"cd][x=1]'), `[token=${REDACTED}`);
  assert.equal(redactSelector('[data-token = "abc][x=1]'), `[data-token = ${REDACTED}`);
  // 名字不敏感的照旧。
  assert.equal(redactSelector('[type = "password"][x=1]'), '[type = "password"][x=1]');
  assert.equal(redactSelector('role=button[name = "Submit order"]'), 'role=button[name = "Submit order"]');
  // 自由文本不受影响：`]` 不结束值。
  assert.equal(redactText('[data-auth=primary][type=button]'), `[data-auth=${REDACTED}`);
});

test('redactDeep selectorKeys: strings under those keys (also nested, also in arrays) use the selector rule', () => {
  const v = { target: '[data-auth=a][b=c]', mask: ['[data-auth=a][b=c]'], other: '[data-auth=a][b=c]', t: { given: '[data-auth=a][b=c]' },
    given: { note: '[data-auth=a][b=c]' } };
  const out = redactDeep(v, { selectorKeys: ['target', 'mask', 'given'] });
  // 只看字符串所在的键（数组沿用键）：选择器键下面的对象里，别的键照常按自由文本处理。
  assert.deepEqual(out, { target: `[data-auth=${REDACTED}][b=c]`, mask: [`[data-auth=${REDACTED}][b=c]`], other: `[data-auth=${REDACTED}`,
    t: { given: `[data-auth=${REDACTED}][b=c]` }, given: { note: `[data-auth=${REDACTED}` } });
  assert.equal(redactDeep({ target: 'Ab1'.repeat(14) }, { selectorKeys: ['target'] }).target, REDACTED);
});

test('redactSelector stays fast on adversarial input', () => {
  const inputs = ['[token=' + '['.repeat(1e5), '[token=['.repeat(30000), '[token=]'.repeat(30000), '[a=['.repeat(30000),
    '[token=' + '[]'.repeat(50000), '[token=' + ']'.repeat(1e5), '[token=a'.repeat(30000) + ']', '[token=' + '\\'.repeat(1e5), '[token=\\'.repeat(30000),
    '[' + 'a'.repeat(1e5), '[a '.repeat(30000), '[ '.repeat(30000), '[a^'.repeat(30000), '[token = "'.repeat(30000),
    '[token="' + '\\'.repeat(1e5), '[token = ['.repeat(30000), '[token="' + ']'.repeat(1e5), "[a='".repeat(30000),
    '[' + '\\1'.repeat(50000), '[' + '\\111111'.repeat(30000), '[\\'.repeat(30000), '"a='.repeat(30000), "'a=".repeat(30000),
    '[a|'.repeat(30000), '[' + 'a|'.repeat(50000), '[' + '\\1 '.repeat(50000), '[' + '\\'.repeat(1e5),
    '[a /*'.repeat(30000), '[a /* '.repeat(30000) + '*/', '/*'.repeat(50000), '[pw/*'.repeat(30000), '[a/**/'.repeat(30000), 'a=1; '.repeat(30000)];
  const start = performance.now();
  for (const s of inputs) redactSelector(s);
  assert.ok(performance.now() - start < 2000);
});
