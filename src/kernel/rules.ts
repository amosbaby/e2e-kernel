import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { E2kError } from '../shared/errors.ts';
import { oneOf, plainObject, str } from '../shared/validate.ts';
import type { Mode } from '../shared/protocol.ts';
import type { ModeResolver, RuleMode, RulesState } from './mode.ts';

// $E2K_HOME/rules.json：哪些主机默认只读、哪些是登录主机（设计 5.2）。格式见 README。
export interface Rule { match: string; mode: RuleMode }
export interface Rules { rules: Rule[]; loginHosts: string[] }

const MAX_RULES = 200;
const MAX_LOGIN_HOSTS = 50;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PATTERN_LENGTH = 255;
const RULE_MODES: readonly RuleMode[] = ['readonly', 'default'];

function usage(message: string): E2kError {
  return new E2kError('usage', message);
}

const NOT_A_HOST = 'not a valid host name';

function isIp(host: string): boolean {
  return host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

// 规范化主机：取 `new URL` 解析出的主机名（去端口、小写、punycode），再去掉末尾一个点。
// 含空白、控制字符或 / @ ? # \ % 的一律报错（它们会让 URL 解析成别的主机）。IP 字面量保持原样（IPv6 带方括号），
// 只有 IPv4 映射的 IPv6（`[::ffff:7f00:1]`，浏览器对 `[::ffff:127.0.0.1]` 给出的写法）折成点分 IPv4，让 IPv4 规则能命中它。
export function normalizeHost(host: string): string {
  if (typeof host !== 'string' || host === '' || /[\s\x00-\x1f\x7f/@?#\\%]/.test(host)) throw usage(NOT_A_HOST);
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname;
  } catch {
    throw usage(NOT_A_HOST);
  }
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(name);
  if (mapped !== null) {
    const hi = Number.parseInt(mapped[1]!, 16);
    const lo = Number.parseInt(mapped[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (!name.startsWith('[') && name.endsWith('.')) name = name.slice(0, -1);
  if (name === '' || (!name.startsWith('[') && (name.startsWith('.') || name.endsWith('.') || name.includes('..')))) throw usage(NOT_A_HOST);
  return name;
}

// 规则里的一个主机写法：精确主机名（含 IP），或「*.」加主机名（IP 不能用通配）。返回规范化后的写法。
function parsePattern(v: unknown, name: string): string {
  const s = str(v, name, { min: 1, max: MAX_PATTERN_LENGTH });
  const wildcard = s.startsWith('*.');
  const body = wildcard ? s.slice(2) : s;
  const shape = `${name} must be a host name, an IP address, or "*." followed by a host name`;
  if (body.includes('*')) throw usage(shape);
  // 规则只按主机匹配：带端口的写法会被悄悄去掉端口，宁可直接报错。
  if (body.startsWith('[') ? !body.endsWith(']') : body.includes(':')) throw usage(`${name} must not include a port`);
  let host: string;
  try {
    host = normalizeHost(body);
  } catch {
    throw usage(shape);
  }
  if (wildcard && isIp(host)) throw usage(`${name} must not use a wildcard with an IP address`);
  return wildcard ? `*.${host}` : host;
}

function parseHostList(v: unknown, name: string, max: number): string[] {
  if (!Array.isArray(v)) throw usage(`${name} must be an array`);
  if (v.length > max) throw usage(`${name} must have at most ${max} entries`);
  const seen = new Set<string>();
  return v.map((item, i) => {
    const p = parsePattern(item, `${name}[${i}]`);
    if (seen.has(p)) throw usage(`${name}[${i}] repeats an earlier entry`);
    seen.add(p);
    return p;
  });
}

export function parseRules(text: string): Rules {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw usage('rules file must be valid JSON');
  }
  const top = plainObject(raw, 'rules file', ['version', 'rules', 'loginHosts']);
  if (top.version !== 1) throw usage('version must be 1');
  const list = top.rules === undefined ? [] : top.rules;
  if (!Array.isArray(list)) throw usage('rules must be an array');
  if (list.length > MAX_RULES) throw usage(`rules must have at most ${MAX_RULES} entries`);
  const seen = new Set<string>();
  const rules = list.map((item, i): Rule => {
    const o = plainObject(item, `rules[${i}]`, ['match', 'mode']);
    if (o.mode === 'deny') throw usage(`rules[${i}].mode "deny" is not supported yet (planned for M3)`);
    const mode = oneOf(o.mode, `rules[${i}].mode`, RULE_MODES);
    const match = parsePattern(o.match, `rules[${i}].match`);
    if (seen.has(match)) throw usage(`rules[${i}].match repeats an earlier rule`);
    seen.add(match);
    return { match, mode };
  });
  const loginHosts = parseHostList(top.loginHosts === undefined ? [] : top.loginHosts, 'loginHosts', MAX_LOGIN_HOSTS);
  return { rules, loginHosts };
}

// 在已规范化的写法里找最具体的：精确优先；通配之间后缀越长越具体。
// 「*.example.com」只匹配以「.example.com」结尾的主机：不匹配 example.com，也不匹配 evilexample.com。IP 只能精确匹配。
function bestMatch<T>(items: readonly T[], patternOf: (item: T) => string, rawHost: string): T | null {
  const host = normalizeHost(rawHost);
  let best: T | null = null;
  let bestLen = -1;
  for (const item of items) {
    const p = patternOf(item);
    if (p === host) return item;
    if (!p.startsWith('*.') || isIp(host)) continue;
    const suffix = p.slice(1);
    if (host.endsWith(suffix) && suffix.length > bestLen) { best = item; bestLen = suffix.length; }
  }
  return best;
}

// rules 须是 parseRules 产出的（写法已规范化）。host 不合格时抛 usage。
export function matchRule(rules: readonly Rule[], host: string): Rule | null {
  return bestMatch(rules, (r) => r.match, host);
}

export function hostListed(patterns: readonly string[], host: string): boolean {
  return bestMatch(patterns, (p) => p, host) !== null;
}

interface RulesIo {
  stat(p: string): { isFile: boolean; size: number } | null;
  read(p: string): string;
}

const defaultIo: RulesIo = {
  stat(p) {
    try {
      const st = statSync(p);
      return { isFile: st.isFile(), size: st.size };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw e;
    }
  },
  read: (p) => readFileSync(p, 'utf8'),
};

function contentHash(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

type Loaded = { kind: 'absent' } | { kind: 'bad'; error: string } | { kind: 'text'; text: string; hash: string };

// 读规则文件的原文：没有文件、读不了或超限，都在这里变成说明。resolver 和 readRulesFile 共用。
function loadFile(file: string, io: RulesIo): Loaded {
  try {
    const st = io.stat(file);
    if (st === null) return { kind: 'absent' };   // 没有文件 = 没有规则
    if (!st.isFile) return { kind: 'bad', error: '规则文件不是普通文件' };
    if (st.size > MAX_FILE_BYTES) return { kind: 'bad', error: '规则文件超过 256 KB' };
    let text: string;
    try {
      text = io.read(file);
    } catch {
      return { kind: 'bad', error: '规则文件读不了' };
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return { kind: 'bad', error: '规则文件超过 256 KB' };
    return { kind: 'text', text, hash: contentHash(text) };
  } catch {
    return { kind: 'bad', error: '规则文件读不了' };
  }
}

function parseError(e: unknown): string {
  return `规则文件格式有误：${e instanceof E2kError ? e.message : '无法解析'}`;
}

// 规则文件现在的样子（不碰任何缓存），给 `rule list` 用。error 非 null 时 rules 和 loginHosts 为空、hash 为 null。
export interface RulesFile { rules: Rule[]; loginHosts: string[]; hash: string | null; error: string | null }

export function readRulesFile(file: string, io: RulesIo = defaultIo): RulesFile {
  const loaded = loadFile(file, io);
  if (loaded.kind === 'absent') return { rules: [], loginHosts: [], hash: null, error: null };
  if (loaded.kind === 'bad') return { rules: [], loginHosts: [], hash: null, error: loaded.error };
  try {
    return { ...parseRules(loaded.text), hash: loaded.hash, error: null };
  } catch (e) {
    return { rules: [], loginHosts: [], hash: null, error: parseError(e) };
  }
}

// 规则缓存。构造时读一次；之后只有 refresh() 碰文件。每次 refresh 都读文件比内容哈希（不看 mtime/大小）。
// 缓存是全局的：合法的新规则在任何一次 refresh 之后对所有会话生效；只有「改坏了」时才继续用上一份好的。
export function createRulesResolver(file: string, io: RulesIo = defaultIo): ModeResolver {
  let current: Rules = { rules: [], loginHosts: [] };
  let hash: string | null = null;
  let error: string | null = null;

  const refresh = (): void => {
    const loaded = loadFile(file, io);
    if (loaded.kind === 'absent') {
      current = { rules: [], loginHosts: [] }; hash = null; error = null;
      return;
    }
    if (loaded.kind === 'bad') { error = loaded.error; return; }
    if (loaded.hash === hash) { error = null; return; }   // 内容没变（含「改坏后又改回」）
    try {
      current = parseRules(loaded.text); hash = loaded.hash; error = null;
    } catch (e) {
      error = parseError(e);
    }
  };

  const ruleFor = (host: string): RuleMode | null => {
    try {
      return matchRule(current.rules, host)?.mode ?? null;
    } catch {
      return null;
    }
  };

  refresh();
  return {
    resolve(host): Mode {
      try {
        return matchRule(current.rules, host)?.mode === 'readonly' ? 'readonly' : 'default';
      } catch {
        return 'readonly';   // 失败关闭
      }
    },
    ruleFor,
    isLoginHost(host) {
      try {
        return hostListed(current.loginHosts, host);
      } catch {
        return false;
      }
    },
    refresh,
    state: (): RulesState => ({ count: current.rules.length, hash, error }),
  };
}
