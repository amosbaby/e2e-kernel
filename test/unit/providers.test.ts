import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExecutable, resolveProvider } from '../../src/drivers/playwright/providers.ts';
import type { E2kError } from '../../src/shared/errors.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'e2k-prov-')));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

function exe(dir: string, name = 'browser', mode = 0o755): string {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, mode);
  return p;
}

const isUsage = (e: unknown): boolean => (e as E2kError).code === 'usage';

test('checkExecutable accepts an executable regular file owned by the user and returns the real path', () => {
  const d = tmp();
  const p = exe(d);
  assert.equal(checkExecutable(p), p);
  const link = join(d, 'link');
  symlinkSync(p, link);
  assert.equal(checkExecutable(link), p);
});

test('checkExecutable refuses relative, missing, non-file, non-executable and world-writable targets, and lets a group-writable one through', () => {
  const d = tmp();
  assert.throws(() => checkExecutable('browser'), isUsage);
  assert.throws(() => checkExecutable(''), isUsage);
  assert.throws(() => checkExecutable(`${d}/a\0b`), isUsage);
  assert.throws(() => checkExecutable(join(d, 'nope')), isUsage);
  assert.throws(() => checkExecutable(d), isUsage);                                     // 目录
  assert.throws(() => checkExecutable(exe(d, 'plain', 0o644)), isUsage);                // 不可执行
  const gw = exe(d, 'gw', 0o775);                                                       // 组可写：放行（macOS 上用户自己装的应用常带 g+w）
  assert.equal(checkExecutable(gw), gw);
  assert.throws(() => checkExecutable(exe(d, 'ow', 0o757)), isUsage);                   // 其他人可写
  const open = tmp();
  const inOpenDir = exe(open);
  chmodSync(open, 0o777);                                                               // 所在目录别人可写
  assert.throws(() => checkExecutable(inOpenDir), isUsage);
  chmodSync(open, 0o700);
});

test('checkExecutable refuses a file that belongs to someone else', () => {
  const d = tmp();
  const p = exe(d);
  assert.throws(() => checkExecutable(p, { uid: 4242 }), isUsage);                      // 属主不是 4242，也不是 root
});

test('errors do not echo the path the caller gave', () => {
  const d = tmp();
  const secret = join(d, 'secret-marker-xyz');
  try {
    checkExecutable(secret);
    assert.fail('should throw');
  } catch (e) {
    assert.ok(!(e as Error).message.includes('secret-marker-xyz'));
    assert.ok(!String((e as E2kError).next ?? '').includes('secret-marker-xyz'));
  }
});

test('resolveProvider: --browser and --browser-path together are a usage error; an unknown preset too', () => {
  assert.throws(() => resolveProvider({ preset: 'ego-lite', path: '/x' }), isUsage);
  assert.throws(() => resolveProvider({ preset: 'firefox' }), isUsage);
});

test('resolveProvider: the default is playwright-chromium and honours --no-startup-window', () => {
  const p = resolveProvider({});
  assert.equal(p.id, 'playwright-chromium');
  assert.equal(p.closeOnboarding, false);
  assert.equal(p.honorsNoStartupWindow, true);
  assert.equal(p.flushOnPageClose, false);
});

test('resolveProvider: a custom path becomes the custom provider, with the bundle id read for it', () => {
  const d = tmp();
  const p = exe(d);
  const r = resolveProvider({ path: p }, { platform: 'darwin', bundleIdOf: () => 'com.example.browser' });
  assert.equal(r.id, 'custom');
  assert.equal(r.executable, p);
  assert.equal(r.bundleId, 'com.example.browser');
  assert.equal(resolveProvider({ path: p }, { platform: 'linux', bundleIdOf: () => 'com.example.browser' }).bundleId, undefined);
});

test('resolveProvider: ego-lite is found in the given app directories, closes onboarding and does not honour --no-startup-window', () => {
  const apps = tmp();
  const macos = join(apps, 'ego lite.app', 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  chmodSync(join(apps, 'ego lite.app'), 0o755);
  chmodSync(macos, 0o755);
  const p = exe(macos, 'ego lite');
  const r = resolveProvider({ preset: 'ego-lite' }, { appDirs: [join(apps, 'missing'), apps], platform: 'darwin', bundleIdOf: () => 'com.example.ego' });
  assert.equal(r.id, 'ego-lite');
  assert.equal(r.executable, p);
  assert.equal(r.closeOnboarding, true);
  assert.equal(r.honorsNoStartupWindow, false);
  assert.equal(r.flushOnPageClose, true);
  assert.equal(r.bundleId, 'com.example.ego');
});

test('resolveProvider: ego-lite that is not installed is a usage error with a next step', () => {
  const none = tmp();
  try {
    resolveProvider({ preset: 'ego-lite' }, { appDirs: [none] });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(isUsage(e));
    assert.ok(typeof (e as E2kError).next === 'string');
  }
});
