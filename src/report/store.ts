import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { E2kError } from '../shared/errors.ts';
import { ensurePrivateDir, resolveInside } from '../shared/paths.ts';
import { KERNEL_SKIP_KEYS } from '../shared/protocol.ts';
import { REDACTED, redactDeep, redactUrl } from '../shared/redact.ts';
import { renderReport } from './html.ts';
import type { RunResult } from './result.ts';

// 报告目录和落盘（设计 5.3、5.7）。目录 0700，文件 0600。

export const RUN_DIR_RE = /^\d{8}-\d{6}-s-[0-9a-f]{6}$/;
const SESSION_ID = /^s-[0-9a-f]{6}$/;

// 'YYYYMMDD-HHMMSS-<会话 id>'，时间用 UTC。
export function runDirName(at: Date, session: string): string {
  if (!SESSION_ID.test(session)) throw new E2kError('usage', 'session id has an invalid format');
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `${stamp}-${session}`;
}

const FALLBACK_REPORT = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>e2e 报告</title></head>'
  + '<body><p>报告页无法生成：部分内容脱敏失败，已整体隐去。完整的结构化结果见 result.json。</p></body></html>\n';

// 落盘比回应多脱敏一层：选择器（target、given、selector）也过脱敏规则。agent 可能把 token、邮箱写进选择器，
// 内核生成的稳定选择器也带页面文字。重放要的原样选择器只在给 agent 的回应里有。
const SELECTOR_KEYS: ReadonlySet<string> = new Set(['target', 'given', 'selector']);
const DISK_SKIP_KEYS: readonly string[] = KERNEL_SKIP_KEYS.filter((k) => !SELECTOR_KEYS.has(k));

// 失败关闭：任何一个顶层字段脱敏出错，这个字段整个换成固定标记，绝不退回去写原值。
function sanitize(r: RunResult): RunResult {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(r)) {
    try {
      out[key] = (redactDeep({ [key]: (r as unknown as Record<string, unknown>)[key] }, { skipKeys: DISK_SKIP_KEYS }) as Record<string, unknown>)[key];
    } catch {
      out[key] = REDACTED;
    }
  }
  const sanitized = out as unknown as RunResult;
  // URL 比普通文本多一道：片段里的参数、用户信息。
  if (typeof sanitized.start === 'object' && sanitized.start !== null) {
    let url: string;
    try {
      url = redactUrl(r.start.url);
    } catch {
      url = REDACTED;
    }
    sanitized.start = { ...sanitized.start, url };
  }
  return sanitized;
}

function writePrivateFile(runDir: string, file: string, content: string): string {
  const path = resolveInside(runDir, file);
  // O_NOFOLLOW：目标是符号链接就失败，不顺着写出去。
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return path;
}

// result.json 和 report.html 都用脱敏后的结果写。
export function writeRun(runDir: string, r: RunResult): { reportPath: string; resultPath: string } {
  const safe = sanitize(r);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  ensurePrivateDir(runDir);
  const resultPath = writePrivateFile(runDir, 'result.json', `${JSON.stringify(safe, null, 2)}\n`);
  let html: string;
  try {
    html = renderReport(safe);
  } catch {
    // 字段被换成标记后形状不对，页面渲染不了：给一页固定内容，不退回去用原值。
    html = FALLBACK_REPORT;
  }
  const reportPath = writePrivateFile(runDir, 'report.html', html);
  return { reportPath, resultPath };
}

// lstat：符号链接不算目录。检查和删除之间被人挪走的，当作不存在。
function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

// 只看 nameDir 直接子项里名字合规的真实目录（符号链接、普通文件、别的名字都不碰）。
// 按名字排序，最新的 keep 个留下，其余删除；exclude 里的名字（正在用的）永远不删，即使它是最老的。
export function pruneRuns(nameDir: string, keep: number, exclude: ReadonlySet<string>): string[] {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new E2kError('usage', 'keep must be a non-negative integer');
  let names: string[];
  try {
    names = readdirSync(nameDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const runs = names.filter((n) => RUN_DIR_RE.test(n) && isRealDir(join(nameDir, n))).sort();
  const removed: string[] = [];
  for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
    if (exclude.has(name)) continue;
    rmSync(resolveInside(nameDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
