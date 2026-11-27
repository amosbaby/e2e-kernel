import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { E2kError } from '../shared/errors.ts';
import { ensurePrivateDir, resolveInside } from '../shared/paths.ts';
import type { Home } from '../shared/paths.ts';

// 浏览器 profile 的状态，和最近一次用 `login` 登录的记录。
// 「是否登录过」只看记录文件：会话窗口里手动登录，或 profile 里有别的内容，都不会让 state 变成「登录过」。

export const DEFAULT_PROFILE = 'default';

// 只表达浏览器有没有用过这个目录：目录不存在 / 存在但没有子项 / 有子项。
export type ProfileState = 'missing' | 'never-launched' | 'launched';
export interface LastLogin { at: string; host: string }
export interface ProfileInfo { name: string; state: ProfileState; lastLogin: LastLogin | null }

// 组名、槽名只收小写（macOS 默认不分大小写，大小写不同的两个名字会落到同一个目录）。key 是 `组` 或 `组@槽`，也是 profiles 下的目录名。
const PART_RE = /^[a-z0-9_-]{1,32}$/;
const NAME_RE = /^[a-z0-9_-]{1,32}(@[a-z0-9_-]{1,32})?$/;
const MAX_RECORD_BYTES = 4096;
const MAX_HOST_LENGTH = 253;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// URL.hostname 的输出：小写 ASCII 的域名或 IPv4（国际化域名已是 punycode），或带方括号的 IPv6。字符类和前面的字符不重叠，线性匹配。
const HOST_RE = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])$/;

// 一个 profile 的引用：组，加可选的槽（同一个组开多个并行实例时用）。
export interface ProfileRef { group: string; slot: string | null }

function usageProfile(): E2kError {
  return new E2kError('usage', 'profile must be <group> or <group>/<slot>: lowercase letters, digits, "_" and "-", 1 to 32 characters each');
}

// key：`组` 或 `组@槽`。两段都要合规，否则 usage。
export function profileKey(r: ProfileRef): string {
  if (!PART_RE.test(r.group) || (r.slot !== null && !PART_RE.test(r.slot))) throw usageProfile();
  return r.slot === null ? r.group : `${r.group}@${r.slot}`;
}

// 命令行写法：`组` 或 `组/槽`。
export function parseProfileArg(s: string): ProfileRef {
  const parts = s.split('/');
  const [group, slot] = parts;
  if (parts.length > 2 || group === undefined || !PART_RE.test(group) || (slot !== undefined && !PART_RE.test(slot))) throw usageProfile();
  return { group, slot: slot ?? null };
}

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

// 启动前准备 profile 的 user data 目录并返回路径：名字合规；profiles 目录和 profile 目录不存在就建成 0700（已存在的要是真目录、
// 属于当前用户、没有组和其他人的权限）；profile 目录是符号链接或不是目录，一律 needs-human，不启动。
// 路径严格在 profiles 之内（resolveInside 再按真实路径查一遍）。
export function prepareProfileDir(home: Home, key: string): string {
  if (!NAME_RE.test(key)) throw usageProfile();
  ensurePrivateDir(home.profilesDir);
  const raw = join(home.profilesDir, key);
  let bad = false;
  try {
    const st = lstatSync(raw);
    bad = st.isSymbolicLink() || !st.isDirectory();
  } catch (e) {
    bad = (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  if (bad) {
    throw new E2kError('needs-human', 'profile 目录不对', '检查 $E2K_HOME/profiles 下这个 profile 的目录：必须是真目录，不能是符号链接或文件');
  }
  const dir = resolveInside(home.profilesDir, key);
  ensurePrivateDir(dir);
  return dir;
}

// 所有 profile：`default` 在前（目录在不在都列），再是 profiles 下名字合规的真目录，按名字排序。
// 只读，不建目录；符号链接、普通文件、名字不合规的一律跳过，也不跟进去。
export function listProfiles(home: Home): ProfileInfo[] {
  const names: string[] = [];
  try {
    const base = lstatSync(home.profilesDir);
    if (base.isDirectory() && !base.isSymbolicLink()) {
      for (const n of readdirSync(home.profilesDir)) {
        if (n === DEFAULT_PROFILE || !NAME_RE.test(n)) continue;
        try {
          const st = lstatSync(join(home.profilesDir, n));
          if (st.isDirectory() && !st.isSymbolicLink()) names.push(n);
        } catch {
          // 列目录和 lstat 之间被删了：不列。
        }
      }
    }
  } catch {
    // 目录不存在或读不了：只有 default。
  }
  return [DEFAULT_PROFILE, ...names.sort()].map((n) => profileInfo(home, n));
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
