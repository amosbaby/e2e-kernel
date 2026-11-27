// 手写的 JSON-RPC 2.0 服务（按行分隔，单个对象；R14）：只管分帧、校验信封、并发分发、写回应。
// 方法的含义由 handle 决定。不回显输入：错误对象只有 code 和按 code 固定的文案。

export const MAX_LINE_BYTES = 2 * 1024 * 1024;

const MESSAGES: Record<number, string> = {
  [-32700]: 'Parse error',
  [-32600]: 'Invalid Request',
  [-32601]: 'Method not found',
  [-32602]: 'Invalid params',
  [-32603]: 'Internal error',
};

export class RpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

type Id = string | number | null;

function errorLine(id: Id, code: number, message?: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: MESSAGES[code] ?? message ?? MESSAGES[-32603] } });
}

function isId(v: unknown): v is string | number {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

export function serveJsonRpc(
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
  handle: (method: string, params: unknown) => Promise<unknown>,
  o: { maxLineBytes?: number } = {},
): Promise<void> {
  const max = o.maxLineBytes ?? MAX_LINE_BYTES;
  const inflight = new Set<Promise<void>>();

  // 一条回应写一整行；写失败（对端关了）不影响继续服务。
  const emit = (line: string): void => {
    try {
      write(line);
    } catch { /* 写不出去就丢，不让整个服务崩 */ }
  };

  async function dispatch(text: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      emit(errorLine(null, -32700));
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      emit(errorLine(null, -32600));
      return;
    }
    const m = msg as Record<string, unknown>;
    const hasId = Object.hasOwn(m, 'id');
    const readable: Id = hasId && isId(m.id) ? m.id : null;
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string' || (hasId && !isId(m.id))) {
      emit(errorLine(readable, -32600));
      return;
    }
    const isNotification = !hasId;
    // 没有 id 的只当通知收：方法不是 notifications/ 开头的（比如没带 id 的 tools/call）直接丢掉，不执行、不回应。
    if (isNotification && !m.method.startsWith('notifications/')) return;
    try {
      const result = await handle(m.method, m.params);
      if (isNotification) return;
      emit(JSON.stringify({ jsonrpc: '2.0', id: readable, result: result === undefined ? {} : result }));
    } catch (e) {
      if (isNotification) return;
      if (e instanceof RpcError) emit(errorLine(readable, e.code, e.message));
      else emit(errorLine(readable, -32603));
    }
  }

  // 序列化结果失败（比如 BigInt）也走 -32603：dispatch 里 JSON.stringify 抛错落进上面的 catch。
  const start = (text: string): void => {
    if (text.trim() === '') return;
    const p: Promise<void> = dispatch(text).catch(() => { emit(errorLine(null, -32603)); }).finally(() => { inflight.delete(p); });
    inflight.add(p);
  };

  return new Promise<void>((resolve) => {
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let skipping = false;   // 正在丢弃一条超长的行（已经回过错）

    const line = (parts: Buffer[]): void => { start(Buffer.concat(parts).toString('utf8')); };
    const tooLong = (): void => { emit(errorLine(null, -32600)); };

    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      let off = 0;
      while (off < buf.length) {
        const nl = buf.indexOf(0x0a, off);
        const end = nl === -1 ? buf.length : nl;
        const segLen = end - off;
        if (skipping) {
          // 丢到换行为止
        } else if (pendingLen + segLen > max) {
          tooLong();
          skipping = nl === -1;   // 这一段里就有换行：这一行到此为止；没有：后面的块继续丢
          pending = [];
          pendingLen = 0;
        } else if (nl === -1) {
          pending.push(buf.subarray(off, end));
          pendingLen += segLen;
        } else {
          pending.push(buf.subarray(off, end));
          line(pending);
          pending = [];
          pendingLen = 0;
        }
        if (nl === -1) break;
        if (skipping && nl !== -1) skipping = false;
        off = nl + 1;
      }
    };

    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      if (!skipping && pendingLen > 0) line(pending);
      pending = [];
      void (async () => {
        // 每个在途的调用都答完才算结束；答的过程中不会再有新的。
        while (inflight.size > 0) await Promise.all([...inflight]);
        resolve();
      })();
    };

    input.on('data', onData);
    input.once('end', finish);
    input.once('close', finish);
    input.once('error', finish);
  });
}
