import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { E2kError } from '../shared/errors.ts';
import type { Home } from '../shared/paths.ts';
import { resolveInside } from '../shared/paths.ts';
import { SESSION_ID } from '../shared/protocol.ts';
import { isObject } from '../shared/validate.ts';
import { RUN_DIR_RE } from '../report/store.ts';

// 按会话 id 找已 close 的会话的记录（R10）。会话 id 会在历史里撞号：取目录名（时间戳在前）最新的那个 `*-<id>`，
// 不管它有没有 result.json；没有 result.json 就是会话还没 close。

const MAX_RESULT_BYTES = 20 * 1024 * 1024;

function usage(message: string): E2kError {
  return new E2kError('usage', message);
}

function notClosed(): E2kError {
  return usage('会话要先 close（这个会话还没有 result.json）');
}

// 读 <dir>/result.json：不跟符号链接，必须是普通文件，最多 20 MB。报错不带路径和内容。
export function readResult(dir: string): unknown {
  let fd: number;
  try {
    fd = openSync(resolveInside(dir, 'result.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (e instanceof E2kError) throw usage('记录不是普通文件');
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw notClosed();
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'EACCES' || code === 'EPERM') throw usage('记录不是普通文件，或没有权限读');
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw usage('记录不是普通文件');
    if (st.size > MAX_RESULT_BYTES) throw usage('记录太大，不能导出');
    const text = readFileSync(fd, 'utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw usage('记录不是合法的 JSON');
    }
  } finally {
    closeSync(fd);
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    return [];
  }
}

function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// 内核落盘在 runs/<会话名>/<时间戳>-<id>/：遍历每个会话名目录（符号链接的忽略），把所有名下的候选合起来按目录名（时间戳在前）取最新的。
// 返回目录和已读出的 result.json（调用方不必再读一遍）。
export function findRun(home: Home, session: string): { dir: string; result: Record<string, unknown> } {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) throw usage('会话 id 的格式不对');
  const suffix = `-${session}`;
  const candidates: { name: string; dir: string }[] = [];
  for (const nameEntry of listDir(home.runsDir)) {
    let nameDir: string;
    try {
      nameDir = resolveInside(home.runsDir, nameEntry);
    } catch {
      continue;
    }
    if (!isRealDir(nameDir)) continue;
    for (const entry of listDir(nameDir)) {
      if (RUN_DIR_RE.test(entry) && entry.endsWith(suffix)) candidates.push({ name: entry, dir: join(nameDir, entry) });
    }
  }
  const newest = candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).pop();
  if (newest === undefined) throw usage('没有这个会话的记录');
  if (!isRealDir(newest.dir)) throw usage('这个会话的记录目录不对');
  const result = readResult(newest.dir);
  if (!isObject(result) || result.session !== session) throw usage('记录里的会话 id 和目录对不上');
  return { dir: newest.dir, result };
}

export function findRunDir(home: Home, session: string): string {
  return findRun(home, session).dir;
}
