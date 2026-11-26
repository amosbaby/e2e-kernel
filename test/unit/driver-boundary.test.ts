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

test('src uses neither child_process nor page-exposed functions nor bringToFront', () => {
  const src = readSources('src');
  for (const needle of ['child_process', 'exposeFunction', 'exposeBinding', 'bringToFront']) assert.deepEqual(mentions(src, needle), [], needle);
});
