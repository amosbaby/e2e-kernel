import { chmodSync, closeSync, constants, fchmodSync, lstatSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { NAVIGATION_TIMEOUT_MS } from '../driver/types.ts';
import type { Capabilities, Driver, Instance } from '../driver/types.ts';
import { E2kError } from '../shared/errors.ts';
import { assertSocketPathFits, ensurePrivateDir, resolveInside } from '../shared/paths.ts';
import type { Home } from '../shared/paths.ts';
import { KERNEL_SKIP_KEYS, MAX_LINE_BYTES, PROTOCOL_VERSION, parseRequest, validateParams } from '../shared/protocol.ts';
import type { Request, Response, SessionInfo } from '../shared/protocol.ts';
import { redactDeep, redactText, safely } from '../shared/redact.ts';
import { kernelVersion } from '../shared/version.ts';
import { Approvals, osascriptDialog } from './approval.ts';
import type { Dialog } from './approval.ts';
import type { RulesState } from './mode.ts';
import { createRulesResolver } from './rules.ts';
import { DEFAULT_PROFILE, profileInfo } from './profiles.ts';
import type { ProfileInfo } from './profiles.ts';
import { SessionManager } from './sessions.ts';
import { policy } from './write-policy.ts';

// 内核进程（设计 5.1）：单实例、只给当前用户用的 Unix socket、一条连接一问一答，请求交给 SessionManager。

export interface KernelOptions {
  home: Home; driver: Driver; idleMs?: number; keepRuns?: number;
  stopDeadlineMs?: number;   // stop() 等会话收尾的期限，过了就直接停浏览器实例并退出
  dialog?: Dialog;           // 向人弹确认框的实现，缺省是 macOS 原生对话框；测试和 --no-dialogs 传别的
}
// abort()：关停进行中时再来一次停止信号用——不再等任何期限，直接停浏览器实例、断开连接、清理文件。
export interface KernelHandle { stop(): Promise<void>; abort(): Promise<void> }
export interface StatusResult { version: string; pid: number; home: string;
  driver: { name: string; capabilities: Capabilities }; instance: 'stopped' | 'running'; sessions: SessionInfo[]; profiles: ProfileInfo[]; rules: RulesState }

const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_KEEP_RUNS = 20;
// 关停要等进行中的 open 落定，最长一次导航超时；驱动卡住时会更久，所以另给一个期限。
const DEFAULT_STOP_DEADLINE_MS = NAVIGATION_TIMEOUT_MS + 15_000;
// drain 用完整个期限还没完时，直接停实例至少再给这么久；关停总时长因此不超过「期限 + 这段」。
const INSTANCE_STOP_GRACE_MS = 1_000;
const READ_LINE_MS = 5_000;
const PROBE_WINDOW_MS = 2_000;
const PROBE_INTERVAL_MS = 200;
const INTERNAL_MESSAGE = '内核内部错误，详见 kernel.log';

function alreadyRunning(): E2kError {
  return new E2kError('usage', '内核已在运行');
}

// ---- 日志 ----

// kernel.log：0600，不跟随符号链接。每行先脱敏；脱敏出错写固定标记，写不了也不影响内核。
export class KernelLog {
  private fd: number | undefined;

  constructor(path: string) {
    this.fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    fchmodSync(this.fd, 0o600);
  }

  write(line: string): void {
    if (this.fd === undefined) return;
    try {
      // 一条日志一行：CR、LF 各换成一个空格，调用方没处理好换行（比如多行 stack）也伪造不出多行。
      writeSync(this.fd, `${new Date().toISOString()} ${safely(() => redactText(line)).replace(/[\r\n]/g, ' ')}\n`);
    } catch {
      // 日志写不了也不能影响请求和收尾。
    }
  }

  // 关掉以后不再写：fd 号可能已经被别的文件复用。
  close(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd !== undefined) closeSync(fd);
  }
}

// 给驱动的 onListenerError（CLI 建驱动时传入）：每个监听器错误往 kernel.log 追加一行，先脱敏再并成一行；
// 脱敏出错写固定标记。本身绝不抛错：抛出去会被驱动当成未捕获异常。
export function listenerErrorLogger(home: Home): (e: unknown) => void {
  return (e) => {
    try {
      const log = new KernelLog(resolveInside(home.root, relative(home.root, home.logFile)));
      try {
        log.write(`驱动监听器出错：${safely(() => redactText(String(e instanceof Error ? e.message : e)).replace(/[\r\n]+/g, ' '))}`);
      } finally {
        log.close();
      }
    } catch {
      // 日志打不开也不能带垮内核。
    }
  };
}

// ---- 单实例 ----

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
  });
}

// EPERM：进程在，只是不归我们管，也算活着。
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(path: string): number | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

// 独占创建 pid 文件并写入自己的 pid。已存在返回 false。
function createPidFile(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, String(process.pid));
  } catch (e) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw e;
  }
  closeSync(fd);
  return true;
}

// 只删内容是自己 pid 的那份：别的内核的锁不碰。
function removeOwnPidFile(path: string): void {
  try {
    if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
  } catch {
    // 已经不在了，或读不了：都不是自己的锁。
  }
}

// pid 文件独占创建，加进程判活和 socket 探活。残留（进程已不在、内容不是 pid）删掉后只重来一次。
// 已知的残余（M1 接受，不修）：两个启动同时碰上同一份残留时，一个刚删掉残留并写下自己的 pid 文件，
// 另一个可能紧接着把它当残留删掉，留下毫秒级的窗口；Chromium 对 user data 目录自己的单实例锁是最后一道。
async function acquirePidFile(pidFile: string, socket: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (createPidFile(pidFile)) return;
    if (attempt > 0) throw alreadyRunning();
    const pid = readPid(pidFile);
    if (pid !== null && processAlive(pid)) {
      const until = Date.now() + PROBE_WINDOW_MS;
      for (;;) {
        if (await canConnect(socket)) throw alreadyRunning();
        if (Date.now() >= until) break;
        await sleep(PROBE_INTERVAL_MS);
      }
      throw new E2kError('needs-human', 'kernel.pid 指向一个活着的进程，但内核的 socket 不通', '确认没有内核在运行后删除 kernel.pid 再启动');
    }
    rmSync(pidFile, { force: true });
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => { reject(e.code === 'EADDRINUSE' ? alreadyRunning() : e); };
    server.once('error', onError);
    server.listen(path, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

// ---- 关停 ----

// p 在 ms 内成功落定返回 true；超时、被拒绝、或 cancel 先到（abort）都返回 false，并清掉计时器。
function completesWithin(p: Promise<unknown>, ms: number, cancel: Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, ms); });
  return Promise.race([p.then(() => true, () => false), timeout, cancel.then(() => false)]).finally(() => { clearTimeout(timer); });
}

// 记下驱动启动过、还没关掉的实例：关停超过期限时绕过 SessionManager 直接停它们。
function trackInstances(driver: Driver, live: Set<Instance>): Driver {
  return {
    name: driver.name,
    capabilities: driver.capabilities,
    selfCheck: () => driver.selfCheck(),
    async launch(profile) {
      const inst = await driver.launch(profile);
      live.add(inst);
      inst.onClosed(() => { live.delete(inst); });
      return inst;
    },
  };
}

// ---- 启动 ----

export async function startKernel(o: KernelOptions): Promise<KernelHandle> {
  process.umask(0o077);
  const { home } = o;
  ensurePrivateDir(home.root);
  assertSocketPathFits(home.socket);
  const inside = (path: string): string => resolveInside(home.root, relative(home.root, path));
  const pidFile = inside(home.pidFile);
  const socketPath = inside(home.socket);
  const logFile = inside(home.logFile);

  await acquirePidFile(pidFile, socketPath);
  let log: KernelLog | undefined;
  const server = createServer({ allowHalfOpen: true });
  try {
    log = new KernelLog(logFile);
    if (exists(socketPath)) {
      if (await canConnect(socketPath)) throw alreadyRunning();
      rmSync(socketPath, { force: true });   // 被强杀的内核留下的 socket 文件
    }
    await listen(server, socketPath);
    try {
      chmodSync(socketPath, 0o600);
    } catch (e) {
      server.close();
      throw e;
    }
  } catch (e) {
    log?.close();
    removeOwnPidFile(pidFile);
    throw e;
  }
  return serve(o, server, log, pidFile);
}

function serve(o: KernelOptions, server: Server, log: KernelLog, pidFile: string): KernelHandle {
  const { home, driver } = o;
  const version = kernelVersion();
  const stopDeadlineMs = o.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS;
  const instances = new Set<Instance>();
  // 唯一组装 SessionDeps 的地方：M2 换掉 modes 和 policy 就接上了。
  const modes = createRulesResolver(home.rulesFile);
  const sessions = new SessionManager({
    driver: trackInstances(driver, instances), home, modes, policy,
    idleMs: o.idleMs ?? DEFAULT_IDLE_MS, keepRuns: o.keepRuns ?? DEFAULT_KEEP_RUNS, now: () => new Date(),
    kernelVersion: version, log: (line) => { log.write(line); },
    approvals: new Approvals(o.dialog ?? osascriptDialog(), (line) => { log.write(line); }),
  });
  const connections = new Set<Socket>();
  const answering = new Set<Promise<void>>();

  // 先重读规则文件再报：status 看到的是此刻磁盘上的状态（改坏了会带 error）。
  const status = (): StatusResult => {
    modes.refresh();
    return {
      version, pid: process.pid, home: home.root, driver: { name: driver.name, capabilities: { ...driver.capabilities } },
      instance: sessions.instanceState(), sessions: sessions.list(),
      profiles: [profileInfo(home, DEFAULT_PROFILE)], rules: modes.state(),
    };
  };

  const dispatch = async (req: Request): Promise<unknown> => {
    switch (req.method) {
      case 'status':
        validateParams('status', req.params);
        return status();
      case 'open':
        return sessions.open(validateParams('open', req.params));
      case 'step':
        return sessions.step(validateParams('step', req.params));
      case 'close':
        return sessions.close(validateParams('close', req.params));
      case 'login.begin':
        return sessions.loginBegin(validateParams('login.begin', req.params));
      case 'login.end':
        return sessions.loginEnd(validateParams('login.end', req.params));
    }
  };

  // E2kError 原样回给调用方；别的异常只回固定消息，原始消息和堆栈脱敏后进日志。
  const wireError = (e: unknown, method: string, id: string): { code: E2kError['code']; message: string; next?: string } => {
    if (e instanceof E2kError) return e.next === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, next: e.next };
    log.write(`${method} ${id} 内部错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return { code: 'internal', message: INTERNAL_MESSAGE };
  };

  // 回应整个过一遍脱敏；脱敏或序列化出错就回固定的内部错误，绝不退回去输出原文。
  const encode = (resp: Response): { line: string; code: string } => {
    try {
      return { line: JSON.stringify(redactDeep(resp, { skipKeys: KERNEL_SKIP_KEYS })), code: resp.ok ? 'ok' : resp.error.code };
    } catch {
      log.write(`${resp.id} 回应脱敏失败`);
      const fallback: Response = { v: PROTOCOL_VERSION, id: resp.id, ok: false, error: { code: 'internal', message: INTERNAL_MESSAGE } };
      return { line: JSON.stringify(fallback), code: 'internal' };
    }
  };

  // 请求解析不出来时 id 写 "-"。日志一行：时间 方法 请求 id 结果码 耗时；不记参数和回应内容。
  const answer = async (line: string): Promise<string> => {
    const started = Date.now();
    let id = '-';
    let method = '-';
    let resp: Response;
    try {
      const req = parseRequest(line);
      id = req.id;
      method = req.method;
      resp = { v: PROTOCOL_VERSION, id, ok: true, result: await dispatch(req) };
    } catch (e) {
      resp = { v: PROTOCOL_VERSION, id, ok: false, error: wireError(e, method, id) };
    }
    const out = encode(resp);
    log.write(`${method} ${id} ${out.code} ${Date.now() - started}ms`);
    return `${out.line}\n`;
  };

  // 一条连接一问一答：读到第一个 \n；超长或 5 秒内没读完一行就断开。
  server.on('connection', (sock: Socket) => {
    connections.add(sock);
    const chunks: Buffer[] = [];
    let size = 0;
    let gotLine = false;
    const timer = setTimeout(() => { sock.destroy(); }, READ_LINE_MS);
    sock.on('error', () => { /* 对端断开之类：这条连接作废即可 */ });
    sock.on('close', () => {
      clearTimeout(timer);
      connections.delete(sock);
    });
    sock.on('end', () => { if (!gotLine) sock.destroy(); });
    sock.on('data', (chunk: Buffer) => {
      if (gotLine) return;
      const nl = chunk.indexOf(0x0a);
      const part = nl < 0 ? chunk : chunk.subarray(0, nl);
      size += part.length;
      if (size > MAX_LINE_BYTES) {
        gotLine = true;
        sock.destroy();
        return;
      }
      chunks.push(part);
      if (nl < 0) return;
      gotLine = true;
      clearTimeout(timer);
      const done = answer(Buffer.concat(chunks).toString('utf8'))
        .then((reply) => { if (!sock.destroyed) sock.end(reply); }, () => { sock.destroy(); });
      answering.add(done);
      void done.finally(() => { answering.delete(done); });
    });
  });
  server.on('error', (e: Error) => { log.write(`socket 服务出错：${e.message}`); });

  // 顺序：会话收尾（关停开始后 SessionManager 对新调用一律回 busy）→ 关 socket 服务 → 删 pid 文件。
  // 收尾有期限：过了、或收尾本身出错，就直接停驱动实例，照样往下走。总时长不超过「期限 + INSTANCE_STOP_GRACE_MS」。
  // abort()：所有等待立刻作废，只发出停实例的调用，然后断开连接、清理文件。
  let abortNow = (): void => {};
  const aborted = new Promise<void>((resolve) => { abortNow = resolve; });
  const shutdown = async (): Promise<void> => {
    const until = Date.now() + stopDeadlineMs;
    const drain = sessions.shutdown().catch((e: unknown) => {
      log.write(`关停收尾失败：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      throw e;
    });
    const drained = await completesWithin(drain, stopDeadlineMs, aborted);
    if (!drained) {
      log.write(`关停超过 ${stopDeadlineMs} 毫秒仍未完成，直接停浏览器实例`);
      await completesWithin(Promise.allSettled([...instances].map((i) => i.stop())), INSTANCE_STOP_GRACE_MS, aborted);
    }
    const closed = new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    // 已经在回话的连接等它写完（同一个期限内），其余的连接直接断开。
    await completesWithin(Promise.allSettled([...answering]), Math.max(0, until - Date.now()), aborted);
    for (const sock of connections) sock.destroy();
    await closed;
    removeOwnPidFile(pidFile);
    log.close();
  };

  let stopped: Promise<void> | undefined;
  return {
    stop: () => (stopped ??= shutdown()),
    abort: () => { abortNow(); return (stopped ??= shutdown()); },
  };
}
