import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { startFixtureServer } from '../support/fixture-server.ts';
import type { FixtureServer } from '../support/fixture-server.ts';

let server: FixtureServer;
before(async () => { server = await startFixtureServer(); });
after(() => server.close());

async function get(path: string): Promise<string> {
  return (await fetch(server.origin + path)).text();
}

// fetch 会先把 `..` 规范掉，测不到穿越；这里原样发路径。
function rawGet(path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves pages with placeholders filled in', async () => {
  const html = await get('/index.html');
  assert.match(html, /<h1>Items<\/h1>/);
  assert.ok(!html.includes('{{'));
  assert.ok((await get('/tricky.html')).includes(server.fake.jwt));
});

test('rejects path traversal sent as-is', async () => {
  for (const p of ['/../../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/a%00.html', '/controls.js/../../../package.json'])
    assert.equal((await rawGet(p)).status, 404, p);
  assert.equal((await rawGet('/index.html')).status, 200);
});

test('records writes', async () => {
  await fetch(server.origin + '/api/items?x=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.deepEqual(server.hits.at(-1), { method: 'POST', path: '/api/items', query: { x: '1' }, body: '{"a":1}', contentType: 'application/json' });
});

test('login page sets the fixture cookie', async () => {
  assert.match((await fetch(server.origin + '/login.html')).headers.get('set-cookie') ?? '', /^fixture_login=1/);
});

test('fake values differ between runs and are not literals in the repo', async () => {
  const other = await startFixtureServer();
  try {
    assert.notEqual(other.fake.jwt, server.fake.jwt);
    assert.match(server.fake.jwt, /^eyJ[\w-]{21}\.[\w-]{24}\.[\w-]{24}$/);
  } finally { await other.close(); }
});

test('altOrigin serves the same site', async () => {
  assert.equal((await fetch(server.altOrigin + '/index.html')).status, 200);
});

test('fake bearer and password have the documented shape', () => {
  assert.match(server.fake.bearer, /^[0-9a-f]{40}$/);
  assert.match(server.fake.password, /^[A-Za-z0-9]{16}$/);
});

test('static files: only .html and .js, never cached, everything else 404', async () => {
  const js = await fetch(server.origin + '/controls.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('cache-control'), 'no-store');
  assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/);
  await js.text();
  const page = await fetch(server.origin + '/index.html');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  await page.text();
  for (const p of ['/', '/missing.html', '/cb?token=x', '/api/items'])
    assert.equal((await rawGet(p)).status, 404, p);
});

test('form posts get an HTML page, other writes get JSON', async () => {
  const form = await fetch(server.origin + '/api/form', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=hello' });
  assert.match(await form.text(), /<p id="done">received<\/p>/);
  assert.deepEqual(server.hits.at(-1), { method: 'POST', path: '/api/form', query: {}, body: 'title=hello', contentType: 'application/x-www-form-urlencoded' });
  const put = await fetch(server.origin + '/api/items/1', { method: 'PUT' });
  assert.deepEqual(await put.json(), { ok: true });
  assert.deepEqual(server.hits.at(-1), { method: 'PUT', path: '/api/items/1', query: {}, body: '', contentType: null });
});

test('write bodies are capped at 64 KiB', async () => {
  await fetch(server.origin + '/api/big', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'a'.repeat(70 * 1024) });
  assert.equal(server.hits.at(-1)?.body.length, 64 * 1024);
});

test('GET /ws completes the WebSocket handshake', async () => {
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const accept = await new Promise<string | undefined>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.port, path: '/ws',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.headers['sec-websocket-accept']);
    });
    req.on('response', () => reject(new Error('no upgrade')));
    req.on('error', reject);
    req.end();
  });
  assert.equal(accept, expected);
});
