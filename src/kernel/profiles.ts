import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, resolveInside } from '../shared/paths.ts';
import type { Home } from '../shared/paths.ts';

// 浏览器 profile 的状态，和最近一次用 `login` 登录的记录。
// 「是否登录过」只看记录文件：会话窗口里手动登录，或 profile 里有别的内容，都不会让 state 变成「登录过」。

export const DEFAULT_PROFILE = 'default';

// 只表达浏览器有没有用过这个目录：目录不存在 / 存在但没有子项 / 有子项。
export type ProfileState = 'missing' | 'never-launched' | 'launched';
export interface LastLogin { at: string; host: string }
export interface ProfileInfo { name: string; state: ProfileState; lastLogin: LastLogin | null }

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_RECORD_BYTES = 4096;
const MAX_HOST_LENGTH = 253;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// URL.hostname 的输出：小写 ASCII 的域名或 IPv4（国际化域名已是 punycode），或带方括号的 IPv6。字符类和前面的字符不重叠，线性匹配。
const HOST_RE = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])$/;

function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error('invalid profile name');
}

function validHost(host: unknown): host is string {
  return typeof host === 'string' && host.length <= MAX_HOST_LENGTH && HOST_RE.test(host);
}

function validAt(at: unknown): at is string {
  if (typeof at !== 'string' || !AT_RE.test(at)) return false;
  const t = new Date(at);
  return !Number.isNaN(t.getTime()) && t.toISOString() === at;
}

function loginFile(home: Home, name: string): string {
  return join(home.profilesDir, `${name}.login.json`);
}

// 记录文件按「不信任」读：不跟符号链接、必须是小的普通文件、形状严格；任何问题都当没有记录。
function readLastLogin(file: string): LastLogin | null {
  let fd: number | undefined;
  try {
    // O_NONBLOCK：记录位置被换成 FIFO 时 open 不会永久阻塞；随后的 isFile() 把它拒掉。
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    const v: unknown = JSON.parse(buf.subarray(0, got).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const keys = Object.keys(v).sort();
    if (keys.join(',') !== 'at,host,schema') return null;
    const r = v as Record<string, unknown>;
    if (r.schema !== 1 || !validAt(r.at) || !validHost(r.host)) return null;
    return { at: r.at, host: r.host };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// 只读：不建目录、不写文件。拿不准的情况（路径不是真目录、读不了）报 launched，不说「从没启动过」。
export function profileInfo(home: Home, name: string): ProfileInfo {
  checkName(name);
  let state: ProfileState;
  let lastLogin: LastLogin | null = null;
  try {
    const base = lstatSync(home.profilesDir);
    if (!base.isDirectory() || base.isSymbolicLink()) return { name, state: 'launched', lastLogin: null };
    lastLogin = readLastLogin(loginFile(home, name));
    const dir = join(home.profilesDir, name);
    const st = lstatSync(dir);
    state = !st.isDirectory() || st.isSymbolicLink() || readdirSync(dir).length > 0 ? 'launched' : 'never-launched';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    state = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'launched';
  }
  return { name, state, lastLogin };
}

// 记一次 login。文件放在 profile 目录旁边，不在 Chromium 的 user data 目录里；0600，不跟符号链接。
export function recordLogin(home: Home, name: string, at: Date, host: string): void {
  checkName(name);
  if (!validHost(host)) throw new Error('invalid host for the login record');
  ensurePrivateDir(home.profilesDir);
  const path = resolveInside(home.profilesDir, `${name}.login.json`);
  const content = `${JSON.stringify({ schema: 1, at: at.toISOString(), host })}\n`;
  // O_NOFOLLOW：目标是符号链接就失败，不顺着写出去。O_NONBLOCK：目标是没人读的 FIFO 时得到 ENXIO，不会永久阻塞。
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
