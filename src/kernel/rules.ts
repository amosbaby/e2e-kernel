import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { E2kError } from '../shared/errors.ts';
import { oneOf, plainObject, str } from '../shared/validate.ts';
import type { Mode } from '../shared/protocol.ts';
import { readApprovals } from './approval-store.ts';
import type { ApprovalRecord, ApprovalStore, ApprovalsStatus, Declaration } from './approval-store.ts';
import type { ModeResolver, PendingRules, RuleMode, RulesState } from './mode.ts';

// $E2K_HOME/rules.json：哪些主机默认只读、哪些是登录主机（设计 5.2）。格式见 docs/reference.md。
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
const RULE_MODES: readonly RuleMode[] = ['readonly', 'default', 'deny'];

// 规则模式的松紧：数字越大越严（denied > readonly > default）。更严合并、差异的松紧都按它比。
export const STRICTNESS: Record<RuleMode, number> = { default: 0, readonly: 1, deny: 2 };

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
// `*` 匹配的那段只收这个白名单：非空、不以点开头，不含 `%`（编码）、`;`（路径参数）等。
const WILDCARD_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

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
  if (m === null || /[@*]/.test(m[2]!)) throw usage(bad);
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
    return WILDCARD_SEGMENT.test(got);
  });
}

// ---- 身份探针 ----

// 会被 driver 的 locate 或 Playwright 当成别的东西的写法一律不收：快照引用、引擎前缀（照 Playwright：trim 后
// 开头是 `[a-zA-Z_0-9+:*-]+` 再接可有空白的 `=`，如 `text =x`、`css:light=a`）、`>>` 链、role:/getBy…/internal:、
// XPath（`//`、`(//`、`..` 开头）、引号开头的文本选择器。
function parseIdentity(v: unknown, name: string): Identity {
  const o = plainObject(v, name, ['selector', 'expect']);
  const selector = str(o.selector, `${name}.selector`, { min: 1, max: MAX_SELECTOR });
  const expect = str(o.expect, `${name}.expect`, { min: 1, max: MAX_EXPECT });
  const t = selector.trim();
  if (/[\x00-\x1f\x7f]/.test(selector) || /[\x00-\x1f\x7f]/.test(expect)) throw usage(`${name} must not contain control characters`);
  if (t === '' || /^(f\d+)?e\d+$/.test(t) || t.includes('>>') || /^[a-zA-Z_0-9+:*-]+\s*=/.test(t)
    || /^(role:|getBy|internal:)/i.test(t) || /^\(*\/\//.test(t) || /^(\.\.|['"])/.test(t)) {
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
  // 同一个接口在一组里只能写一条：写两条的话，差异按接口合并时会漏掉其中一条的新哈希。
  const seenEndpoints = new Set<string>();
  persistedQueries.forEach((p, k) => {
    const key = endpointKey(p.endpoint);
    if (seenEndpoints.has(key)) throw usage(`${at}.persistedQueries[${k}].url repeats an earlier persistedQueries entry`);
    seenEndpoints.add(key);
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
  // 某组的登录主机不能落在另一组的域名里（否则两组的登录会混在一起）。精确写法用 groupOf 判（最具体的组不是本组才拒）；
  // 通配写法覆盖的范围不止一个主机，只要和别组的 hosts 写法重叠就拒。
  const asRules: Rules = { rules: [], loginHosts: [], groups };
  groups.forEach((g, i) => {
    g.loginHosts.forEach((l, k) => {
      if (l.startsWith('*.')) {
        if (groups.some((other, j) => j !== i && other.hosts.some((h) => overlaps(l, h)))) {
          throw usage(`groups[${i}].loginHosts[${k}] is a wildcard that overlaps another group's hosts`);
        }
      } else {
        const owner = groupOf(asRules, l).name;
        if (owner !== DEFAULT_GROUP_NAME && owner !== g.name) throw usage(`groups[${i}].loginHosts[${k}] is a host of another group's hosts`);
      }
    });
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
  return Object.freeze({ name: DEFAULT_GROUP_NAME, hosts: Object.freeze([]), loginHosts: rules.loginHosts, readPosts: Object.freeze([]), persistedQueries: Object.freeze([]), logout: Object.freeze([]), identity: null }) as unknown as Group;
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

// 报告和状态里显示用的短哈希（16 位十六进制）。
export function contentHash(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// 待批改动的身份：完整的 sha256（64 位十六进制）。approvePending 比的是它，不是短哈希。
function fullHash(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

type Loaded = { kind: 'absent' } | { kind: 'bad'; error: string } | { kind: 'text'; text: string; hash: string };

// 读规则文件的原文：没有文件、读不了或超限，都在这里变成说明。resolver 和 inspectRules 共用。
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

// 规则文件现在的样子（不碰任何缓存），给 `rule list` 用（经 inspectRules）。error 非 null 时 rules、loginHosts 和 groups 为空、hash 为 null。
export interface RulesFile { rules: Rule[]; loginHosts: string[]; groups: Group[]; hash: string | null; error: string | null }

function toRulesFile(loaded: Loaded): RulesFile {
  if (loaded.kind === 'absent') return { rules: [], loginHosts: [], groups: [], hash: null, error: null };
  if (loaded.kind === 'bad') return { rules: [], loginHosts: [], groups: [], hash: null, error: loaded.error };
  try {
    return { ...parseRules(loaded.text), hash: loaded.hash, error: null };
  } catch (e) {
    return { rules: [], loginHosts: [], groups: [], hash: null, error: parseError(e) };
  }
}

// ---- 批准快照 ----

const EMPTY_RULES: Rules = Object.freeze({ rules: Object.freeze([]), loginHosts: Object.freeze([]), groups: Object.freeze([]) }) as unknown as Rules;
// 待批改动的差异放不放得进弹框，按字符判，不按行数（终审 M-1：首次配几个组，行数很容易过 12，字符却放得下）：
// 弹框的限制是每行 200 字符、正文 1500 字符（approval.ts 的 checkDialogText）；差异占正文的一部分，另有首尾两句框架（约 100 字符），所以差异本身留 1300。
export const MAX_SUMMARY_BODY_CHARS = 1300;
const MAX_SUMMARY_LINE_CHARS = 200;
export function summaryTooLong(summary: readonly string[]): boolean {
  return summary.some((l) => l.length > MAX_SUMMARY_LINE_CHARS) || summary.join('\n').length > MAX_SUMMARY_BODY_CHARS;
}

// 批准记录里的规则：哈希对得上原文、原文解析得了才算数；对不上或解析不了（被改过，或解析器收紧了）当没批准过。
interface Snapshot { rules: Rules; hash: string | null; text: string | null; valid: boolean }

// 批准快照里的规则整个冻住：groupOf / group 返回的组对象和它的数组，调用方改写不了快照（严格模式下改写会抛错）。
function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

function snapshotOf(approved: ApprovalRecord['rules']): Snapshot {
  if (approved === null) return { rules: EMPTY_RULES, hash: null, text: null, valid: true };
  try {
    if (contentHash(approved.text) !== approved.hash) throw new Error('hash');
    return { rules: deepFreeze(parseRules(approved.text)), hash: approved.hash, text: approved.text, valid: true };
  } catch {
    return { rules: EMPTY_RULES, hash: null, text: null, valid: false };
  }
}

// ---- 差异 ----

const MODE_TEXT: Record<RuleMode, string> = { readonly: '只读', default: '默认', deny: '不允许' };

function endpointKey(e: Endpoint): string {
  return `${e.method} ${e.origin}/${e.path.join('/')}`;
}

// 写出来给人看的接口：有具体方法就带上方法。
function endpointText(e: Endpoint): string {
  return `${e.method === '*' ? '' : `${e.method} `}${e.origin}/${e.path.join('/')}`;
}

function urlText(e: Endpoint): string {
  return `${e.origin}/${e.path.join('/')}`;
}

function hostGroups(r: Rules): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of r.groups) for (const h of g.hosts) m.set(h, g.name);
  return m;
}

function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  return a === null || b === null ? a === b : a.selector === b.selector && a.expect === b.expect;
}

// 一个组里的变化，分成「放宽」和「收紧」两摞。old 为 null 表示新建的组（里面的东西都算新加的）。
function diffGroup(old: Group | null, now: Group, relax: string[], tighten: string[]): void {
  const g = now.name;
  const oldPosts = new Set((old?.readPosts ?? []).map(endpointKey));
  const nowPosts = new Set(now.readPosts.map(endpointKey));
  for (const e of now.readPosts) if (!oldPosts.has(endpointKey(e))) relax.push(`+ 读型 POST ${g}：${endpointText(e)}`);
  for (const e of old?.readPosts ?? []) if (!nowPosts.has(endpointKey(e))) tighten.push(`- 读型 POST ${g}：${endpointText(e)}`);

  const oldSets = new Map((old?.persistedQueries ?? []).map((p) => [endpointKey(p.endpoint), p]));
  const nowSets = new Map(now.persistedQueries.map((p) => [endpointKey(p.endpoint), p]));
  for (const [key, p] of nowSets) {
    const had = new Set(oldSets.get(key)?.hashes ?? []);
    const added = p.hashes.filter((h) => !had.has(h)).length;
    if (added > 0) relax.push(`+ 持久化查询 ${g}：${urlText(p.endpoint)}（+${added} 个哈希）`);
  }
  for (const [key, p] of oldSets) {
    const has = new Set(nowSets.get(key)?.hashes ?? []);
    const removed = p.hashes.filter((h) => !has.has(h)).length;
    if (removed > 0) tighten.push(`- 持久化查询 ${g}：${urlText(p.endpoint)}（-${removed} 个哈希）`);
  }

  const oldLogins = new Set(old?.loginHosts ?? []);
  const nowLogins = new Set(now.loginHosts);
  for (const h of now.loginHosts) if (!oldLogins.has(h)) relax.push(`+ 登录主机 ${g}：${h}`);
  for (const h of old?.loginHosts ?? []) if (!nowLogins.has(h)) tighten.push(`- 登录主机 ${g}：${h}`);

  // 登出接口是被拦的：删掉一条等于放宽，加一条是收紧。
  const oldLogout = new Set((old?.logout ?? []).map(endpointKey));
  const nowLogout = new Set(now.logout.map(endpointKey));
  for (const e of old?.logout ?? []) if (!nowLogout.has(endpointKey(e))) relax.push(`- 登出 ${g}：${endpointText(e)}`);
  for (const e of now.logout) if (!oldLogout.has(endpointKey(e))) tighten.push(`+ 登出 ${g}：${endpointText(e)}`);

  if (!sameIdentity(old?.identity ?? null, now.identity)) relax.push(`~ 身份探针 ${g}`);
}

// 规则 b 相对 a 的完整差异（不截断）：放宽的在前，收紧的在后。a 是已批准的，b 是待批的。
export function diffRules(a: Rules, b: Rules): string[] {
  const relax: string[] = [];
  const tighten: string[] = [];

  const aGroups = new Map(a.groups.map((g) => [g.name, g]));
  const bGroups = new Map(b.groups.map((g) => [g.name, g]));
  for (const g of b.groups) diffGroup(aGroups.get(g.name) ?? null, g, relax, tighten);
  for (const g of a.groups) if (!bGroups.has(g.name)) relax.push(`- 组 ${g.name}`);
  for (const g of b.groups) if (!aGroups.has(g.name)) tighten.push(`+ 组 ${g.name}`);

  const aTop = new Set(a.loginHosts);
  const bTop = new Set(b.loginHosts);
  for (const h of b.loginHosts) if (!aTop.has(h)) relax.push(`+ 顶层登录主机：${h}`);
  for (const h of a.loginHosts) if (!bTop.has(h)) tighten.push(`- 顶层登录主机：${h}`);

  const aHosts = hostGroups(a);
  const bHosts = hostGroups(b);
  for (const h of new Set([...bHosts.keys(), ...aHosts.keys()])) {
    const from = aHosts.get(h) ?? DEFAULT_GROUP_NAME;
    const to = bHosts.get(h) ?? DEFAULT_GROUP_NAME;
    if (from !== to) relax.push(`~ 主机 ${h} 从组 ${from} 移到组 ${to}`);
  }

  const aRules = new Map(a.rules.map((r) => [r.match, r.mode]));
  const bRules = new Map(b.rules.map((r) => [r.match, r.mode]));
  for (const [match, mode] of bRules) {
    const was = aRules.get(match);
    if (was === undefined) (STRICTNESS[mode] > 0 ? tighten : relax).push(`+ 规则 ${match}（${MODE_TEXT[mode]}）`);
    else if (was !== mode) (STRICTNESS[mode] > STRICTNESS[was] ? tighten : relax).push(`~ 规则 ${match}：${MODE_TEXT[was]}→${MODE_TEXT[mode]}`);
  }
  for (const [match, mode] of aRules) {
    if (!bRules.has(match)) (STRICTNESS[mode] > 0 ? relax : tighten).push(`- 规则 ${match}（${MODE_TEXT[mode]}）`);
  }
  return [...relax, ...tighten];
}

// 待批改动的说明：文件被删（b 为 null）、没有逐字段的差异（只是写法变了）也各有一行。
export function summarizeChange(approved: Rules, pending: Rules | null): string[] {
  if (pending === null) return ['规则文件被删了：所有规则失效'];
  const lines = diffRules(approved, pending);
  return lines.length === 0 ? ['规则文件内容变了，解析出来的规则没有差别'] : lines;
}

// 规则文件和批准快照的比较，resolver 和 inspectRules 共用。
type Comparison =
  | { kind: 'same' }
  | { kind: 'error'; error: string }
  | { kind: 'changed'; hash: string | null; shortHash: string | null; text: string | null; rules: Rules | null; summary: string[] };   // hash：完整 sha256（待批的身份）；shortHash：显示用；删文件都是 null

function compareWithApproved(loaded: Loaded, snap: Snapshot): Comparison {
  if (loaded.kind === 'absent') {
    return snap.text === null ? { kind: 'same' } : { kind: 'changed', hash: null, shortHash: null, text: null, rules: null, summary: summarizeChange(snap.rules, null) };
  }
  if (loaded.kind === 'bad') return { kind: 'error', error: loaded.error };
  if (loaded.text === snap.text) return { kind: 'same' };   // 比原文，不只比 64 位的哈希
  let rules: Rules;
  try {
    rules = parseRules(loaded.text);
  } catch (e) {
    return { kind: 'error', error: parseError(e) };
  }
  return { kind: 'changed', hash: fullHash(loaded.text), shortHash: loaded.hash, text: loaded.text, rules, summary: summarizeChange(snap.rules, rules) };
}

// 给 CLI（rule list、rule diff、doctor）：自己读规则文件和批准记录，不经内核。批准记录读不了或没有，快照就是空的。
export interface RulesInspection {
  file: RulesFile;                 // 规则文件现在的样子
  approvals: ApprovalsStatus;
  approvedRules: Rules;            // 批准快照里的规则
  approvedCount: number;
  pending: boolean;                // 文件和快照不一致且解析得了（文件有错不算）；文件被删而快照里有规则也算
  fileDeleted: boolean;            // 待批的改动是「文件被删了」
  hash: string | null;             // 待批文件的短哈希（显示用）；删文件为 null
  summary: string[];               // 完整差异；没有待批为空
  hostModes: Record<string, 'default' | 'readonly'>;   // 批准记录里登录时选的模式（读不了为空）
  writes: Record<string, Declaration[]>;               // 批准记录里记住的放行声明（读不了为空）
}

export function inspectRules(rulesFile: string, approvalsFile: string, io: RulesIo = defaultIo): RulesInspection {
  const loaded = loadFile(rulesFile, io);
  const { record, status } = readApprovals(approvalsFile);
  const snap = snapshotOf(record.rules);
  const c = compareWithApproved(loaded, snap);
  const approvals: ApprovalsStatus = snap.valid ? status : 'unreadable';
  const base = { file: toRulesFile(loaded), approvals, approvedRules: snap.rules, approvedCount: snap.rules.rules.length, hostModes: record.hostModes, writes: record.writes };
  if (c.kind !== 'changed') return { ...base, pending: false, fileDeleted: false, hash: null, summary: [] };
  return { ...base, pending: true, fileDeleted: c.text === null, hash: c.shortHash, summary: c.summary };
}

// 一份规则里，有没有 deny 规则落在这些主机写法（精确或 `*.` 通配）的某个主机上、且在那里是最具体的规则。
// 精确主机：直接看它命中的规则。通配 G：精确 deny 规则落在 G 下就算；通配 deny 规则 D 与 G 有交集（后缀互为后缀）时，
// 交集是后缀更长的那个通配；只有存在后缀更长（更具体）于 D 的非 deny 通配规则把整个交集盖住，才不算。
function viewHasDeny(rules: readonly Rule[], patterns: readonly string[]): boolean {
  const denies = rules.filter((r) => r.mode === 'deny');
  if (denies.length === 0) return false;
  return patterns.some((g) => {
    if (!g.startsWith('*.')) return matchRule(rules, g)?.mode === 'deny';
    const sg = g.slice(1);
    return denies.some((d) => {
      if (!d.match.startsWith('*.')) return !isIp(d.match) && d.match.endsWith(sg);
      const sd = d.match.slice(1);
      if (!sg.endsWith(sd) && !sd.endsWith(sg)) return false;
      const inter = sg.length >= sd.length ? sg : sd;
      return !rules.some((r) => r.mode !== 'deny' && r.match.startsWith('*.') && r.match.length - 1 > sd.length && inter.endsWith(r.match.slice(1)));
    });
  });
}

// 规则解析器。生效的是批准快照（ApprovalStore 里最后一次批准的那份规则）；规则文件只产生「待批」。
// 每次 refresh 读文件和快照原文比：一样 = 无待批；不一样且解析得了 = 待批；改坏 = error，坏文件不进待批。
// 待批期间 resolve 取「已批准」和「待批文件」里更严的（denied > readonly > default），所以只有 rules 里新增或改成只读 / 不允许的条目立刻生效、放宽要等批准；
// 组、白名单、loginHosts、logout、identity 只认已批准的（它们的改动哪怕是收紧也要等批准）。批准只认内存里留着的原文和哈希，不重读磁盘。
export function createRulesResolver(file: string, store: ApprovalStore, io: RulesIo = defaultIo): ModeResolver {
  let snap = snapshotOf(store.get().rules);
  let approvals: ApprovalsStatus = snap.valid ? store.startupStatus : 'unreadable';
  let pending: { hash: string | null; shortHash: string | null; text: string | null; rules: Rules | null; summary: string[] } | null = null;
  let error: string | null = null;
  let approvalsChanged = false;

  const refresh = (): void => {
    const c = compareWithApproved(loadFile(file, io), snap);
    if (c.kind === 'changed') { pending = { hash: c.hash, shortHash: c.shortHash, text: c.text, rules: c.rules, summary: c.summary }; error = null; }
    else if (c.kind === 'error') { pending = null; error = c.error; }
    else { pending = null; error = null; }
    approvalsChanged = store.externallyChanged();
  };

  // 已批准和待批文件里更严的那份；主机不合格时抛出（resolve 据此失败关闭，ruleFor 据此给 null）。
  const effective = (host: string): RuleMode | null => {
    const a = matchRule(snap.rules.rules, host)?.mode ?? null;
    const p = pending?.rules == null ? null : matchRule(pending.rules.rules, host)?.mode ?? null;
    // 待批的 default 不算（它是放宽，也不能盖住登录时选的模式）；只有只读 / 不允许才参与取严。
    const tight = p !== null && STRICTNESS[p] > 0 ? p : null;
    return tight !== null && (a === null || STRICTNESS[tight] > STRICTNESS[a]) ? tight : a;
  };

  // 登录时选的模式：精确的规范化主机；只在没有任何规则覆盖（含待批里的只读）时才轮到它。主机不合格时抛出。
  const modeOf = (host: string): RuleMode | null => effective(host) ?? store.hostModeFor(normalizeHost(host));

  const ruleFor = (host: string): RuleMode | null => {
    try {
      return modeOf(host);
    } catch {
      return null;
    }
  };

  const hostChoice = (host: string): RuleMode | null => {
    try {
      return effective(host) === null ? store.hostModeFor(normalizeHost(host)) : null;
    } catch {
      return null;
    }
  };

  // 列明：已批准的规则、登录时选过、组的 hosts、任何组的 loginHosts、顶层 loginHosts；待批的不算，出错为 false。
  const isListed = (host: string): boolean => {
    try {
      const h = normalizeHost(host);
      const { rules, groups, loginHosts } = snap.rules;
      return matchRule(rules, h) !== null
        || store.hostModeFor(h) !== null
        || groups.some((g) => hostListed(g.hosts, h) || hostListed(g.loginHosts, h))
        || hostListed(loginHosts, h);
    } catch {
      return false;
    }
  };

  // 组有没有主机落在 deny 规则下。已批准和待批文件各看一遍（和 effective 一样取更严：任一边判 deny 就算）。
  const groupHasDeny = (name: string): boolean => {
    if (name === DEFAULT_GROUP_NAME) return false;
    const hosts = snap.rules.groups.find((g) => g.name === name)?.hosts;
    if (hosts === undefined) return false;
    return viewHasDeny(snap.rules.rules, hosts) || (pending?.rules != null && viewHasDeny(pending.rules.rules, hosts));
  };

  const pendingView = (): PendingRules | null => pending === null ? null
    : { hash: pending.hash, baseHash: snap.text === null ? null : fullHash(snap.text), text: pending.text, summary: [...pending.summary], tooLong: summaryTooLong(pending.summary) };

  refresh();
  return {
    resolve(host): Mode {
      try {
        const m = modeOf(host);
        return m === 'deny' ? 'denied' : m === 'readonly' ? 'readonly' : 'default';
      } catch {
        return 'readonly';   // 失败关闭
      }
    },
    ruleFor,
    hostChoice,
    isListed,
    groupOf: (host) => groupOf(snap.rules, host),
    group: (name) => (name === DEFAULT_GROUP_NAME ? defaultGroup(snap.rules) : snap.rules.groups.find((g) => g.name === name) ?? null),
    groupHasDeny,
    allLogout: () => snap.rules.groups.flatMap((g) => g.logout),
    isLoginHost(host, group) {
      try {
        const logins = group === DEFAULT_GROUP_NAME ? snap.rules.loginHosts : snap.rules.groups.find((g) => g.name === group)?.loginHosts;
        return logins === undefined ? false : hostListed(logins, host);
      } catch {
        return false;
      }
    },
    refresh,
    state: (): RulesState => ({
      count: snap.rules.rules.length, hash: snap.hash, error,
      pending: pending === null ? null : { hash: pending.shortHash, tooLong: summaryTooLong(pending.summary) },
      pendingHash: pending?.shortHash ?? null,   // 报告用的短哈希；删文件没有哈希，是 null
      approvals, approvalsChanged,
    }),
    pending: pendingView,
    approvePending(hash): boolean {
      if (pending === null || pending.hash !== hash) return false;
      const { text } = pending;
      store.update((r) => ({ ...r, rules: text === null ? null : { hash: contentHash(text), text } }));
      snap = snapshotOf(store.get().rules);
      approvals = 'ok';   // 批准记录刚写成功，现在读得了
      pending = null;
      error = null;
      approvalsChanged = store.externallyChanged();
      return true;
    },
  };
}
