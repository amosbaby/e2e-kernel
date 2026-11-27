import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalStore, readApprovals } from '../../src/kernel/approval-store.ts';
import type { ApprovalRecord } from '../../src/kernel/approval-store.ts';
import { E2kError } from '../../src/shared/errors.ts';

function dir(): { d: string; file: string; done(): void } {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'e2k-ap-')));
  return { d, file: join(d, 'approvals.json'), done: () => rmSync(d, { recursive: true, force: true }) };
}
const EMPTY: ApprovalRecord = { rules: null, writes: {}, hostModes: {} };
const FULL: ApprovalRecord = {
  rules: { hash: 'sha256:0123456789abcdef', text: '{"version":1}' },
  writes: { admin: [{ method: 'POST', url: 'https://admin.example.com/v1/items', operation: null }, { method: 'POST', url: 'https://admin.example.com/graphql', operation: 'AddItem' }] },
  hostModes: { 'app.example.com': 'readonly', 'other.example.org': 'default' },
};
const quiet = (): void => {};

test('readApprovals: a missing file is absent with an empty record', () => {
  const t = dir();
  try { assert.deepEqual(readApprovals(t.file), { record: EMPTY, status: 'absent' }); } finally { t.done(); }
});

test('store: a record round-trips through disk, is written 0600 and leaves no temp file', () => {
  const t = dir();
  try {
    const s = ApprovalStore.open(t.file, quiet);
    assert.equal(s.startupStatus, 'absent'); assert.deepEqual(s.get(), EMPTY);
    s.update(() => FULL);
    assert.deepEqual(s.get(), FULL);
    assert.equal(statSync(t.file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(t.d), ['approvals.json']);
    assert.deepEqual(readApprovals(t.file), { record: FULL, status: 'ok' });
    const again = ApprovalStore.open(t.file, quiet);
    assert.equal(again.startupStatus, 'ok'); assert.deepEqual(again.get(), FULL);
  } finally { t.done(); }
});

test('store: get returns a copy; changing it does not change what is approved', () => {
  const t = dir();
  try {
    const s = ApprovalStore.open(t.file, quiet);
    s.update(() => FULL);
    const copy = s.get(); copy.hostModes['evil.example.com'] = 'default'; copy.rules = null;
    assert.deepEqual(s.get(), FULL);
    s.update((r) => { r.hostModes['x.example.com'] = 'readonly'; return r; });
    assert.equal(s.get().hostModes['x.example.com'], 'readonly');
    assert.deepEqual(FULL.hostModes, { 'app.example.com': 'readonly', 'other.example.org': 'default' });   // update 收到的是副本
  } finally { t.done(); }
});

test('readApprovals: a symlink, a directory, a FIFO, an oversized file, bad JSON and a wrong shape are all unreadable with an empty record', () => {
  const t = dir();
  try {
    const real = join(t.d, 'real.json'); writeFileSync(real, JSON.stringify({ schema: 1, ...FULL }));
    const cases: Record<string, () => void> = {
      symlink: () => symlinkSync(real, t.file),
      dangling: () => symlinkSync(join(t.d, 'nowhere'), t.file),
      directory: () => mkdirSync(t.file),
      fifo: () => { execFileSync('mkfifo', [t.file]); },
      huge: () => { writeFileSync(t.file, ''); truncateSync(t.file, 2 * 1024 * 1024 + 1); },
      'bad json': () => writeFileSync(t.file, '{nope'),
      'not an object': () => writeFileSync(t.file, '[]'),
      'extra key': () => writeFileSync(t.file, JSON.stringify({ schema: 1, ...FULL, extra: 1 })),
      'missing key': () => writeFileSync(t.file, JSON.stringify({ schema: 1, rules: null, writes: {} })),
      'wrong schema': () => writeFileSync(t.file, JSON.stringify({ schema: 2, ...EMPTY })),
      'bad rules': () => writeFileSync(t.file, JSON.stringify({ schema: 1, ...EMPTY, rules: { hash: 'x' } })),
      'bad declaration': () => writeFileSync(t.file, JSON.stringify({ schema: 1, ...EMPTY, writes: { a: [{ method: 'POST', url: 'u' }] } })),
      'extra declaration key': () => writeFileSync(t.file, JSON.stringify({ schema: 1, ...EMPTY, writes: { a: [{ method: 'POST', url: 'u', operation: null, x: 1 }] } })),
      'bad host mode': () => writeFileSync(t.file, JSON.stringify({ schema: 1, ...EMPTY, hostModes: { 'a.example.com': 'denied' } })),
      'proto key': () => writeFileSync(t.file, '{"schema":1,"rules":null,"writes":{},"hostModes":{"__proto__":"readonly"}}'),
    };
    for (const [name, make] of Object.entries(cases)) {
      rmSync(t.file, { recursive: true, force: true });
      make();
      assert.deepEqual(readApprovals(t.file), { record: EMPTY, status: 'unreadable' }, name);
      const s = ApprovalStore.open(t.file, quiet);
      assert.equal(s.startupStatus, 'unreadable', name); assert.deepEqual(s.get(), EMPTY, name);
    }
  } finally { t.done(); }
});

test('store: an update that serialises past 2 MB throws needs-human and changes nothing, in memory or on disk', () => {
  const t = dir();
  try {
    const s = ApprovalStore.open(t.file, quiet);
    s.update(() => FULL);
    const before = readFileSync(t.file, 'utf8');
    assert.throws(() => s.update((r) => ({ ...r, rules: { hash: 'sha256:0', text: 'x'.repeat(2 * 1024 * 1024) } })),
      (e: unknown) => e instanceof E2kError && e.code === 'needs-human' && e.message === '批准记录太大');
    assert.deepEqual(s.get(), FULL); assert.equal(readFileSync(t.file, 'utf8'), before);
  } finally { t.done(); }
});

test('store: a "deny" host mode is written and read back (and a record with it reads fine)', () => {
  const t = dir();
  try {
    const s = ApprovalStore.open(t.file, quiet);
    s.update((r) => { r.hostModes['a.example.com'] = 'deny'; return r; });
    assert.equal(s.hostModeFor('a.example.com'), 'deny');
    const back = readApprovals(t.file);
    assert.equal(back.status, 'ok');
    assert.deepEqual(back.record.hostModes, { 'a.example.com': 'deny' });
    assert.equal(ApprovalStore.open(t.file, quiet).hostModeFor('a.example.com'), 'deny');
  } finally { t.done(); }
});

test('store: an update whose result has the wrong shape is refused before anything is written', () => {
  const t = dir();
  try {
    const s = ApprovalStore.open(t.file, quiet);
    assert.throws(() => s.update(() => ({ rules: null, writes: {}, hostModes: { 'a.example.com': 'denied' } } as unknown as ApprovalRecord)), (e: unknown) => e instanceof E2kError && e.code === 'internal');
    assert.deepEqual(s.get(), EMPTY);
    assert.deepEqual(readdirSync(t.d), []);
  } finally { t.done(); }
});

test('store: a temp-file name that already exists is never overwritten; the write fails after a few tries and nothing changes', () => {
  const t = dir();
  try {
    const clash = join(t.d, '.approvals.json.fixed.tmp');
    writeFileSync(clash, 'keep me');
    const s = ApprovalStore.open(t.file, quiet, { randomName: () => 'fixed' });
    assert.throws(() => s.update(() => FULL), (e: unknown) => e instanceof E2kError && e.code === 'needs-human');
    assert.equal(readFileSync(clash, 'utf8'), 'keep me');
    assert.deepEqual(s.get(), EMPTY);
    assert.deepEqual(readdirSync(t.d).sort(), ['.approvals.json.fixed.tmp']);
    let n = 0;   // 第一次撞名，第二次换了名字：写成功
    const s2 = ApprovalStore.open(t.file, quiet, { randomName: () => (n++ === 0 ? 'fixed' : 'fresh') });
    s2.update(() => FULL);
    assert.deepEqual(s2.get(), FULL); assert.equal(readFileSync(clash, 'utf8'), 'keep me');
  } finally { t.done(); }
});

test('store: a temp name that is a symlink is not followed', () => {
  const t = dir();
  try {
    const victim = join(t.d, 'victim.txt'); writeFileSync(victim, 'keep');
    symlinkSync(victim, join(t.d, '.approvals.json.fixed.tmp'));
    const s = ApprovalStore.open(t.file, quiet, { randomName: () => 'fixed' });
    assert.throws(() => s.update(() => FULL), E2kError);
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
  } finally { t.done(); }
});

test('store: deleting, corrupting or replacing the file at run time leaves memory alone and externallyChanged turns true', () => {
  const t = dir();
  try {
    const s = ApprovalStore.open(t.file, quiet);
    assert.equal(s.externallyChanged(), false);   // 启动时没有文件，现在仍然没有
    s.update(() => FULL);
    assert.equal(s.externallyChanged(), false);
    rmSync(t.file);
    assert.deepEqual(s.get(), FULL); assert.equal(s.externallyChanged(), true);
    s.update(() => FULL);                          // 再写一次：恢复
    assert.equal(s.externallyChanged(), false);
    writeFileSync(t.file, '{broken');
    assert.deepEqual(s.get(), FULL); assert.equal(s.externallyChanged(), true);
    s.update((r) => r);
    assert.equal(s.externallyChanged(), false);
    writeFileSync(t.file, JSON.stringify({ schema: 1, ...EMPTY }));   // 换成另一份合法内容
    assert.deepEqual(s.get(), FULL); assert.equal(s.externallyChanged(), true);
    s.update((r) => r);
    rmSync(t.file); symlinkSync(join(t.d, 'elsewhere'), t.file);
    assert.deepEqual(s.get(), FULL); assert.equal(s.externallyChanged(), true);
  } finally { t.done(); }
});

test('store: a file that appears after an absent start counts as changed, and is never read back into memory', () => {
  const t = dir();
  try {
    const s = ApprovalStore.open(t.file, quiet);
    writeFileSync(t.file, JSON.stringify({ schema: 1, ...FULL }));
    assert.equal(s.externallyChanged(), true);
    assert.deepEqual(s.get(), EMPTY);
  } finally { t.done(); }
});

test('store: starting on an unreadable file logs it, keeps an empty record, and does not call the unchanged bad file a change', () => {
  const t = dir();
  try {
    writeFileSync(t.file, '{broken');
    const lines: string[] = [];
    const s = ApprovalStore.open(t.file, (l) => lines.push(l));
    assert.equal(s.startupStatus, 'unreadable'); assert.deepEqual(s.get(), EMPTY);
    assert.equal(lines.length, 1); assert.ok(!lines[0]!.includes(t.d));
    assert.equal(s.externallyChanged(), false);
    s.update(() => FULL);                          // 批准一次之后，坏文件被换成好的
    assert.deepEqual(readApprovals(t.file), { record: FULL, status: 'ok' });
    assert.equal(s.externallyChanged(), false);
  } finally { t.done(); }
});

test('store: a started-ok store sees the file it started with as unchanged', () => {
  const t = dir();
  try {
    writeFileSync(t.file, JSON.stringify({ schema: 1, ...FULL }));
    const s = ApprovalStore.open(t.file, quiet);
    assert.equal(s.startupStatus, 'ok'); assert.equal(s.externallyChanged(), false);
    writeFileSync(t.file, JSON.stringify({ schema: 1, ...FULL }) + ' ');
    assert.equal(s.externallyChanged(), true);
  } finally { t.done(); }
});
