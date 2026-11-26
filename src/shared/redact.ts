// 脱敏（设计 5.7）：所有落盘和输出的内容先过这里。
// 正则都是写死的，每个可变长的部分都用互斥的字符类或边界断言收住，不会回溯爆炸。

export const REDACTED = '[REDACTED]';

const SENSITIVE_PARTS = ['password', 'passwd', 'pwd', 'secret', 'token', 'auth', 'cookie', 'apikey', 'api_key', 'api-key',
  'credential', 'signature', 'csrf', 'xsrf', 'sessionid', 'session_id', 'session-id'];
const SENSITIVE_EXACT = new Set(['pw', 'pass', 'otp', 'sid', 'sig']);
const NOT_SENSITIVE = new Set(['author', 'authors']);

// 不收单独的 `session`：内核自己的字段就叫 session / sessions。
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  if (NOT_SENSITIVE.has(k)) return false;
  return SENSITIVE_EXACT.has(k) || SENSITIVE_PARTS.some((p) => k.includes(p));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Bearer 不分大小写（日志里常见小写）；Basic 只认首字母大写，免得误伤普通英文里的 basic。
const AUTH_SCHEME = /\b([Bb][Ee][Aa][Rr][Ee][Rr]|Basic)([ \t]+)[A-Za-z0-9._~+/-]+=*/g;
const HEX = /(?<![A-Za-z0-9])[0-9A-Fa-f]{32,}(?![A-Za-z0-9])/g;
const B64URL = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g;
const URL_PARAM = /([?&#])([^=&#?\s"'<>]+)=([^&#\s"'<>()[\]{}`]+)/g;
const USERINFO = /:\/\/[^/\s:@?#]*(?::[^/\s?#]*)?@/g;
const COOKIE_LINE = /^([ \t]*(?:set-)?cookie:)[^\r\n]*/gim;
const COOKIE_PAIR = /^[^\s=;]+=[^;]*$/;

function isMixedCase(s: string): boolean {
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
}

// 整行是两组以上用 `; ` 分开的 `名字=值`（document.cookie 的样子）时，值换掉、名字保留。
function redactCookieLine(line: string): string {
  let core = line.trim();
  if (core === '') return line;
  const lead = line.slice(0, line.length - line.trimStart().length);
  const trail = line.slice(line.trimEnd().length);
  let quote = '';
  if (core.length >= 2 && (core[0] === '"' || core[0] === "'") && core[core.length - 1] === core[0]) {
    quote = core[0];
    core = core.slice(1, -1);
  }
  const pairs = core.split('; ');
  if (pairs.length < 2 || !pairs.every((p) => COOKIE_PAIR.test(p))) return line;
  const redacted = pairs.map((p) => `${p.slice(0, p.indexOf('='))}=${REDACTED}`).join('; ');
  return `${lead}${quote}${redacted}${quote}${trail}`;
}

export function redactText(s: string): string {
  let out = s.replace(JWT, REDACTED);
  out = out.replace(AUTH_SCHEME, (_m, scheme: string, gap: string) => `${scheme}${gap}${REDACTED}`);
  out = out.replace(HEX, REDACTED);
  out = out.replace(B64URL, (m) => (isMixedCase(m) ? REDACTED : m));
  out = out.replace(URL_PARAM, (m, sep: string, name: string) => (isSensitiveKey(safeDecode(name)) ? `${sep}${name}=${REDACTED}` : m));
  out = out.replace(USERINFO, `://${REDACTED}@`);
  out = out.replace(COOKIE_LINE, `$1 ${REDACTED}`);
  return out.split('\n').map(redactCookieLine).join('\n');
}

// `a=1&b=2` 形式：名字是敏感键的，值换掉；其余原样。
function redactParams(s: string): string {
  return s.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0 || eq === part.length - 1) return part;
    return isSensitiveKey(safeDecode(part.slice(0, eq))) ? `${part.slice(0, eq)}=${REDACTED}` : part;
  }).join('&');
}

export function redactUrl(u: string): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return redactText(u);
  }
  const hadUserinfo = url.username !== '' || url.password !== '';
  url.username = '';
  url.password = '';
  const href = url.href;
  // 序列化后的 href 里，第一个 `#` 开始片段，片段之前的第一个 `?` 开始查询（路径里的这两个字符都已编码）。
  const hashAt = href.indexOf('#');
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  let out = queryAt < 0 ? beforeHash : `${beforeHash.slice(0, queryAt)}?${redactParams(beforeHash.slice(queryAt + 1))}`;
  if (hashAt >= 0) out += `#${redactParams(href.slice(hashAt + 1))}`;
  if (hadUserinfo) {
    const prefix = `${url.protocol}//`;
    out = `${prefix}${REDACTED}@${out.slice(prefix.length)}`;
  }
  // 非敏感参数的值、路径里也可能有 token 形态的串。
  return redactText(out);
}

function mimeOf(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

function parseJsonContainer(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function looksLikeForm(body: string): boolean {
  return body !== '' && !/\s/.test(body) && body.split('&').every((p) => p.indexOf('=') > 0);
}

// 逐行找 `Content-Disposition:`，按 `;` 拆参数取 `name=`。不用跨行正则，免得构造的正文让匹配变成平方级。
function multipartSummary(body: string): string {
  const names: string[] = [];
  for (const line of body.split('\n')) {
    const header = line.trim();
    if (!header.toLowerCase().startsWith('content-disposition:')) continue;
    for (const param of header.split(';')) {
      const p = param.trim();
      if (!p.toLowerCase().startsWith('name=')) continue;
      names.push(redactText(p.slice(5).replace(/^"|"$/g, '')));
      break;
    }
  }
  return `[multipart: ${names.join(', ')}]`;
}

// JSON、表单按键脱敏；multipart 只留字段名；其他当文本。内容类型不是 JSON / 表单时，长得像的也照它们处理。
export function redactBody(body: string | null, contentType: string | null, max = 2000): string | null {
  if (body === null) return null;
  const mime = mimeOf(contentType);
  const isJsonType = mime === 'application/json' || mime.endsWith('+json');
  const isFormType = mime === 'application/x-www-form-urlencoded';
  let out: string;
  if (mime === 'multipart/form-data') {
    out = multipartSummary(body);
  } else {
    const trimmed = body.trimStart();
    const json = isJsonType || (!isFormType && (trimmed.startsWith('{') || trimmed.startsWith('[')))
      ? parseJsonContainer(body) : { ok: false as const };
    if (json.ok) out = JSON.stringify(redactDeep(json.value));
    else if (isFormType || (!isJsonType && looksLikeForm(body))) out = redactText(redactParams(body));
    else out = redactText(body);
  }
  return out.length > max ? `${out.slice(0, max)}…[truncated ${out.length}]` : out;
}

function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  // 用 defineProperty：键是 `__proto__` 时普通赋值会改原型，而不是建自有属性。
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function walk(v: unknown, extra: ReadonlySet<string>, skip: ReadonlySet<string>): unknown {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map((x: unknown) => walk(x, extra, skip));
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (isSensitiveKey(k) || extra.has(k.toLowerCase())) setOwn(out, k, REDACTED);
    else if (skip.has(k) && typeof val === 'string') setOwn(out, k, val);
    else setOwn(out, k, walk(val, extra, skip));
  }
  return out;
}

// 递归处理 JSON 形态的对象和数组，返回新值，不改入参。敏感键优先于 skipKeys；extraKeys 不分大小写，skipKeys 精确匹配。
export function redactDeep<T>(v: T, o?: { extraKeys?: readonly string[]; skipKeys?: readonly string[] }): T {
  const extra = new Set((o?.extraKeys ?? []).map((k) => k.toLowerCase()));
  const skip = new Set(o?.skipKeys ?? []);
  return walk(v, extra, skip) as T;
}
