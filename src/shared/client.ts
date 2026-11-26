import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { relative } from 'node:path';
import { E2kError } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { assertSocketPathFits, resolveInside } from './paths.ts';
import type { Home } from './paths.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import type { Method, Response } from './protocol.ts';

// CLI 这一侧：连内核的 socket，发一行请求、收一行回应（设计 5.1）。
// 不设超时：一批操作可以跑几十分钟，一直等到内核回话。

const ERROR_CODES: readonly ErrorCode[] =
  ['usage', 'not-found', 'busy', 'action-failed', 'internal', 'needs-human', 'wait-login', 'wait-approval'];

function notRunning(): E2kError {
  return new E2kError('needs-human', '内核没在跑');
}

function interrupted(): E2kError {
  return new E2kError('internal', '内核连接中断');
}

function malformed(): E2kError {
  return new E2kError('internal', '内核的回应格式不对');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 回应的 id 必须是这次请求的；内核解析不出请求时回 "-"，那只能是一个错误回应。
function checkResponse(line: string, id: string): Response {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw malformed();
  }
  if (!isObject(v) || v.v !== PROTOCOL_VERSION) throw malformed();
  if (v.ok === true) {
    if (v.id !== id || !('result' in v)) throw malformed();
    return { v: PROTOCOL_VERSION, id, ok: true, result: v.result };
  }
  if (v.ok !== false || (v.id !== id && v.id !== '-')) throw malformed();
  const e = v.error;
  if (!isObject(e) || !(ERROR_CODES as readonly unknown[]).includes(e.code) || typeof e.message !== 'string') throw malformed();
  if (e.next !== undefined && typeof e.next !== 'string') throw malformed();
  const error: { code: ErrorCode; message: string; next?: string } = { code: e.code as ErrorCode, message: e.message };
  if (typeof e.next === 'string') error.next = e.next;
  return { v: PROTOCOL_VERSION, id: v.id, ok: false, error };
}

export async function call(home: Home, method: Method, params: unknown): Promise<Response> {
  const socketPath = resolveInside(home.root, relative(home.root, home.socket));
  assertSocketPathFits(socketPath);
  const id = randomUUID();
  const request = `${JSON.stringify({ v: PROTOCOL_VERSION, id, method, params })}\n`;
  const line = await new Promise<string>((resolve, reject) => {
    const sock = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let connected = false;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fn();
    };
    sock.on('connect', () => {
      connected = true;
      sock.write(request);
    });
    sock.on('data', (chunk: Buffer) => {
      const nl = chunk.indexOf(0x0a);
      if (nl < 0) {
        chunks.push(chunk);
        return;
      }
      chunks.push(chunk.subarray(0, nl));
      const text = Buffer.concat(chunks).toString('utf8');
      settle(() => { resolve(text); });
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      const gone = !connected && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED');
      settle(() => { reject(gone ? notRunning() : interrupted()); });
    });
    sock.on('close', () => { settle(() => { reject(interrupted()); }); });
  });
  return checkResponse(line, id);
}
