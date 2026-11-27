import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { E2kError } from './errors.ts';

export interface Home { root: string; socket: string; pidFile: string; logFile: string; rulesFile: string; approvalsFile: string; profilesDir: string; runsDir: string }

// macOS 的 sockaddr_un.sun_path 是 104 字节，含结尾的 NUL，所以路径本身最多 103 字节。
const MAX_SOCKET_PATH_BYTES = 103;

export function resolveHome(env: NodeJS.ProcessEnv): Home {
  const configured = env.E2K_HOME;
  let root: string;
  if (configured === undefined) {
    root = join(homedir(), '.e2e-kernel');
  } else {
    if (!isAbsolute(configured) || configured.includes('\0')) {
      throw new E2kError('usage', 'E2K_HOME must be an absolute path', 'unset E2K_HOME or set it to an absolute path');
    }
    root = resolve(configured);
  }
  return {
    root,
    socket: join(root, 'kernel.sock'),
    pidFile: join(root, 'kernel.pid'),
    logFile: join(root, 'kernel.log'),
    rulesFile: join(root, 'rules.json'),
    approvalsFile: join(root, 'approvals.json'),
    profilesDir: join(root, 'profiles'),
    runsDir: join(root, 'runs'),
  };
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

// 状态目录：不存在就建成 0700；已存在的必须是真目录（不是符号链接）、属于当前用户、组和其他人没有任何权限位。
export function ensurePrivateDir(dir: string): void {
  if (lstatOrNull(dir) === null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir 的 mode 会被 umask 削掉位，这里显式设回 0700。
    chmodSync(dir, 0o700);
  }
  const st = lstatOrNull(dir);
  const uid = process.getuid?.();
  const ok = st !== null && st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0;
  if (!ok) {
    throw new E2kError(
      'needs-human',
      `${dir} must be a real directory owned by the current user with no access for group or others (mode 0700)`,
      `check it by hand, then fix it (for example chmod 700 on it) or point E2K_HOME at another directory`,
    );
  }
}

function isStrictlyInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function escapes(): E2kError {
  return new E2kError('usage', 'path must stay inside its allowed directory');
}

// 把 segments 拼到 base 下，结果必须严格在 base 之内（不能等于 base）。
// 先按字面规范化检查；再把路径上已存在的部分按真实路径检查，挡住指向外面的符号链接和悬空链接。
export function resolveInside(base: string, ...segments: string[]): string {
  const root = resolve(base);
  for (const s of segments) {
    if (s.includes('\0') || isAbsolute(s)) throw escapes();
  }
  const target = resolve(root, ...segments);
  if (!isStrictlyInside(root, target)) throw escapes();

  // 找到 target 最深的已存在部分（lstat 能看到的，包括悬空链接本身）。
  let existing = target;
  while (existing !== root && lstatOrNull(existing) === null) existing = dirname(existing);
  if (existing === root) return target;

  let realBase: string;
  let realExisting: string;
  try {
    realBase = realpathSync(root);
    realExisting = realpathSync(existing);
  } catch {
    throw escapes(); // 悬空链接，或路径在检查途中变了
  }
  const realTarget = join(realExisting, relative(existing, target));
  if (!isStrictlyInside(realBase, realTarget)) throw escapes();
  return target;
}

export function assertSocketPathFits(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new E2kError(
      'needs-human',
      `socket path is ${bytes} bytes; macOS allows at most ${MAX_SOCKET_PATH_BYTES}`,
      'set E2K_HOME to a shorter absolute path',
    );
  }
}
