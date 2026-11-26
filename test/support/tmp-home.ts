import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSocketPathFits, resolveHome } from '../../src/shared/paths.ts';
import type { Home } from '../../src/shared/paths.ts';

// 系统临时目录下的一个 0700 目录当 E2K_HOME。目录名保持很短：socket 路径有 103 字节上限。
// 取真实路径（macOS 的临时目录经过符号链接），方便测试直接比较路径。
export function makeTmpHome(): { home: Home; env: NodeJS.ProcessEnv; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2k-')));
  chmodSync(root, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env, E2K_HOME: root };
  const home = resolveHome(env);
  assertSocketPathFits(home.socket);
  return { home, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
