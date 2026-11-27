import { closeSync, constants, fchmodSync, openSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_CASE_BYTES, buildCase, parseCase } from '../cases/case.ts';
import { findRunDir, readResult } from '../cases/find-run.ts';
import { E2kError } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import type { Home } from '../shared/paths.ts';
import { exitCodeFor } from '../shared/protocol.ts';

// 在客户端做的命令（不经内核）：返回 { exit, result } 或 { exit, error }，CLI 和 MCP 壳各自打印。

export type CommandOutcome =
  | { exit: number; result: unknown }
  | { exit: number; error: { code: ErrorCode; message: string; next?: string } };

function usage(message: string): E2kError {
  return new E2kError('usage', message);
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
  let realRoot: string | null = null;
  try {
    realRoot = realpathSync(home.root);
  } catch {
    realRoot = null;   // 状态目录不存在：自然不在里面
  }
  if (realRoot !== null) {
    const rel = relative(realRoot, realParent);
    if (rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw usage('--out 不能放在状态目录里，请换一个位置');
  }
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
    const run = readResult(findRunDir(home, p.session));
    const c = buildCase(run, p.steps === undefined ? {} : { steps: p.steps });
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
