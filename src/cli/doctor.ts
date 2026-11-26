import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, Driver } from '../driver/types.ts';
import type { StatusResult } from '../kernel/server.ts';
import { call } from '../shared/client.ts';
import { PROFILE_STATE_TEXT, lastLoginText } from './format.ts';
import { DEFAULT_PROFILE, profileInfo } from '../kernel/profiles.ts';
import { E2kError } from '../shared/errors.ts';
import { assertSocketPathFits, ensurePrivateDir } from '../shared/paths.ts';
import type { Home } from '../shared/paths.ts';
import { kernelVersion } from '../shared/version.ts';

// e2k doctor 的自检项。每项只读不改：状态目录不存在时不替人建。

const MIN_NODE: readonly [number, number, number] = [24, 12, 0];

function nodeVersionCheck(): Check {
  const have = process.versions.node;
  const [a = 0, b = 0, c = 0] = have.split('.').map((x) => Number.parseInt(x, 10));
  const ok = a !== MIN_NODE[0] ? a > MIN_NODE[0] : b !== MIN_NODE[1] ? b > MIN_NODE[1] : c >= MIN_NODE[2];
  const need = MIN_NODE.join('.');
  return ok
    ? { name: 'node-version', ok, detail: `Node ${have}` }
    : { name: 'node-version', ok, detail: `Node ${have}，需要 ≥ ${need}`, fix: `安装 Node ${need} 或更新的版本` };
}

function platformCheck(): Check {
  return { name: 'platform', ok: true, detail: process.platform === 'darwin' ? 'darwin' : `${process.platform}：v1 只在 macOS 上验证` };
}

// 把 E2kError 变成一条失败的检查；别的异常照常抛。
function failed(name: string, e: unknown): Check {
  if (!(e instanceof E2kError)) throw e;
  return e.next === undefined ? { name, ok: false, detail: e.message } : { name, ok: false, detail: e.message, fix: e.next };
}

function homeCheck(home: Home): Check {
  const name = 'home-permissions';
  try {
    lstatSync(home.root);
  } catch {
    return { name, ok: true, detail: `${home.root} 还不存在，start 时会建成 0700` };
  }
  try {
    ensurePrivateDir(home.root);   // 目录已存在：只检查，不改
    return { name, ok: true, detail: `${home.root} 是 0700` };
  } catch (e) {
    return failed(name, e);
  }
}

function socketCheck(home: Home): Check {
  const name = 'socket-path-length';
  try {
    assertSocketPathFits(home.socket);
    return { name, ok: true, detail: `${Buffer.byteLength(home.socket, 'utf8')} 字节` };
  } catch (e) {
    return failed(name, e);
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// profile 的状态和最近一次 login。只查不建；「没 login 过」不算失败（R7）：fresh home 上这一项是 ok。
// ok 只在 profiles 目录或 profile 目录已存在、却不满足状态目录的权限规则时为 false。
function profileCheck(home: Home): Check {
  const name = `profile-${DEFAULT_PROFILE}`;
  const profileDir = join(home.profilesDir, DEFAULT_PROFILE);
  try {
    for (const dir of [home.profilesDir, profileDir]) if (exists(dir)) ensurePrivateDir(dir);   // 已存在：只检查，不改
  } catch (e) {
    return failed(name, e);
  }
  const info = profileInfo(home, DEFAULT_PROFILE);
  const login = info.lastLogin === null
    ? '从没用 login 登录过（会话窗口里手动登录不会记在这里）'
    : `最近一次 login ${lastLoginText(info)}`;
  return { name, ok: true, detail: `profiles/${DEFAULT_PROFILE} ${PROFILE_STATE_TEXT[info.state]}；${login}` };
}

async function kernelChecks(home: Home, selfCmd: string): Promise<Check[]> {
  let status: StatusResult;
  try {
    const r = await call(home, 'status', {});
    if (!r.ok) {
      return [{ name: 'kernel-running', ok: false, detail: r.error.message },
        { name: 'kernel-version', ok: true, detail: '内核状态读不到，跳过' }];
    }
    status = r.result as StatusResult;
  } catch (e) {
    const running: Check = e instanceof E2kError && e.code === 'needs-human'
      ? { name: 'kernel-running', ok: false, detail: e.message, fix: `${selfCmd} start` }
      : failed('kernel-running', e);
    return [running, { name: 'kernel-version', ok: true, detail: '内核没在跑，跳过' }];
  }
  const mine = kernelVersion();
  return [
    { name: 'kernel-running', ok: true, detail: `pid ${status.pid}` },
    status.version === mine
      ? { name: 'kernel-version', ok: true, detail: status.version }
      : { name: 'kernel-version', ok: false, detail: `内核 ${status.version}，CLI ${mine}`, fix: `停掉内核后重新运行 ${selfCmd} start` },
  ];
}

// selfCmd：这个 CLI 实际该怎么调用，写进 fix 里。
export async function runDoctor(home: Home, driver: Driver, selfCmd = 'e2k'): Promise<Check[]> {
  return [
    nodeVersionCheck(),
    platformCheck(),
    homeCheck(home),
    socketCheck(home),
    profileCheck(home),
    ...await driver.selfCheck(),
    ...await kernelChecks(home, selfCmd),
  ];
}
