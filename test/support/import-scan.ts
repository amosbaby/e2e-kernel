import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 驱动边界测试用：读源码、查导入、查字面子串。只在测试里用。

export interface SourceFile { path: string; text: string }

// 递归读 dir 下所有 .ts 和 .js；path 是 join(dir, 相对路径)，所以总以传入的 dir 开头。
export function readSources(dir: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const rel of readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()) {
    if (!/\.(?:ts|js)$/.test(rel)) continue;
    const path = join(dir, rel);
    if (!statSync(path).isFile()) continue;
    out.push({ path, text: readFileSync(path, 'utf8') });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

// 导入了 pkg 或 pkg/子路径 的文件路径：from '<pkg>'、import '<pkg>'、import('<pkg>')、require('<pkg>')，单双引号都算。
// 相对路径不会匹配，因为引号后面必须直接是包名。
export function importsOf(files: readonly SourceFile[], pkg: string): string[] {
  const re = new RegExp(`\\b(?:from|import|require)\\s*\\(?\\s*(['"])${escapeRegExp(pkg)}(?:/[^'"]*)?\\1`);
  return files.filter(f => re.test(f.text)).map(f => f.path);
}

// 字面子串匹配，注释里出现也算。
export function mentions(files: readonly SourceFile[], needle: string): string[] {
  return files.filter(f => f.text.includes(needle)).map(f => f.path);
}
