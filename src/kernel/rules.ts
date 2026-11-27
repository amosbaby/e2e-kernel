import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { E2kError } from '../shared/errors.ts';
import { oneOf, plainObject, str } from '../shared/validate.ts';
import type { Mode } from '../shared/protocol.ts';
import type { ModeResolver, RuleMode, RulesState } from './mode.ts';

// $E2K_HOME/rules.json：哪些主机默认只读、哪些是登录主机（设计 5.2）。格式见 README。
export interface Rule { match: string; mode: RuleMode }

// 接口写法（域名组里的读型 POST、持久化查询、登出）：方法 + 来源 + 路径段。`path` 按 `/` 切开，'*' 是任意一段（非空）。
// `method` 大写；登出可省方法，存 '*'。
export interface Endpoint { method: string; origin: string; path: string[] }
// 身份探针：页面里一个 CSS 选择器，取到的文本要含期望值（不执行配置里的脚本）。
export interface Identity { selector: string; expect: string }
export interface PersistedSet { endpoint: Endpoint; hashes: string[] }
// 域名组（设计 5.2）。没编组的主机属于合成的 `default` 组（loginHosts 取顶层）。
export interface Group {
  name: string;
  hosts: string[];
  loginHosts: string[];
  readPosts: Endpoint[];
  persistedQueries: PersistedSet[];
  logout: Endpoint[];
  identity: Identity | null;
}
export interface Rules { rules: Rule[]; loginHosts: string[]; groups: Group[] }

export const DEFAULT_GROUP_NAME = 'default';

const MAX_RULES = 200;
const MAX_LOGIN_HOSTS = 50;
const MAX_GROUPS = 20;
const MAX_GROUP_LIST = 50;
const MAX_PERSISTED_ENDPOINTS = 20;
const MAX_PERSISTED_HASHES = 200;
const MAX_ENDPOINT_URL = 2048;
const MAX_SELECTOR = 300;
const MAX_EXPECT = 200;
const GROUP_NAME = /^[a-z0-9_-]{1,32}$/;
const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
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
  const top = plainObject(raw, 'rules file', ['version', 'rules', 'loginHosts', 'groups']);
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
  const groups = parseGroups(top.groups);
  return { rules, loginHosts, groups };
}

// ---- 接口写法 ----

// 请求或配置里的原始地址：scheme://authority[/path]，不带查询串和片段。路径段取原文（URL 解析会把 `..`、`%2e%2e` 折掉）。
const RAW_URL = /^(https?):\/\/([^/?#]*)(\/[^?#]*)?$/i;
const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;
const ENCODED_SEPARATOR = /%2f|%5c/i;
const UNSAFE_WILDCARD_SEGMENT = /%2f|%5c|%2e/i;

function splitPath(rawPath: string): string[] {
  return rawPath.slice(1).split('/');
}

// 输入 `{ method, url }`。methods 是允许的方法（必填）；'any' 表示方法可省（存 '*'），写了也只能是四个写方法之一。
export function parseEndpoint(v: unknown, name: string, o: { methods: readonly string[] | 'any' }): Endpoint {
  const obj = plainObject(v, name, ['method', 'url']);
  let method: string;
  if (obj.method === undefined) {
    if (o.methods !== 'any') throw usage(`${name}.method is required`);
    method = '*';
  } else {
    method = oneOf(obj.method, `${name}.method`, o.methods === 'any' ? WRITE_METHODS : o.methods);
  }
  const bad = `${name}.url must be an absolute http(s) URL without query, fragment, user name or password, and "*" must be a whole path segment`;
  const s = str(obj.url, `${name}.url`, { min: 1, max: MAX_ENDPOINT_URL });
  if (/[^\x21-\x7e]/.test(s) || s.includes('\\')) throw usage(bad);
  const m = RAW_URL.exec(s);
  if (m === null || m[2]!.includes('@')) throw usage(bad);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw usage(bad);
  }
  if (u.username !== '' || u.password !== '') throw usage(bad);
  const path = splitPath(m[3] ?? '/');
  path.forEach((seg, i) => {
    if (seg === '*') return;
    if (seg.includes('*') || DOT_SEGMENT.test(seg) || ENCODED_SEPARATOR.test(seg) || (seg === '' && i < path.length - 1)) throw usage(bad);
  });
  return { method, origin: u.origin, path };
}

// 失败关闭：任何拿不准的都不匹配。不用正则匹配 URL 的内容；请求带查询串、片段、凭据、反斜杠、空白，一律不匹配。
export function matchEndpoint(e: Endpoint, method: string, url: string): boolean {
  if (typeof method !== 'string' || typeof url !== 'string') return false;
  if (e.method !== '*' && e.method !== method.toUpperCase()) return false;
  if (/[^\x21-\x7e]/.test(url) || url.includes('\\')) return false;
  const m = RAW_URL.exec(url);
  if (m === null || m[2]!.includes('@')) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin !== e.origin || u.username !== '' || u.password !== '') return false;
  const segs = splitPath(m[3] ?? '/');
  if (segs.length !== e.path.length) return false;
  return e.path.every((want, i) => {
    const got = segs[i]!;
    if (want !== '*') return got === want;
    return got !== '' && !DOT_SEGMENT.test(got) && !UNSAFE_WILDCARD_SEGMENT.test(got);
  });
}

// ---- 身份探针 ----

// 会被 driver 的 locate 或 Playwright 当成别的东西的写法一律不收：快照引用、`role=…` 一类引擎前缀、`>>` 链、
// role:/getBy…/internal:、XPath（`//`、`..` 开头）、引号开头的文本选择器。
function parseIdentity(v: unknown, name: string): Identity {
  const o = plainObject(v, name, ['selector', 'expect']);
  const selector = str(o.selector, `${name}.selector`, { min: 1, max: MAX_SELECTOR });
  const expect = str(o.expect, `${name}.expect`, { min: 1, max: MAX_EXPECT });
  const t = selector.trim();
  if (/[\x00-\x1f\x7f]/.test(selector) || /[\x00-\x1f\x7f]/.test(expect)) throw usage(`${name} must not contain control characters`);
  if (t === '' || /^(f\d+)?e\d+$/.test(t) || t.includes('>>') || /^[a-z_-]+=/i.test(t)
    || /^(role:|getBy|internal:)/i.test(t) || /^(\/\/|\.\.|['"])/.test(t)) {
    throw usage(`${name}.selector must be a plain CSS selector (no snapshot reference, engine prefix, ">>" chain, role or XPath form)`);
  }
  return { selector, expect };
}

// ---- 域名组 ----

// p 的范围是否包含 q（都是已规范化的主机写法）。
function covers(p: string, q: string): boolean {
  if (p === q) return true;
  if (!p.startsWith('*.') || isIp(q)) return false;
  return (q.startsWith('*.') ? q.slice(1) : `.${q}`).endsWith(p.slice(1));
}

function overlaps(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a);
}

function endpointHostListed(patterns: readonly string[], e: Endpoint): boolean {
  try {
    return hostListed(patterns, new URL(e.origin).hostname);
  } catch {
    return false;
  }
}

function listOf(v: unknown, name: string, max: number): unknown[] {
  const list = v === undefined ? [] : v;
  if (!Array.isArray(list)) throw usage(`${name} must be an array`);
  if (list.length > max) throw usage(`${name} must have at most ${max} entries`);
  return list;
}

function parseGroup(item: unknown, i: number): Group {
  const at = `groups[${i}]`;
  const o = plainObject(item, at, ['name', 'hosts', 'loginHosts', 'readPosts', 'persistedQueries', 'logout', 'identity']);
  const name = str(o.name, `${at}.name`, { min: 1, max: 32, pattern: GROUP_NAME });
  if (name === DEFAULT_GROUP_NAME) throw usage(`${at}.name "${DEFAULT_GROUP_NAME}" is reserved for hosts that are not in any group`);
  const hosts = parseHostList(o.hosts, `${at}.hosts`, MAX_GROUP_LIST);
  if (hosts.length === 0) throw usage(`${at}.hosts must not be empty`);
  const loginHosts = parseHostList(o.loginHosts === undefined ? [] : o.loginHosts, `${at}.loginHosts`, MAX_GROUP_LIST);
  const known = [...hosts, ...loginHosts];
  const inGroup = (e: Endpoint, field: string, k: number): Endpoint => {
    if (!endpointHostListed(known, e)) throw usage(`${at}.${field}[${k}].url host must be in this group's hosts or loginHosts`);
    return e;
  };
  const readPosts = listOf(o.readPosts, `${at}.readPosts`, MAX_GROUP_LIST)
    .map((x, k) => inGroup(parseEndpoint(x, `${at}.readPosts[${k}]`, { methods: WRITE_METHODS }), 'readPosts', k));
  const logout = listOf(o.logout, `${at}.logout`, MAX_GROUP_LIST)
    .map((x, k) => inGroup(parseEndpoint(x, `${at}.logout[${k}]`, { methods: 'any' }), 'logout', k));
  let hashTotal = 0;
  const persistedQueries = listOf(o.persistedQueries, `${at}.persistedQueries`, MAX_PERSISTED_ENDPOINTS).map((x, k): PersistedSet => {
    const pq = `${at}.persistedQueries[${k}]`;
    const p = plainObject(x, pq, ['url', 'hashes']);
    const endpoint = inGroup(parseEndpoint({ method: 'POST', url: p.url }, pq, { methods: ['POST'] }), 'persistedQueries', k);
    if (!Array.isArray(p.hashes) || p.hashes.length === 0) throw usage(`${pq}.hashes must be a non-empty array`);
    hashTotal += p.hashes.length;
    if (hashTotal > MAX_PERSISTED_HASHES) throw usage(`${at}.persistedQueries must have at most ${MAX_PERSISTED_HASHES} hashes in total`);
    const seen = new Set<string>();
    const hashes = p.hashes.map((h, j) => {
      const hash = str(h, `${pq}.hashes[${j}]`, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ });
      if (seen.has(hash)) throw usage(`${pq}.hashes[${j}] repeats an earlier entry`);
      seen.add(hash);
      return hash;
    });
    return { endpoint, hashes };
  });
  const identity = o.identity === undefined ? null : parseIdentity(o.identity, `${at}.identity`);
  return { name, hosts, loginHosts, readPosts, persistedQueries, logout, identity };
}

function parseGroups(v: unknown): Group[] {
  const groups = listOf(v, 'groups', MAX_GROUPS).map(parseGroup);
  const names = new Set<string>();
  const hostOwner = new Map<string, number>();
  groups.forEach((g, i) => {
    if (names.has(g.name)) throw usage(`groups[${i}].name repeats an earlier group`);
    names.add(g.name);
    for (const h of g.hosts) {
      if (hostOwner.has(h)) throw usage(`groups[${i}].hosts has an entry that is also in another group`);
      hostOwner.set(h, i);
    }
  });
  // 某组的登录主机不能落在另一组的域名里（否则两组的登录会混在一起）。
  groups.forEach((g, i) => {
    for (const l of g.loginHosts) {
      if (groups.some((other, j) => j !== i && other.hosts.some((h) => overlaps(l, h)))) {
        throw usage(`groups[${i}].loginHosts has an entry that falls in another group's hosts`);
      }
    }
  });
  return groups;
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

function defaultGroup(rules: Rules): Group {
  return { name: DEFAULT_GROUP_NAME, hosts: [], loginHosts: rules.loginHosts, readPosts: [], persistedQueries: [], logout: [], identity: null };
}

// 主机所在的组：在所有组的 hosts 里取最具体的；没有、或主机不合格，是合成的 default 组。
export function groupOf(rules: Rules, host: string): Group {
  try {
    const entries = rules.groups.flatMap((g) => g.hosts.map((h) => ({ g, h })));
    const hit = bestMatch(entries, (x) => x.h, host);
    if (hit !== null) return hit.g;
  } catch {
    // 主机不合格：按 default 组
  }
  return defaultGroup(rules);
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

// 规则文件现在的样子（不碰任何缓存），给 `rule list` 用。error 非 null 时 rules、loginHosts 和 groups 为空、hash 为 null。
export interface RulesFile { rules: Rule[]; loginHosts: string[]; groups: Group[]; hash: string | null; error: string | null }

export function readRulesFile(file: string, io: RulesIo = defaultIo): RulesFile {
  const loaded = loadFile(file, io);
  if (loaded.kind === 'absent') return { rules: [], loginHosts: [], groups: [], hash: null, error: null };
  if (loaded.kind === 'bad') return { rules: [], loginHosts: [], groups: [], hash: null, error: loaded.error };
  try {
    return { ...parseRules(loaded.text), hash: loaded.hash, error: null };
  } catch (e) {
    return { rules: [], loginHosts: [], groups: [], hash: null, error: parseError(e) };
  }
}

// 规则缓存。构造时读一次；之后只有 refresh() 碰文件。每次 refresh 都读文件比内容哈希（不看 mtime/大小）。
// 缓存是全局的：合法的新规则在任何一次 refresh 之后对所有会话生效；只有「改坏了」时才继续用上一份好的。
export function createRulesResolver(file: string, io: RulesIo = defaultIo): ModeResolver {
  let current: Rules = { rules: [], loginHosts: [], groups: [] };
  let hash: string | null = null;
  let error: string | null = null;

  const refresh = (): void => {
    const loaded = loadFile(file, io);
    if (loaded.kind === 'absent') {
      current = { rules: [], loginHosts: [], groups: [] }; hash = null; error = null;
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
    groupOf: (host) => groupOf(current, host),
    group: (name) => (name === DEFAULT_GROUP_NAME ? defaultGroup(current) : current.groups.find((g) => g.name === name) ?? null),
    isLoginHost(host, group) {
      try {
        const logins = group === DEFAULT_GROUP_NAME ? current.loginHosts : current.groups.find((g) => g.name === group)?.loginHosts;
        return logins === undefined ? false : hostListed(logins, host);
      } catch {
        return false;
      }
    },
    refresh,
    state: (): RulesState => ({ count: current.rules.length, hash, error }),
  };
}
