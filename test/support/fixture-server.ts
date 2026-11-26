import { createHash, randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { extname, join } from 'node:path';
import { resolveInside } from '../../src/shared/paths.ts';

export interface FixtureHit { method: string; path: string; query: Record<string, string>; body: string; contentType: string | null }
export interface FixtureServer {
  origin: string;      // http://127.0.0.1:<port>
  altOrigin: string;   // http://localhost:<port>（同一个服务，另一个站点）
  port: number;
  hits: FixtureHit[];
  fake: { bearer: string; jwt: string; password: string; email: string; formToken: string };   // 每次启动随机生成的假值
  close(): Promise<void>;
}

const SITE_DIR = join(import.meta.dirname, '..', 'fixtures', 'site');
const MAX_BODY = 64 * 1024;
const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const HEX = '0123456789abcdef';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64URL = ALNUM + '-_';

function randomChars(n: number, alphabet: string): string {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

// 长得像 token 的值只在运行时生成，仓库里没有字面量。
function makeFakes(): FixtureServer['fake'] {
  return {
    bearer: randomChars(40, HEX),
    jwt: ['eyJ' + randomChars(21, B64URL), randomChars(24, B64URL), randomChars(24, B64URL)].join('.'),
    password: randomChars(16, ALNUM),
    email: `u${randomChars(10, HEX)}@example.com`,
    formToken: randomChars(43, ALNUM) + '=',   // 44 位标准 base64 的样子
  };
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('not found');
}

// 原样拿到的路径部分 → site 目录里的文件；解码失败、含 NUL、越出目录、扩展名不对、不是文件，一律 null。
function siteFile(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (!(extname(decoded) in CONTENT_TYPES)) return null;
  let file: string;
  try {
    file = resolveInside(SITE_DIR, decoded.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function isForm(contentType: string | null): boolean {
  const t = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
  return t === 'application/x-www-form-urlencoded' || t === 'multipart/form-data';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size >= MAX_BODY) return; // 超出的部分读掉丢弃
      const part = chunk.subarray(0, MAX_BODY - size);
      chunks.push(part);
      size += part.length;
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const fake = makeFakes();
  const hits: FixtureHit[] = [];
  const upgraded = new Set<Duplex>();
  let altOrigin = '';

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '/';
    const q = raw.indexOf('?');
    const rawPath = q >= 0 ? raw.slice(0, q) : raw;
    const url = new URL(raw, 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    // 只用来记录重定向的后续跳是否经过路由 handler：任何方法都 307 到写端点，浏览器会带着方法和请求体再来一次。
    if (url.pathname === '/r307') {
      await readBody(req);
      res.writeHead(307, { location: '/api/sink', 'cache-control': 'no-store' });
      res.end();
      return;
    }

    // /redir：302 到 index.html（重定向链：idle 计数在中间跳上不能漏减）。
    if (url.pathname === '/redir') {
      res.writeHead(302, { location: '/index.html', 'cache-control': 'no-store' });
      res.end();
      return;
    }

    // /slow?ms=N：N 毫秒（默认 5000）之后才回应；连接提前断了就不再回。
    if (url.pathname === '/slow') {
      const ms = Math.min(Number(url.searchParams.get('ms') ?? '5000') || 5000, 30_000);
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('slow');
      }, ms);
      res.on('close', () => clearTimeout(timer));
      return;
    }

    // /events：一个一直开着的 SSE 流；?late=1 则 3 秒后才发响应头（idle 不算 eventsource 请求）。
    if (url.pathname === '/events') {
      const open = (): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': open\n\n');
      };
      if (url.searchParams.get('late') === '1') {
        const timer = setTimeout(open, 3000);
        res.on('close', () => clearTimeout(timer));
      } else {
        open();
      }
      return;
    }

    if (WRITE_METHODS.includes(method) && url.pathname.startsWith('/api/')) {
      const contentType = req.headers['content-type'] ?? null;
      const body = await readBody(req);
      hits.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, contentType });
      if (isForm(contentType)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><title>Received</title><p id="done">received</p>');
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"ok":true}');
      }
      return;
    }

    const file = method === 'GET' ? siteFile(rawPath) : null;
    if (file === null) return notFound(res);
    const ext = extname(file);
    let content = readFileSync(file, 'utf8');
    if (ext === '.html') {
      content = content
        .replaceAll('{{FAKE_BEARER}}', fake.bearer)
        .replaceAll('{{FAKE_JWT}}', fake.jwt)
        .replaceAll('{{FAKE_PASSWORD}}', fake.password)
        .replaceAll('{{FAKE_EMAIL}}', fake.email)
        .replaceAll('{{FAKE_FORM_TOKEN}}', fake.formToken)
        .replaceAll('{{ALT_ORIGIN}}', altOrigin);
    }
    const headers: Record<string, string> = { 'content-type': CONTENT_TYPES[ext] ?? 'text/plain', 'cache-control': 'no-store' };
    if (url.pathname === '/login.html') headers['set-cookie'] = 'fixture_login=1; Path=/';
    res.writeHead(200, headers);
    res.end(content);
  }

  // 只做握手，之后保持连接，不收发帧。
  function upgrade(req: IncomingMessage, socket: Duplex): void {
    socket.on('error', () => {});
    const key = req.headers['sec-websocket-key'];
    const isWs = (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    if (req.method !== 'GET' || new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/ws' || !isWs || typeof key !== 'string' || key === '') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
  }

  function makeServer(): http.Server {
    const s = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    s.on('upgrade', upgrade);
    s.on('clientError', (_err, socket: Socket) => socket.destroy());
    return s;
  }

  const v4 = makeServer();
  await new Promise<void>((resolve, reject) => {
    v4.once('error', reject);
    v4.listen(0, '127.0.0.1', () => resolve());
  });
  const address = v4.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port');
  const port = address.port;

  // 同一个端口再绑 ::1，让解析到 IPv6 的 localhost 也能连上；绑不上就算了。
  const v6 = makeServer();
  const v6Up = await new Promise<boolean>((resolve) => {
    v6.once('error', () => resolve(false));
    v6.listen(port, '::1', () => resolve(true));
  });
  const servers = v6Up ? [v4, v6] : [v4];

  const origin = `http://127.0.0.1:${port}`;
  altOrigin = `http://localhost:${port}`;

  return {
    origin,
    altOrigin,
    port,
    hits,
    fake,
    async close() {
      for (const s of upgraded) s.destroy();
      upgraded.clear();
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => {
        s.close(() => resolve());
        s.closeAllConnections();
      })));
    },
  };
}
