import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importsOf, mentions, readSources } from '../support/import-scan.ts';
import type { SourceFile } from '../support/import-scan.ts';

test('importsOf recognises every import form', () => {
  const f = (text: string): SourceFile[] => [{ path: 'x.ts', text }];
  for (const text of [`import { chromium } from 'playwright';`, `import type { Page } from "playwright";`, `import "playwright";`,
    `const p = await import('playwright');`, `const p = require("playwright");`, `import x from 'playwright/test';`])
    assert.deepEqual(importsOf(f(text), 'playwright'), ['x.ts'], text);
  assert.deepEqual(importsOf(f(`import { x } from 'playwright-core';`), 'playwright-core'), ['x.ts']);
  for (const text of [`import { x } from './playwright-helpers.ts';`, `import { d } from '../drivers/playwright/driver.ts';`, `// playwright`])
    assert.deepEqual(importsOf(f(text), 'playwright'), [], text);
});

test('importsOf does not confuse a package with one that shares its prefix, and tolerates spacing and multi-line imports', () => {
  const f = (text: string): SourceFile[] => [{ path: 'x.ts', text }];
  assert.deepEqual(importsOf(f(`import { x } from 'playwright-core';`), 'playwright'), []);
  assert.deepEqual(importsOf(f(`import { x } from 'playwright-core/lib/x';`), 'playwright'), []);
  assert.deepEqual(importsOf(f(`import {\n  a,\n  b,\n} from\n  'playwright';`), 'playwright'), ['x.ts']);
  assert.deepEqual(importsOf(f(`const p = await import( "playwright" );`), 'playwright'), ['x.ts']);
  assert.deepEqual(importsOf(f(`import x from 'a.b';`), 'a.b'), ['x.ts']);
  assert.deepEqual(importsOf(f(`import x from 'aXb';`), 'a.b'), []);
});

test('importsOf lists each matching file once, in the order given', () => {
  const files: SourceFile[] = [
    { path: 'b.ts', text: `import 'playwright';\nimport 'playwright/test';` },
    { path: 'a.ts', text: `import 'playwright';` },
    { path: 'c.ts', text: `import 'other';` }];
  assert.deepEqual(importsOf(files, 'playwright'), ['b.ts', 'a.ts']);
});

test('mentions is a literal substring match', () => {
  const files: SourceFile[] = [{ path: 'a.ts', text: '// uses child_process' }, { path: 'b.ts', text: 'x' }];
  assert.deepEqual(mentions(files, 'child_process'), ['a.ts']);
  assert.deepEqual(mentions(files, 'a.b'), []);
  assert.deepEqual(mentions([{ path: 'c.ts', text: 'a.b' }], 'a.b'), ['c.ts']);
});

test('readSources returns .ts and .js files recursively, with paths that start with the directory given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2k-scan-'));
  try {
    mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'A');
    writeFileSync(join(dir, 'sub', 'b.js'), 'B');
    writeFileSync(join(dir, 'sub', 'deep', 'c.ts'), 'C');
    writeFileSync(join(dir, 'notes.md'), 'ignored');
    writeFileSync(join(dir, 'sub', 'data.json'), '{}');
    const got = readSources(dir).map(f => [f.path, f.text]).sort();
    assert.deepEqual(got, [[join(dir, 'a.ts'), 'A'], [join(dir, 'sub', 'b.js'), 'B'], [join(dir, 'sub', 'deep', 'c.ts'), 'C']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const src = readSources('src');
  assert.ok(src.length > 0);
  for (const f of src) assert.ok(f.path.startsWith('src/'), f.path);
  assert.ok(src.some(f => f.path === 'src/driver/types.ts'));
});

test('only src/drivers/playwright imports playwright or playwright-core', () => {
  const outside = readSources('src').filter(f => !f.path.startsWith('src/drivers/playwright/'));
  assert.deepEqual([...importsOf(outside, 'playwright'), ...importsOf(outside, 'playwright-core')], []);
  assert.deepEqual(importsOf([{ path: 'stable.ts', text: readFileSync('src/drivers/playwright/stable.ts', 'utf8') }], 'playwright'), []);
});

test('src uses neither page-exposed functions nor bringToFront, and child_process only where the kernel talks to the desktop or the driver starts its own browser', () => {
  const src = readSources('src');
  for (const needle of ['exposeFunction', 'exposeBinding', 'bringToFront']) assert.deepEqual(mentions(src, needle), [], needle);
  // 弹确认框要起 osascript（src/kernel/approval.ts）；驱动自己 spawn 浏览器（src/drivers/playwright/browser-process.ts，管道通信）；别的文件不得起子进程。
  assert.deepEqual(mentions(src, 'child_process').sort(), ['src/drivers/playwright/browser-process.ts', 'src/kernel/approval.ts']);
});

// 去掉行注释再查：说明文字里可以提这些名字，代码里不行。只认行首或空白后面的 //（字符串里的 http:// 和 '**/*' 不受影响）。
function stripLineComments(text: string): string {
  return text.replace(/(^|\s)\/\/.*$/gm, '$1');
}
function code(path: string): string {
  return stripLineComments(readFileSync(path, 'utf8'));
}

test('the driver opens pages with Target.createTarget in the background and never calls newPage (it makes the browser take the foreground)', () => {
  const driver = code('src/drivers/playwright/driver.ts');
  assert.deepEqual(driver.match(/\.newPage\s*\(/g), null);
  assert.deepEqual(driver.match(/launchPersistentContext|bringToFront/g), null);
  assert.match(driver, /Target\.createTarget/);
  // 会话页后台、登录窗口前台：参数在 browser-process.ts 的 createTargetParams 里（background: !foreground），驱动从 openPage 的 foreground 传进去。
  assert.match(driver, /createTargetParams\(marker,\s*foreground\)/);
  assert.match(driver, /createPage\(o\.foreground === true\)/);
  assert.match(code('src/drivers/playwright/browser-process.ts'), /background:\s*!foreground/);
});

test('nothing in src opens a TCP debugging port: the browser is controlled over a pipe only', () => {
  for (const f of readSources('src')) {
    assert.doesNotMatch(stripLineComments(f.text), /remote-debugging-port|remote-debugging-address|--remote-allow-origins|DevToolsActivePort/, f.path);
  }
  assert.match(code('src/drivers/playwright/browser-process.ts'), /--remote-debugging-pipe/);
});
