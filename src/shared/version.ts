import { readFileSync } from 'node:fs';

// 相对 import.meta.url 解析，这样从 src/ 和 dist/ 运行都能找到仓库根的 package.json。
const packageJsonUrl = new URL('../../package.json', import.meta.url);

export function kernelVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error('package.json has no string "version" field');
  }
  return parsed.version;
}
