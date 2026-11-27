import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macFocus, noFocus } from '../../src/kernel/focus.ts';
import type { ExecFn } from '../../src/kernel/approval.ts';
import { readSources } from '../support/import-scan.ts';

interface Call { file: string; args: string[]; timeout: number }

const ASN = 'ASN:0x0-0x1873872:';
const info = (id: string): string => `[ NULL ]  ASN:0x0-0x1873872: (in front) \n    bundleID="${id}"\n    bundle path=[ NULL ] \n`;

// 脚本：按 lsappinfo 的哪一步回什么。front 回 front 的值，info 回 infoOut；open 回空。
function rig(o: { front?: string | Error; info?: string | Error; open?: Error } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const exec: ExecFn = async (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    let r: string | Error = '';
    if (file === 'lsappinfo' && args[0] === 'front') r = o.front ?? `${ASN}\n`;
    else if (file === 'lsappinfo' && args[0] === 'info') r = o.info ?? info('com.example.app');
    else if (file === 'open' && o.open !== undefined) r = o.open;
    if (r instanceof Error) throw r;
    return { stdout: r };
  };
  const focus = macFocus({ exec, platform: 'darwin', log: (l) => { logs.push(l); } });
  return { focus, calls, logs, opens: () => calls.filter((c) => c.file === 'open') };
}

// ---- capture ----

test('capture reads the front app in two lsappinfo calls and returns its bundle id', async () => {
  const t = rig();
  assert.equal(await t.focus.capture(), 'com.example.app');
  assert.deepEqual(t.calls.map((c) => [c.file, c.args]), [['lsappinfo', ['front']], ['lsappinfo', ['info', '-only', 'bundleID', ASN]]]);
});

test('every child process is argv-only with a short timeout', async () => {
  const t = rig({ info: info('com.google.chrome.for.testing') });
  const token = await rig().focus.capture();
  await t.focus.restore(token);
  assert.equal(t.opens().length, 1);
  assert.ok(t.calls.length >= 3);
  for (const c of t.calls) assert.ok(c.timeout > 0 && c.timeout <= 2000, `${c.file} timeout ${c.timeout}`);
});

test('capture returns null for a malformed front ASN and never asks for the bundle id', async () => {
  for (const bad of ['', 'ASN:0x0-0x1873872', 'ASN:0xZZ-0x1:', 'ASN:0x0-0x1873872: extra', `${ASN}\n$(touch /tmp/x)`, 'ASN:0X0-0X1:', 'asn:0x0-0x1:', `${ASN}${ASN}`, '-x']) {
    const t = rig({ front: bad });
    assert.equal(await t.focus.capture(), null, JSON.stringify(bad));
    assert.equal(t.calls.length, 1, `${JSON.stringify(bad)}: only the first call`);
  }
});

test('capture returns null for a malformed bundle id', async () => {
  const ids = ['', 'a b', '../x', 'a;b', 'a"b', 'é.app', 'x'.repeat(256), '`id`', '$(id)'];
  for (const id of ids) assert.equal(await rig({ info: info(id) }).focus.capture(), null, JSON.stringify(id));
  for (const out of ['', 'no bundle here', 'bundleID=com.example.app', 'bundleID=\'com.example.app\'', 'bundleid="com.example.app"']) {
    assert.equal(await rig({ info: out }).focus.capture(), null, JSON.stringify(out));
  }
  assert.equal(await rig({ info: info('x'.repeat(255)) }).focus.capture(), 'x'.repeat(255), 'the length cap is 255');
});

test('capture returns null when the front app is e2k’s Chromium', async () => {
  for (const id of ['com.google.chrome.for.testing', 'COM.GOOGLE.CHROME.FOR.TESTING', 'org.chromium.Chromium', 'org.Chromium.chromium-x']) {
    assert.equal(await rig({ info: info(id) }).focus.capture(), null, id);
  }
  assert.equal(await rig({ info: info('com.google.Chrome') }).focus.capture(), 'com.google.Chrome', 'the user’s own Chrome is an ordinary app');
});

test('capture swallows exec failures and logs them', async () => {
  const a = rig({ front: new Error('boom front') });
  assert.equal(await a.focus.capture(), null);
  assert.ok(a.logs.length > 0);
  const b = rig({ info: new Error('boom info') });
  assert.equal(await b.focus.capture(), null);
  assert.ok(b.logs.length > 0);
});

// ---- restore ----

test('restore(null) does not spawn anything', async () => {
  const t = rig({ info: info('com.google.chrome.for.testing') });
  await t.focus.restore(null);
  assert.deepEqual(t.calls, []);
});

test('restore refuses a token that is not a plain bundle id', async () => {
  for (const bad of ['', 'a b', '-a', '--help', '../x', 'a;b', 'x'.repeat(256), '$(id)', 'a\nb']) {
    const t = rig({ info: info('com.google.chrome.for.testing') });
    await t.focus.restore(bad);
    assert.deepEqual(t.calls, [], JSON.stringify(bad));
  }
});

test('restore opens the token only while e2k’s Chromium is in front', async () => {
  for (const id of ['com.google.chrome.for.testing', 'org.chromium.Chromium']) {
    const t = rig({ info: info(id) });
    await t.focus.restore('com.example.app');
    assert.deepEqual(t.opens().map((c) => c.args), [['-b', 'com.example.app']], id);
  }
});

test('restore leaves the foreground alone when something else is in front', async () => {
  for (const id of ['com.example.other', 'com.example.app', 'com.google.Chrome']) {
    const t = rig({ info: info(id) });
    await t.focus.restore('com.example.app');
    assert.deepEqual(t.opens(), [], id);
  }
});

test('restore leaves the foreground alone when the front app cannot be read', async () => {
  for (const o of [{ front: 'garbage' }, { info: 'garbage' }, { front: new Error('x') }, { info: new Error('x') }]) {
    const t = rig(o);
    await t.focus.restore('com.example.app');
    assert.deepEqual(t.opens(), []);
  }
});

test('restore swallows an open failure and logs it', async () => {
  const t = rig({ info: info('com.google.chrome.for.testing'), open: new Error('open failed') });
  await t.focus.restore('com.example.app');
  assert.equal(t.opens().length, 1);
  assert.ok(t.logs.length > 0);
});

test('restore reports whether it handed the foreground back: true once open -b was run (even if that failed), false otherwise', async () => {
  const ok = rig({ info: info('com.google.chrome.for.testing') });
  assert.equal(await ok.focus.restore('com.example.app'), true);
  const failed = rig({ info: info('com.google.chrome.for.testing'), open: new Error('open failed') });
  assert.equal(await failed.focus.restore('com.example.app'), true, 'attempted exactly once; the caller must not retry');
  assert.equal(failed.opens().length, 1);
  assert.equal(await rig({ info: info('com.example.other') }).focus.restore('com.example.app'), false, 'not in front');
  assert.equal(await rig({ front: new Error('x') }).focus.restore('com.example.app'), false, 'unreadable: try again later');
  assert.equal(await rig({ info: info('com.google.chrome.for.testing') }).focus.restore(null), false);
  assert.equal(await rig({ info: info('com.google.chrome.for.testing') }).focus.restore('--help'), false);
  assert.equal(await noFocus.restore('com.example.app'), false);
});

test('log lines are single-line and bounded', async () => {
  const t = rig({ front: new Error(`line1\nline2 ${'z'.repeat(5000)}`) });
  await t.focus.capture();
  for (const l of t.logs) assert.ok(!/[\r\n]/.test(l) && l.length < 400, l.length.toString());
});

// ---- platform / noFocus ----

test('off darwin macFocus is noFocus: nothing is spawned', async () => {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args, o) => { calls.push({ file, args, timeout: o.timeout }); return { stdout: '' }; };
  const f = macFocus({ exec, platform: 'linux' });
  assert.equal(await f.capture(), null);
  await f.restore('com.example.app');
  assert.deepEqual(calls, []);
});

test('noFocus captures nothing and restores nothing', async () => {
  assert.equal(await noFocus.capture(), null);
  await noFocus.restore('com.example.app');
  await noFocus.restore(null);
});

// ---- 测试绝不真的切换用户前台：每个 startKernel / new SessionManager 调用都要显式传 focus ----

function callsOf(text: string, head: RegExp): { at: number; body: string }[] {
  const out: { at: number; body: string }[] = [];
  for (const m of text.matchAll(head)) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < text.length && depth > 0) {
      const ch = text[i++];
      if (ch === '(' || ch === '{') depth++;
      else if (ch === ')' || ch === '}') depth--;
    }
    out.push({ at: m.index, body: text.slice(start, i) });
  }
  return out;
}

test('every startKernel and new SessionManager call in the tests passes a focus keeper', () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const f of readSources('test')) {
    if (f.path.endsWith('focus.test.ts')) continue;
    for (const re of [/\bstartKernel\(\{/g, /new SessionManager\(\{/g]) {
      for (const c of callsOf(f.text, re)) {
        seen++;
        if (!/\bfocus\b/.test(c.body)) offenders.push(`${f.path}:${f.text.slice(0, c.at).split('\n').length}`);
      }
    }
  }
  assert.ok(seen >= 20, `scanned ${seen} calls`);
  assert.deepEqual(offenders, []);
});
