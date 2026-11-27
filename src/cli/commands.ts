import { closeSync, constants, fchmodSync, openSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { MAX_CASE_BYTES, buildCase, parseCase, readCaseFile } from '../cases/case.ts';
import { findRun } from '../cases/find-run.ts';
import { runCase } from '../cases/run-case.ts';
import type { RunOptions, RunOutcome } from '../cases/run-case.ts';
import type { Driver } from '../driver/types.ts';
import { inspectRules } from '../kernel/rules.ts';
import type { StatusResult } from '../kernel/server.ts';
import { call } from '../shared/client.ts';
import { E2kError } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import type { Home } from '../shared/paths.ts';
import { ExitCode, MAX_OPS_BYTES, exitCodeFor, validateParams } from '../shared/protocol.ts';
import type { CloseResult, Method, OpenResult, StepResult } from '../shared/protocol.ts';
import { redactText, safely } from '../shared/redact.ts';
import { runDoctor } from './doctor.ts';
import type { RuleListResult } from './format.ts';

// 命令的「校验 → 发送 → 结果」：CLI 和 MCP 壳共用，返回 { exit, result } 或 { exit, error }，各自打印。
// 发给内核的命令（open、step、close、status）的 raw 是还没校验的参数，先过和内核同一套 validateParams。

export type CommandOutcome =
  | { exit: number; result: unknown }
  | { exit: number; error: { code: ErrorCode; message: string; next?: string } };

function usage(message: string): E2kError {
  return new E2kError('usage', message);
}

function malformed(): E2kError {
  return new E2kError('internal', '内核的回应格式不对');
}

// 等人批准时重试用的时钟：缺省是真的时间，测试注入假的。
export const realClock = { now: (): number => Date.now(), sleep: (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); }) };

export type Send = (method: Method, params: unknown) => Promise<unknown>;

// 发给内核。内核没在跑时补上启动命令；内核回的错误原样往上抛（code、message、next 都不改）。
export function makeSend(home: Home, selfCmd: string): Send {
  return async (method, params) => {
    let r;
    try {
      r = await call(home, method, params);
    } catch (e) {
      if (e instanceof E2kError && e.code === 'needs-human' && e.next === undefined) {
        throw new E2kError(e.code, e.message, `运行 ${selfCmd} start（前台运行，可以放到后台）`);
      }
      throw e;
    }
    if (!r.ok) throw new E2kError(r.error.code, r.error.message, r.error.next);
    return r.result;
  };
}

// dir 是不是 root 本身或在它之内：从 dir 沿父目录往上逐级比 dev + ino，不比路径字符串
// （大小写不敏感的卷上 realpath 不规范化大小写，字符串比较能被 H2 / h2 这样的写法绕过）。
// root 不存在（取不到 ino）时退回按小写比路径字符串。
function isInsideOrSame(root: string, dir: string): boolean {
  let rootStat: Stats | null = null;
  try {
    rootStat = statSync(root);
  } catch {
    rootStat = null;
  }
  const rootLower = resolve(root).toLowerCase();
  let cur = dir;
  for (;;) {
    if (rootStat !== null) {
      try {
        const st = statSync(cur);
        if (st.dev === rootStat.dev && st.ino === rootStat.ino) return true;
      } catch { /* 这一级读不了：继续往上 */ }
    } else if (cur.toLowerCase() === rootLower) {
      return true;
    }
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

// --out：必须是 .json，所在目录要存在，而且按真实路径不能在状态目录（$E2K_HOME）之内（也不能经符号链接绕进去）。
// 返回要写的真实路径（父目录取真实路径，减少检查和写之间被换掉的余地）。
function checkOut(home: Home, out: unknown): string {
  if (typeof out !== 'string' || out === '' || out.length > 4096 || out.includes('\0')) throw usage('--out 要给一个文件路径');
  const abs = resolve(out);
  if (!abs.endsWith('.json') || basename(abs) === '.json') throw usage('--out 要写成 .json 结尾的文件名');
  let realParent: string;
  try {
    realParent = realpathSync(dirname(abs));
  } catch {
    throw usage('--out 所在的目录不存在');
  }
  if (isInsideOrSame(home.root, realParent)) throw usage('--out 不能放在状态目录里，请换一个位置');
  return join(realParent, basename(abs));
}

function writeNew(path: string, text: string): void {
  let fd: number;
  try {
    // O_EXCL：已存在就失败，不覆盖；O_NOFOLLOW：最后一段是符号链接也不跟（和 O_EXCL 一起时符号链接按「已存在」失败）。
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ELOOP') throw usage('--out 的文件已存在（或是符号链接），不覆盖');
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'EACCES' || code === 'EPERM') throw usage('--out 写不了：目录不存在或没有权限');
    throw e;
  }
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
  } catch (e) {
    closeSync(fd);
    fd = -1;
    try { rmSync(path, { force: true }); } catch { /* 清理失败不盖过原来的错误 */ }
    throw e;
  } finally {
    if (fd !== -1) closeSync(fd);
  }
}

function toOutcome(e: unknown): CommandOutcome {
  if (!(e instanceof E2kError)) throw e;
  return { exit: exitCodeFor(e.code), error: e.next === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, next: e.next } };
}

// save-case：读已 close 的会话的 result.json（已脱敏），导出可重放的用例到 --out。
export function saveCase(home: Home, p: { session: string; out: string; steps?: number[] }): CommandOutcome {
  try {
    const path = checkOut(home, p.out);
    const c = buildCase(findRun(home, p.session).result, p.steps === undefined ? {} : { steps: p.steps });
    const text = `${JSON.stringify(c, null, 2)}\n`;
    // 两格缩进会比紧凑写法大一些：写出去的必须仍在上限内、仍被 parseCase 认。
    if (Buffer.byteLength(text, 'utf8') > MAX_CASE_BYTES) throw usage('导出的用例超过大小上限，请用 --steps 只选一部分');
    parseCase(text);
    writeNew(path, text);
    return { exit: 0, result: { path, steps: c.steps.length, skipped: c.steps.filter((s) => s.skip !== undefined).length, containsWrites: c.containsWrites } };
  } catch (e) {
    return toOutcome(e);
  }
}

// run：读用例文件（不对就在开会话之前拒绝），再用 open / step / close 重放。没开成会话就出错的，按错误返回；
// 开了会话的（含中途出错、已 close 的）返回结果，错误放在 result.error 里，退出码是 outcome.exit。
export async function runCaseFile(send: (method: Method, params: unknown) => Promise<unknown>, path: string, o: RunOptions): Promise<CommandOutcome> {
  try {
    const outcome: RunOutcome = await runCase(send, readCaseFile(path), o);
    if (outcome.session === null && outcome.error !== null) return { exit: outcome.exit, error: outcome.error };
    return { exit: outcome.exit, result: { session: outcome.session, reportPath: outcome.reportPath, verdict: outcome.verdict, skipped: outcome.skipped, tallies: outcome.tallies, error: outcome.error } };
  } catch (e) {
    return toOutcome(e);
  }
}

// 解析错误会带上文件里的未知键名，和主机写法一样先脱敏。
export function redactError(error: string | null): string | null {
  return error === null ? null : safely(() => redactText(error));
}

export async function kernelStatus(send: Send): Promise<CommandOutcome> {
  try {
    const params = validateParams('status', {});
    return { exit: ExitCode.OK, result: await send('status', params) as StatusResult };
  } catch (e) {
    return toOutcome(e);
  }
}

export async function openSession(send: Send, raw: unknown): Promise<CommandOutcome> {
  try {
    const params = validateParams('open', raw);
    const result = await send('open', params) as OpenResult;
    // 身份不符优先：会话开着，但账号不对，要人处理（22）；有密码框的页面也会先计数、再探身份，所以 blocked:'login' 和 identity:'mismatch' 可能同时出现，这时 22 优先。
    if (result.identity === 'mismatch') return { exit: ExitCode.NEEDS_HUMAN, result };
    return { exit: result.blocked === 'login' ? ExitCode.WAIT_LOGIN : ExitCode.OK, result };
  } catch (e) {
    return toOutcome(e);
  }
}

export async function stepOps(send: Send, raw: unknown): Promise<CommandOutcome> {
  try {
    // CLI 在解析前就按文本长度拦过；MCP 来的是已解析的值，这里按重新序列化后的长度拦：超长的一律当用法错误，什么都不发。
    const ops = typeof raw === 'object' && raw !== null ? (raw as { ops?: unknown }).ops : undefined;
    if (Array.isArray(ops) && Buffer.byteLength(JSON.stringify(ops), 'utf8') > MAX_OPS_BYTES) throw usage(`操作的 JSON 最多 ${MAX_OPS_BYTES} 字节`);
    const params = validateParams('step', raw);
    const result = await send('step', params) as StepResult;
    if (result.exit !== 0 && result.exit !== 10 && result.exit !== 11 && result.exit !== 20) throw malformed();
    return { exit: result.exit, result };
  } catch (e) {
    return toOutcome(e);
  }
}

export async function closeSession(send: Send, raw: unknown): Promise<CommandOutcome> {
  try {
    const params = validateParams('close', raw);
    const result = await send('close', params) as CloseResult;
    if (result.exit !== 0 && result.exit !== 10) throw malformed();
    return { exit: result.exit, result };
  } catch (e) {
    return toOutcome(e);
  }
}

// doctor：自检；有一项不过就是 22。驱动在这里才建（建不出来是内部错误，CLI 和 MCP 各按自己的办法报）。
export async function doctorChecks(home: Home, makeDriver: () => Promise<Driver>, selfCmd: string, managerName?: () => Promise<string | null>): Promise<CommandOutcome> {
  try {
    const checks = await runDoctor(home, await makeDriver(), selfCmd, managerName);
    return { exit: checks.every((c) => c.ok) ? ExitCode.OK : ExitCode.NEEDS_HUMAN, result: checks };
  } catch (e) {
    return toOutcome(e);
  }
}

// rule list：规则文件和批准记录自己读，不需要内核。文件有错：照样给结果（error 字段），退出码 2。
export function listRules(home: Home): CommandOutcome {
  const r = inspectRules(home.rulesFile, home.approvalsFile);
  const f = r.file;
  const approvedRule = (x: { match: string; mode: string }): boolean => r.approvedRules.rules.some((a) => a.match === x.match && a.mode === x.mode);
  const approvedGroup = (g: (typeof f.groups)[number]): boolean => {
    const a = r.approvedRules.groups.find((y) => y.name === g.name);
    return a !== undefined && JSON.stringify(a) === JSON.stringify(g);
  };
  // 主机写法进输出前和别的命令一样先脱敏。
  const result: RuleListResult = {
    path: home.rulesFile,
    rules: f.rules.map((x) => ({ match: redactText(x.match), mode: x.mode, approved: approvedRule(x) })),
    loginHosts: f.loginHosts.map((x) => redactText(x)),
    groups: f.groups.map((g) => ({
      name: g.name, hosts: g.hosts.map((x) => redactText(x)), loginHosts: g.loginHosts.map((x) => redactText(x)),
      readPosts: g.readPosts.length, persistedQueries: g.persistedQueries.length, logout: g.logout.length, identity: g.identity !== null,
      approved: approvedGroup(g),
    })),
    hostModes: Object.entries(r.hostModes).map(([host, mode]) => ({ host: redactText(host), mode })),
    writes: Object.entries(r.writes).flatMap(([scope, ds]) => ds.map((d) => ({ scope: redactText(scope), method: d.method, url: redactText(d.url), operation: d.operation === null ? null : redactText(d.operation) }))),
    hash: f.hash, error: redactError(f.error),
    approved: f.error === null && !r.pending && r.approvals !== 'unreadable', pending: r.pending, approvals: r.approvals,
  };
  return { exit: f.error === null ? ExitCode.OK : ExitCode.USAGE, result };
}
