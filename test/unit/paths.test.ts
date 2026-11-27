import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2kError } from '../../src/shared/errors.ts';
import { assertSocketPathFits, ensurePrivateDir, resolveHome, resolveInside } from '../../src/shared/paths.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

const tmp = makeTmpHome();
after(() => tmp.cleanup());
const root = tmp.home.root;
const fresh = join(root, 'fresh');
const loose = join(root, 'loose');
mkdirSync(loose);

const isCode = (code: string) => (e: unknown) => e instanceof E2kError && e.code === code;

test('resolveHome', () => {
  assert.deepEqual(resolveHome({ E2K_HOME: '/tmp/x' }), { root: '/tmp/x', socket: '/tmp/x/kernel.sock', pidFile: '/tmp/x/kernel.pid',
    logFile: '/tmp/x/kernel.log', rulesFile: '/tmp/x/rules.json', approvalsFile: '/tmp/x/approvals.json', profilesDir: '/tmp/x/profiles', runsDir: '/tmp/x/runs' });
  assert.ok(resolveHome({}).root.endsWith('/.e2e-kernel'));
  assert.throws(() => resolveHome({ E2K_HOME: 'relative/dir' }), E2kError);
});

test('resolveHome rejects an empty or NUL-containing E2K_HOME', () => {
  assert.throws(() => resolveHome({ E2K_HOME: '' }), isCode('usage'));
  assert.throws(() => resolveHome({ E2K_HOME: '/tmp/x\0y' }), isCode('usage'));
});

test('makeTmpHome gives a real (non-symlink) 0700 directory', () => {
  assert.equal(realpathSync(root), root);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(tmp.env.E2K_HOME, root);
  assert.deepEqual(resolveHome(tmp.env), tmp.home);
});

test('ensurePrivateDir creates 0700 and refuses a dir others can enter', () => {
  ensurePrivateDir(fresh); assert.equal(statSync(fresh).mode & 0o777, 0o700);
  chmodSync(loose, 0o755); assert.throws(() => ensurePrivateDir(loose), (e: E2kError) => e.code === 'needs-human');
});

test('ensurePrivateDir accepts an existing private dir and leaves it alone', () => {
  ensurePrivateDir(fresh);
  ensurePrivateDir(fresh);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
});

test('ensurePrivateDir ends at 0700 even under a restrictive umask', () => {
  const dir = join(root, 'umask');
  const old = process.umask(0o277);
  try {
    ensurePrivateDir(dir);
  } finally {
    process.umask(old);
  }
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('ensurePrivateDir refuses group/other bits of any kind', () => {
  for (const mode of [0o710, 0o701, 0o720, 0o702, 0o740, 0o704]) {
    const dir = join(root, `mode-${mode.toString(8)}`);
    mkdirSync(dir);
    chmodSync(dir, mode);
    assert.throws(() => ensurePrivateDir(dir), isCode('needs-human'), mode.toString(8));
  }
});

test('ensurePrivateDir refuses a symlink (even to a private dir) and a non-directory', () => {
  const link = join(root, 'link-to-fresh');
  symlinkSync(fresh, link);
  assert.throws(() => ensurePrivateDir(link), isCode('needs-human'));
  const file = join(root, 'a-file');
  writeFileSync(file, '');
  chmodSync(file, 0o600);
  assert.throws(() => ensurePrivateDir(file), isCode('needs-human'));
});

test('resolveInside rejects traversal', () => {
  assert.equal(resolveInside('/a/b', 'c', 'd.json'), '/a/b/c/d.json');
  for (const bad of ['../x', 'c/../../x', '/etc/hosts', 'c\0d'])
    assert.throws(() => resolveInside('/a/b', bad), (e: E2kError) => e.code === 'usage');
});

test('resolveInside rejects the base itself and a sibling with a common prefix', () => {
  for (const bad of [[], [''], ['.'], ['c', '..'], ['../b'], ['../bc/x'], ['c', '/etc']])
    assert.throws(() => resolveInside('/a/b', ...bad), isCode('usage'), JSON.stringify(bad));
  assert.equal(resolveInside('/a/b', 'c/../d'), '/a/b/d');
});

test('resolveInside error names no input value', () => {
  assert.throws(() => resolveInside('/a/b', '../hunter2x'), (e: Error) => !e.message.includes('hunter2x'));
});

test('resolveInside follows symlinks: an escaping or dangling link is rejected, an inside link is allowed', () => {
  const box = join(root, 'box');
  const outside = join(root, 'outside');
  mkdirSync(join(box, 'sub'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(box, 'out'));
  symlinkSync(join(root, 'no-such-target'), join(box, 'dangling'));
  symlinkSync('sub', join(box, 'in'));
  symlinkSync('.', join(box, 'self'));
  writeFileSync(join(outside, 'f'), '');
  symlinkSync(join(outside, 'f'), join(box, 'file-out'));

  for (const bad of [['out'], ['out', 'x.json'], ['out', 'deeper', 'x'], ['dangling'], ['dangling', 'x'], ['file-out'], ['self']])
    assert.throws(() => resolveInside(box, ...bad), isCode('usage'), JSON.stringify(bad));
  assert.equal(resolveInside(box, 'in', 'x.json'), join(box, 'in', 'x.json'));
  assert.equal(resolveInside(box, 'self', 'x.json'), join(box, 'self', 'x.json'));
  assert.equal(resolveInside(box, 'sub', 'new', 'x.json'), join(box, 'sub', 'new', 'x.json'));
});

test('resolveInside: a symlinked base is compared by its real path', () => {
  const realBase = join(root, 'real-base');
  mkdirSync(join(realBase, 'd'), { recursive: true });
  const linkedBase = join(root, 'linked-base');
  symlinkSync(realBase, linkedBase);
  assert.equal(resolveInside(linkedBase, 'd', 'x'), join(linkedBase, 'd', 'x'));
});

test('assertSocketPathFits: 103 bytes is the limit on macOS', () => {
  assertSocketPathFits('/' + 'a'.repeat(102));
  assert.throws(() => assertSocketPathFits('/' + 'a'.repeat(103)), /103/);
});

test('assertSocketPathFits counts bytes, not characters, and says how to fix it', () => {
  assert.throws(() => assertSocketPathFits('/' + 'é'.repeat(52)), (e: unknown) =>
    e instanceof E2kError && e.code === 'needs-human' && /E2K_HOME/.test(e.message + (e.next ?? '')));
  assertSocketPathFits(tmp.home.socket);
});
