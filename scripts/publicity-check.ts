// Publicity gate for this public repository: private words, local paths, non-allowed
// hosts and e-mail addresses, and foreign commit identities must not appear anywhere.
// The word list lives outside the repository and is never printed.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export interface Word { word: string; line: number }
export interface Hit { file: string; line: number; rule: 'word' | 'path' | 'host' | 'email' | 'identity'; ref: string }
export interface Commit { hash: string; an: string; ae: string; cn: string; ce: string }

export const ALLOWED_HOSTS: readonly string[] = [
  'example.com', 'example.org', 'example.net', 'localhost', '127.0.0.1', '[::1]',
  'playwright.dev', 'nodejs.org', 'www.typescriptlang.org',
];
const ALLOWED_HOST_SUFFIXES: readonly string[] = ['.example.com', '.example.org', '.example.net', '.localhost'];
const ALLOWED_EMAIL_DOMAINS: readonly string[] = ['example.com', 'example.org', 'example.net', 'anthropic.com'];
const ALLOWED_EMAIL_SUFFIXES: readonly string[] = ['.example.com', '.example.org', '.example.net'];

const MAX_BUFFER = 64 * 1024 * 1024;
const HISTORY_MAX_BUFFER = 512 * 1024 * 1024;
const LOCK_FILE_HOSTS: readonly string[] = ['registry.npmjs.org'];

export function loadWords(path: string): Word[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`词表文件不存在或无法读取：${path}`);
  }
  const words: Word[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const word = raw.trim();
    if (word === '' || word.startsWith('#')) return;
    words.push({ word, line: i + 1 });
  });
  if (words.length === 0) throw new Error(`词表文件没有任何有效的词：${path}`);
  return words;
}

export function autoWords(user: { username: string; homedir: string }): Word[] {
  const words: Word[] = [];
  if (user.homedir !== '') words.push({ word: user.homedir, line: 0 });
  if (user.username.length >= 4) words.push({ word: user.username, line: 0 });
  return words;
}

function wordRef(w: Word): string {
  return w.line === 0 ? 'auto' : `L${w.line}`;
}

function matchWords(text: string, words: readonly Word[]): Word[] {
  const hay = text.toLowerCase();
  return words.filter((w) => w.word !== '' && hay.includes(w.word.toLowerCase()));
}

function hostOf(authority: string): string | null {
  const at = authority.lastIndexOf('@');
  const rest = at >= 0 ? authority.slice(at + 1) : authority;
  const bracketed = /^\[[0-9a-fA-F:.]+\]/.exec(rest);
  if (bracketed) return bracketed[0].toLowerCase();
  // Longest leading run of host characters; anything after it (markup, punctuation, ${…}) ends the host.
  const run = /^[\p{L}\p{N}.-]*/u.exec(rest.split(':')[0] ?? '')?.[0] ?? '';
  const host = run.replace(/\.+$/, '').toLowerCase();
  return host === '' ? null : host;
}

function hostAllowed(host: string, extraHosts: readonly string[]): boolean {
  return ALLOWED_HOSTS.includes(host) || extraHosts.includes(host) || ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

function emailAllowed(email: string, domain: string, allowEmails: readonly string[]): boolean {
  return ALLOWED_EMAIL_DOMAINS.includes(domain)
    || ALLOWED_EMAIL_SUFFIXES.some((s) => domain.endsWith(s))
    || allowEmails.some((e) => e.toLowerCase() === email);
}

export function scanText(
  file: string,
  text: string,
  words: readonly Word[],
  o: { allowEmails?: readonly string[]; extraHosts?: readonly string[] } = {},
): Hit[] {
  const allowEmails = o.allowEmails ?? [];
  const extraHosts = o.extraHosts ?? [];
  const hits: Hit[] = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    const line = i + 1;
    for (const w of matchWords(lineText, words)) hits.push({ file, line, rule: 'word', ref: wordRef(w) });
    for (const m of lineText.matchAll(/https?:\/\/([^\s/?#"'`<>\\]*)/gi)) {
      const host = hostOf(m[1] ?? '');
      if (host !== null && !hostAllowed(host, extraHosts)) hits.push({ file, line, rule: 'host', ref: host });
    }
    for (const m of lineText.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
      const domain = (m[1] ?? '').toLowerCase();
      if (!/^[a-z]+$/.test(domain.slice(domain.lastIndexOf('.') + 1))) continue;
      if (!emailAllowed(m[0].toLowerCase(), domain, allowEmails)) hits.push({ file, line, rule: 'email', ref: domain });
    }
  });
  return hits;
}

export function scanPath(file: string, words: readonly Word[]): Hit[] {
  return matchWords(file, words).map((w) => ({ file, line: 0, rule: 'path', ref: wordRef(w) }));
}

export function scanIdentities(
  commits: readonly Commit[],
  expected: { name: string; email: string },
  listWords: readonly Word[],
): Hit[] {
  const hits: Hit[] = [];
  for (const c of commits) {
    const ref = c.hash.slice(0, 7);
    const same = c.an === expected.name && c.cn === expected.name && c.ae === expected.email && c.ce === expected.email;
    if (!same) hits.push({ file: '<git-log>', line: 0, rule: 'identity', ref });
    for (const w of matchWords([c.an, c.ae, c.cn, c.ce].join('\n'), listWords)) {
      hits.push({ file: '<git-log>', line: 0, rule: 'word', ref: wordRef(w) });
    }
  }
  return hits;
}

function git(root: string, args: readonly string[], maxBuffer = MAX_BUFFER): string {
  return execFileSync('git', [...args], { cwd: root, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitOk(root: string, args: readonly string[]): boolean {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

function parseCommits(raw: string): Commit[] {
  return raw.split('\n').filter((l) => l !== '').map((l) => {
    const [hash = '', an = '', ae = '', cn = '', ce = ''] = l.split('\0');
    return { hash, an, ae, cn, ce };
  });
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, root: string, out: (s: string) => void): Promise<number> {
  const wordsPath = env.E2K_PUBLICITY_WORDS || join(homedir(), '.config', 'e2e-kernel', 'publicity-words.txt');
  let listWords: Word[];
  try {
    listWords = loadWords(wordsPath);
  } catch {
    out(`词表文件不存在或为空：${wordsPath}。请先建好再跑，本检查不会在没有词表时放行。`);
    return 2;
  }
  if (!gitOk(root, ['rev-parse', '--is-inside-work-tree'])) {
    out('不是 git 仓库');
    return 2;
  }
  let name: string;
  let email: string;
  try {
    name = git(root, ['config', '--local', '--get', 'user.name']).trim();
    email = git(root, ['config', '--local', '--get', 'user.email']).trim();
  } catch {
    name = '';
    email = '';
  }
  if (name === '' || email === '') {
    out('本仓库没有设置提交身份');
    return 2;
  }

  const words = [...listWords, ...autoWords({ username: userInfo().username, homedir: homedir() })];
  const allowEmails = [email];
  const hits: Hit[] = [];

  const files = git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter((f) => f !== '');
  let scanned = 0;
  for (const file of files) {
    hits.push(...scanPath(file, words));
    const full = join(root, file);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (st.isSymbolicLink()) {
      hits.push(...scanText(file, readlinkSync(full), words, { allowEmails }));
      scanned++;
      continue;
    }
    if (!st.isFile()) continue;
    const buf = readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) {
      out(`skipped-binary ${file}`);
      continue;
    }
    const extraHosts = file === 'package-lock.json' ? LOCK_FILE_HOSTS : [];
    hits.push(...scanText(file, buf.toString('utf8'), words, { allowEmails, extraHosts }));
    scanned++;
  }

  if (!gitOk(root, ['rev-parse', '--verify', 'HEAD'])) {
    out('还没有提交，跳过提交信息和身份');
  } else {
    try {
      const commits = parseCommits(git(root, ['log', '--all', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce']));
      hits.push(...scanIdentities(commits, { name, email }, listWords));
      hits.push(...scanText('<git-log>', git(root, ['log', '--all', '--format=%B']), words, { allowEmails }));
      if (argv.includes('--history')) {
        const history = git(root, ['log', '--all', '-p', '--format=%H'], HISTORY_MAX_BUFFER);
        hits.push(...scanText('<git-history>', history, words, { allowEmails, extraHosts: LOCK_FILE_HOSTS }));
      }
    } catch {
      out('读取 git 提交记录失败');
      return 2;
    }
  }

  if (hits.length > 0) {
    for (const h of hits) out(`${h.file}:${h.line} ${h.rule} ${h.ref}`);
    return 1;
  }
  out(`公开性检查：无命中（扫描 ${scanned} 个文件）`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, process.cwd(), console.log);
}
