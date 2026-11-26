import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DEFAULT_PROFILE, profileInfo, recordLogin } from '../../src/kernel/profiles.ts';
import { isSensitiveKey } from '../../src/shared/redact.ts';
import { makeTmpHome } from '../support/tmp-home.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function tmp() {
  const t = makeTmpHome();
  cleanups.push(t.cleanup);
  return t.home;
}

const AT = new Date('2026-11-26T08:09:10.000Z');

test('default profile name', () => {
  assert.equal(DEFAULT_PROFILE, 'default');
});

test('a profile that does not exist is missing, and looking at it creates nothing', () => {
  const home = tmp();
  assert.deepEqual(profileInfo(home, DEFAULT_PROFILE), { name: 'default', state: 'missing', lastLogin: null });
  assert.deepEqual(readdirSync(home.root), []);        // 没建 profiles 目录
});

test('an empty profile directory is never-launched; one with entries is launched; neither is touched', () => {
  const home = tmp();
  mkdirSync(join(home.profilesDir, 'default'), { recursive: true, mode: 0o700 });
  assert.equal(profileInfo(home, 'default').state, 'never-launched');
  writeFileSync(join(home.profilesDir, 'default', 'Local State'), '{}');
  assert.equal(profileInfo(home, 'default').state, 'launched');
  assert.deepEqual(readdirSync(join(home.profilesDir, 'default')), ['Local State']);
  assert.deepEqual(readdirSync(home.profilesDir), ['default']);
});

test('a profile path that is not a plain directory is reported as launched (never claim "never launched" when unsure)', () => {
  const home = tmp();
  mkdirSync(home.profilesDir, { mode: 0o700 });
  symlinkSync(home.root, join(home.profilesDir, 'default'));
  assert.equal(profileInfo(home, 'default').state, 'launched');
});

test('recordLogin writes a 0600 file next to the profile directory, not inside it', () => {
  const home = tmp();
  mkdirSync(join(home.profilesDir, 'default'), { recursive: true, mode: 0o700 });
  recordLogin(home, 'default', AT, 'app.example.com');
  const file = join(home.profilesDir, 'default.login.json');
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schema: 1, at: '2026-11-26T08:09:10.000Z', host: 'app.example.com' });
  assert.deepEqual(readdirSync(join(home.profilesDir, 'default')), []);
  assert.deepEqual(profileInfo(home, 'default').lastLogin, { at: '2026-11-26T08:09:10.000Z', host: 'app.example.com' });
});

test('recordLogin overwrites the previous record and tightens a loose mode', () => {
  const home = tmp();
  mkdirSync(home.profilesDir, { recursive: true, mode: 0o700 });
  const file = join(home.profilesDir, 'default.login.json');
  writeFileSync(file, 'old'); chmodSync(file, 0o644);
  recordLogin(home, 'default', AT, 'a.example.com');
  recordLogin(home, 'default', new Date('2026-11-27T00:00:00.000Z'), 'b.example.com');
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(profileInfo(home, 'default').lastLogin, { at: '2026-11-27T00:00:00.000Z', host: 'b.example.com' });
});

test('recordLogin refuses a symbolic link and does not write through it', () => {
  const home = tmp();
  mkdirSync(home.profilesDir, { recursive: true, mode: 0o700 });
  const outside = join(home.root, 'outside.txt');
  writeFileSync(outside, 'keep');
  symlinkSync(outside, join(home.profilesDir, 'default.login.json'));
  assert.throws(() => { recordLogin(home, 'default', AT, 'app.example.com'); });
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
  // 指向 profiles 目录里面的链接，同样被 O_NOFOLLOW 挡住。
  const home2 = tmp();
  mkdirSync(home2.profilesDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(home2.profilesDir, 'inner.txt'), 'keep');
  symlinkSync(join(home2.profilesDir, 'inner.txt'), join(home2.profilesDir, 'default.login.json'));
  assert.throws(() => { recordLogin(home2, 'default', AT, 'app.example.com'); });
  assert.equal(readFileSync(join(home2.profilesDir, 'inner.txt'), 'utf8'), 'keep');
});

test('a symbolic link in place of the record reads as no record', () => {
  const home = tmp();
  mkdirSync(home.profilesDir, { recursive: true, mode: 0o700 });
  const target = join(home.root, 'real.json');
  writeFileSync(target, JSON.stringify({ schema: 1, at: '2026-11-26T08:09:10.000Z', host: 'app.example.com' }));
  symlinkSync(target, join(home.profilesDir, 'default.login.json'));
  assert.equal(profileInfo(home, 'default').lastLogin, null);
});

test('a record that does not validate reads as null', () => {
  const home = tmp();
  mkdirSync(home.profilesDir, { recursive: true, mode: 0o700 });
  const file = join(home.profilesDir, 'default.login.json');
  const good = { schema: 1, at: '2026-11-26T08:09:10.000Z', host: 'app.example.com' };
  const bad: unknown[] = [
    'not json{', '', '[]', 'null', '"x"',
    { ...good, schema: 2 }, { ...good, extra: 1 },
    { schema: 1, host: 'app.example.com' }, { schema: 1, at: good.at },
    { ...good, at: 'yesterday' }, { ...good, at: 5 }, { ...good, host: 5 }, { ...good, host: '' },
    { ...good, host: 'a'.repeat(300) }, { ...good, host: 'bad host' }, { ...good, host: 'a\nb' },
    { ...good, host: 'a b' }, { ...good, host: 'münchen.example.com' },
  ];
  for (const b of bad) {
    writeFileSync(file, typeof b === 'string' ? b : JSON.stringify(b));
    assert.equal(profileInfo(home, 'default').lastLogin, null, JSON.stringify(b));
  }
  writeFileSync(file, 'x'.repeat(100_000));                                // 超大的文件不读
  assert.equal(profileInfo(home, 'default').lastLogin, null);
  writeFileSync(file, JSON.stringify(good));
  assert.deepEqual(profileInfo(home, 'default').lastLogin, { at: good.at, host: good.host });
});

test('an IPv6 or numeric host is a valid record', () => {
  const home = tmp();
  mkdirSync(home.profilesDir, { recursive: true, mode: 0o700 });
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'xn--mnchen-3ya.example.com']) {
    recordLogin(home, 'default', AT, host);
    assert.equal(profileInfo(home, 'default').lastLogin?.host, host);
  }
  assert.ok(!existsSync(join(home.profilesDir, 'default')));
});

test('profile field names are not sensitive keys', () => {
  for (const k of ['profiles', 'state', 'lastLogin', 'at', 'host']) assert.ok(!isSensitiveKey(k), k);
});

test('adversarial host and time strings are rejected quickly', () => {
  const home = tmp();
  mkdirSync(home.profilesDir, { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (const host of ['a'.repeat(30_000) + '!', '[' + '1:'.repeat(30_000), '.'.repeat(30_000)]) {
    assert.throws(() => { recordLogin(home, 'default', AT, host); });
  }
  const file = join(home.profilesDir, 'default.login.json');
  writeFileSync(file, JSON.stringify({ schema: 1, at: '2'.repeat(3000) + '!', host: 'a'.repeat(3000) + '!' }));
  assert.equal(profileInfo(home, 'default').lastLogin, null);
  assert.ok(Date.now() - started < 2000);
});

test('a FIFO in place of the record neither blocks reading nor writing', () => {
  const home = tmp();
  mkdirSync(home.profilesDir, { recursive: true, mode: 0o700 });
  execFileSync('mkfifo', [join(home.profilesDir, 'default.login.json')], { timeout: 5000 });
  // 在子进程里跑：open 若会阻塞，execFileSync 的超时会杀掉子进程并让测试失败，不会把本进程挂住。
  const mod = pathToFileURL(join(process.cwd(), 'src/kernel/profiles.ts')).href;
  const script = `const m = await import(${JSON.stringify(mod)});
    const home = { profilesDir: ${JSON.stringify(home.profilesDir)} };
    console.log(JSON.stringify(m.profileInfo(home, 'default').lastLogin));
    try { m.recordLogin(home, 'default', new Date(), 'app.example.com'); console.log('wrote'); } catch (e) { console.log(e.code); }`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000, encoding: 'utf8' });
  assert.equal(out.trim(), 'null\nENXIO');
});
