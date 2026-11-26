import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoWords, loadWords, main, scanIdentities, scanPath, scanText } from '../../scripts/publicity-check.ts';

// Keep the temp git repos hermetic: nothing from the developer's global git config applies.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'e2k-publicity-')));
after(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
function freshDir(): string {
  const dir = join(base, `d${counter++}`);
  mkdirSync(dir);
  return dir;
}
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}
function makeRepo(identity = true): string {
  const dir = freshDir();
  git(dir, 'init', '-q');
  if (identity) {
    git(dir, 'config', '--local', 'user.name', 'Fixture Author');
    git(dir, 'config', '--local', 'user.email', 'fixture@example.com');
  }
  return dir;
}
function commitAll(repo: string, message: string, as?: { name: string; email: string }): void {
  git(repo, 'add', '-A');
  const id = as ? ['-c', `user.name=${as.name}`, '-c', `user.email=${as.email}`] : [];
  git(repo, ...id, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function listWith(content: string): string {
  const file = join(freshDir(), 'words.txt');
  writeFileSync(file, content);
  return file;
}
async function run(argv: string[], env: NodeJS.ProcessEnv, root: string): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await main(argv, env, root, (s) => lines.push(s));
  return { code, text: lines.join('\n') };
}

const badUrl = 'https://' + ['shop', 'invalid'].join('.') + '/p';
const badEmail = ['someone', ['mail', 'invalid'].join('.')].join('@');
const listedWord = 'zzlistedwordzz';
const list = listWith(`# test list\n${listedWord}\n`);
const missing = join(base, 'no-such-words.txt');

test('loadWords: real line numbers; missing or empty list is an error that names the path', () => {
  assert.deepEqual(loadWords(listWith('# c\n\nalpha\n\nBeta\n')), [{ word: 'alpha', line: 3 }, { word: 'Beta', line: 5 }]);
  assert.throws(() => loadWords(missing), new RegExp(escapeRe(missing)));
  const commentsOnly = listWith('# only\n\n   \n# comments\n');
  assert.throws(() => loadWords(commentsOnly), new RegExp(escapeRe(commentsOnly)));
});

test('autoWords: homedir always, username only when 4+ chars', () => {
  assert.deepEqual(autoWords({ username: 'al', homedir: '/Users/al' }), [{ word: '/Users/al', line: 0 }]);
  assert.deepEqual(autoWords({ username: 'somebody', homedir: '/Users/somebody' }).map((w) => w.word), ['/Users/somebody', 'somebody']);
});

test('word match is case-insensitive, literal, and reports the list line', () => {
  const words = [{ word: 'other', line: 3 }, { word: 'forbiddenco', line: 7 }, { word: 'a+c', line: 9 }, { word: 'somebody', line: 0 }];
  assert.deepEqual(scanText('a.md', 'x ForbiddenCo y\nfor somebody', words),
    [{ file: 'a.md', line: 1, rule: 'word', ref: 'L7' }, { file: 'a.md', line: 2, rule: 'word', ref: 'auto' }]);
  assert.deepEqual(scanText('a.md', 'a.c aac', words), []);
  assert.deepEqual(scanPath('docs/ForbiddenCo-notes.md', words), [{ file: 'docs/ForbiddenCo-notes.md', line: 0, rule: 'path', ref: 'L7' }]);
});

test('hosts: example family, loopback and doc hosts pass; others hit, lock file included', () => {
  const ok = 'https://staging.example.com/a http://127.0.0.1:8080/ http://localhost:5173 https://playwright.dev/docs http://u:p@example.com/';
  assert.deepEqual(scanText('a.md', ok, []), []);
  assert.deepEqual(scanText('a.md', 'http://[::1]:9/ https://app.localhost/ https://nodejs.org/api https://www.typescriptlang.org/', []), []);
  assert.deepEqual(scanText('a.md', badUrl, []), [{ file: 'a.md', line: 1, rule: 'host', ref: 'shop.invalid' }]);
  assert.deepEqual(scanText('a.md', `see (${badUrl}).`, []).map((h) => h.ref), ['shop.invalid']);
  assert.deepEqual(scanText('a.md', 'http://${host}/x https://', []), []);
  const badHost = ['shop', 'invalid'].join('.');
  for (const s of [`**https://${badHost}**`, `https://${badHost}!`, `https://${badHost}…`, `https://${badHost}` + '${x}']) {
    assert.deepEqual(scanText('a.md', s, []).map((h) => h.ref), ['shop.invalid'], s);
  }
  const registry = 'https://' + ['registry', 'npmjs', 'org'].join('.') + '/x';
  assert.equal(scanText('a.md', registry, [])[0].rule, 'host');
  assert.deepEqual(scanText('package-lock.json', registry, [], { extraHosts: ['registry.npmjs.org'] }), []);
  assert.equal(scanText('package-lock.json', badUrl, [], { extraHosts: ['registry.npmjs.org'] })[0].rule, 'host');
});

test('hosts: IPv4-mapped loopback is allowed in both spellings, other mapped addresses still hit', () => {
  assert.deepEqual(scanText('a.md', 'http://[::ffff:127.0.0.1]/ http://[::ffff:7f00:1]:9/', []), []);
  const mapped = '[::ffff:' + ['8', '8', '8', '8'].join('.') + ']';   // 拼出来，免得本文件自己命中检查
  assert.deepEqual(scanText('a.md', `http://${mapped}/`, []).map((h) => h.ref), [mapped]);
});

test('emails: example family and the commit trailer pass; version specs are not emails', () => {
  assert.deepEqual(scanText('a.md', 'a@example.com noreply@anthropic.com playwright@1.65.0 npm@latest', []), []);
  assert.deepEqual(scanText('a.md', badEmail, []), [{ file: 'a.md', line: 1, rule: 'email', ref: 'mail.invalid' }]);
  assert.deepEqual(scanText('a.md', badEmail, [], { allowEmails: [badEmail] }), []);
});

test('identities must equal the configured one and pass the word list', () => {
  const me = { name: 'Fixture Author', email: 'fixture@example.com' };
  const good = { hash: 'abc1234', an: me.name, ae: me.email, cn: me.name, ce: me.email };
  assert.deepEqual(scanIdentities([good], me, []), []);
  assert.deepEqual(scanIdentities([{ ...good, hash: 'def5678', ae: 'other@example.org' }], me, []),
    [{ file: '<git-log>', line: 0, rule: 'identity', ref: 'def5678' }]);
  assert.deepEqual(scanIdentities([{ ...good, hash: 'def5678abcdef', cn: 'Someone Else' }], me, []),
    [{ file: '<git-log>', line: 0, rule: 'identity', ref: 'def5678' }]);
  assert.deepEqual(scanIdentities([good], me, [{ word: 'fixture', line: 2 }]),
    [{ file: '<git-log>', line: 0, rule: 'word', ref: 'L2' }]);
});

test('main: exit 2 without a word list, outside a repo, or without a local identity', async () => {
  const noList = await run([], { E2K_PUBLICITY_WORDS: missing }, makeRepo());
  assert.equal(noList.code, 2);
  assert.match(noList.text, new RegExp(escapeRe(missing)));
  assert.equal((await run([], { E2K_PUBLICITY_WORDS: list }, freshDir())).code, 2);
  assert.equal((await run([], { E2K_PUBLICITY_WORDS: list }, makeRepo(false))).code, 2);
});

test('main: scans tracked and untracked files but not ignored ones; lists binaries', async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'clean.md'), 'nothing here\n');
  writeFileSync(join(repo, '.gitignore'), 'secret.log\n');
  writeFileSync(join(repo, 'secret.log'), `x ${listedWord}\n`);
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  commitAll(repo, 'init');
  const clean = await run([], { E2K_PUBLICITY_WORDS: list }, repo);
  assert.equal(clean.code, 0);
  assert.match(clean.text, /skipped-binary blob\.bin/);
  writeFileSync(join(repo, 'dirty.md'), `x ${listedWord}\n`);
  const dirty = await run([], { E2K_PUBLICITY_WORDS: list }, repo);
  assert.equal(dirty.code, 1);
  assert.match(dirty.text, /dirty\.md:1 word L2/);
  assert.equal(dirty.text.includes(listedWord), false);
});

test('main: a word in a file name is reported as a path hit', async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, `${listedWord}.md`), 'clean\n');
  const r = await run([], { E2K_PUBLICITY_WORDS: list }, repo);
  assert.equal(r.code, 1);
  assert.match(r.text, /:0 path L2/);
});

test('main: works before the first commit; flags a foreign committer; --history sees deleted content', async () => {
  const emptyRepo = makeRepo();
  writeFileSync(join(emptyRepo, 'clean.md'), 'ok\n');
  const none = await run([], { E2K_PUBLICITY_WORDS: list }, emptyRepo);
  assert.equal(none.code, 0);
  assert.match(none.text, /还没有提交/);

  const repoA = makeRepo();
  writeFileSync(join(repoA, 'a.md'), 'ok\n');
  commitAll(repoA, 'by someone else', { name: 'Someone Else', email: 'else@example.org' });
  const foreign = await run([], { E2K_PUBLICITY_WORDS: list }, repoA);
  assert.equal(foreign.code, 1);
  assert.match(foreign.text, /<git-log>:0 identity [0-9a-f]{7}/);

  const repoB = makeRepo();
  writeFileSync(join(repoB, 'old.md'), `x ${listedWord}\n`);
  commitAll(repoB, 'add');
  git(repoB, 'rm', '-q', 'old.md');
  commitAll(repoB, 'remove');
  assert.equal((await run([], { E2K_PUBLICITY_WORDS: list }, repoB)).code, 0);
  const history = await run(['--history'], { E2K_PUBLICITY_WORDS: list }, repoB);
  assert.equal(history.code, 1);
  assert.match(history.text, /<git-history>:\d+ word L2/);
});

test('main: commit messages are scanned', async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'a.md'), 'ok\n');
  commitAll(repo, `mentions ${listedWord}`);
  const r = await run([], { E2K_PUBLICITY_WORDS: list }, repo);
  assert.equal(r.code, 1);
  assert.match(r.text, /<git-log>:1 word L2/);
});
