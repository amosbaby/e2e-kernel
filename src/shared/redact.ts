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
// 邮箱，`%40` 编码的也认。本地部分有长度上限，域名标签的字符类不含 `.`，所以是线性的。
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}(?:@|%40)(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;
// 整个值像 token：标准 base64 或 base64url 字符，32 位以上，另需大小写字母和数字都有。只用在整个值上。
const TOKEN_VALUE = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;
// URL 参数、`名字=值` 的 `名字=`。名字前可以是开头、`?&#`、空白或常见的括号和分隔符；名字的字符类不含这些分隔符，
// 否则 `;a;a;a…` 这样的输入会让每个起点都扫到结尾。值在哪结束由 redactParamsInText 逐字符定，不交给正则。
const URL_PARAM_NAME = /(^|[?&#\s;,({\[])([^=&#?\s"'<>;,({\[]+)=/g;
const PARAM_VALUE_END = /[&#\s"<>]/;
// 选择器里的 `[名字 运算符 值]`：`[`、名字、`=` 之间可以有空白，运算符是 `=` 或 `~ | ^ $ *` 加 `=`。
// 名字的字符类不含空白、`=`、方括号和引号，和前后的 `\s*` 不相交，也不跨过下一个 `[`，所以不回溯。值在哪结束由 selectorValueEnd 定。
const SELECTOR_ATTR = /\[\s*([^\s=\[\]"']+?)\s*[~|^$*]?=\s*/g;
const USERINFO = /:\/\/[^/\s:@?#]*(?::[^/\s?#]*)?@/g;
// 自由文本里 JSON 形态的 `"名字" : "`，以及套了一层转义的 `\"名字\" : \"`。值的结尾由 redactJsonPairsInText 逐字符找。
const JSON_PAIR_NAME = /"([^"\\\r\n]{1,100})"\s*:\s*"/g;
const JSON_PAIR_NAME_ESC = /\\"([^"\\\r\n]{1,100})\\"\s*:\s*\\"/g;
// 行首的 `头名: 值`。头名是敏感键（cookie、authorization、x-api-key……）就换值。
const HEADER_LINE = /^([ \t]*)([A-Za-z0-9_-]{1,64}):[ \t]*([^\r\n]*)$/gm;
const COOKIE_PAIR = /^[^\s=;]+=[^;]*$/;

function isMixedCase(s: string): boolean {
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
}

// 整个值是 token 形态。以 `/` 开头或含 `//` 的是路径或网址，不算。
function tokenShaped(v: string): boolean {
  return v.length >= 32 && !v.startsWith('/') && !v.includes('//') && TOKEN_VALUE.test(v) && isMixedCase(v);
}

// 表单和 URL 参数的值：原值和（不把 `+` 当空格的）解码值各判一次；解码失败只判原值。
function tokenValue(raw: string): boolean {
  if (tokenShaped(raw)) return true;
  try {
    return tokenShaped(decodeURIComponent(raw));
  } catch {
    return false;
  }
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

// 自由文本里的 URL 参数，线性扫描：名字敏感时，值从 `=` 后一直到第一个 `&`、`#`、空白、`"`、`<`、`>` 或结尾
// （`?` 不结束值，空值也换掉），换成 [REDACTED] 后从值的结尾接着找；名字不敏感时从 `=` 后接着找，
// 所以 `?next=/cb?token=…` 里嵌套的 `?token=` 仍会被单独找到。
// selector 为真时（只用于选择器）：名字紧跟 `[` 的，值的结尾由 selectorValueEnd 定（和 redactSelectorAttrs 一致）；别的位置换到串尾。
function redactParamsInText(s: string, selector = false): string {
  const re = new RegExp(URL_PARAM_NAME.source, 'g');
  let out = '';
  let copied = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    if (!isSensitiveKey(safeDecode(m[2]!))) continue;   // lastIndex 停在 `=` 后；m[1] 是名字前的分隔符，不属于值
    let start = m.index + m[0].length;
    if (selector) {
      // 名字紧跟 `[`（中间可有空白）：属性值，到配对的 `]` 为止。别的位置不知道值在哪结束，换到串尾（失败关闭，再过一遍也不变）。
      let b = m.index + m[1]!.length - 1;
      while (b >= 0 && /\s/.test(s[b]!)) b--;
      const end = b >= 0 && s[b] === '[' ? selectorValueEnd(s, start) : s.length;
      out += s.slice(copied, start) + REDACTED;
      copied = end;
      re.lastIndex = end;
      continue;
    }
    const quote = s[start];
    if (quote === '"' || quote === "'") {
      // 值以引号开头：只换两个引号之间的内容（引号里的反斜杠跳过下一个字符），再从结束引号之后接着找。
      // 找不到结束引号就从值开头换到串尾（失败关闭）。
      start++;
      let close = -1;
      for (let i = start; i < s.length; i++) {
        if (s[i] === '\\') i++;
        else if (s[i] === quote) { close = i; break; }
      }
      out += s.slice(copied, start) + REDACTED;
      if (close < 0) return out;
      copied = close;
      re.lastIndex = close + 1;
      continue;
    }
    let end = start;
    while (end < s.length && !PARAM_VALUE_END.test(s[end]!)) end++;
    out += s.slice(copied, start) + REDACTED;
    copied = end;
    re.lastIndex = end;
  }
  return out + s.slice(copied);
}

// 选择器里属性值的结尾（不含）：从 start 起到配对的 `]` 为止。值里成对的方括号、反斜杠连同下一个字符、引号里的内容（含 `]`）
// 都算进值，空白和引号外的其他字符也是；所以已换成 [REDACTED] 的值再过一遍不变。找不到配对的 `]`、或引号没闭合，就到串尾（失败关闭）。
// 已知的边界：值里有不成对、也没转义、不在引号里的 `]`（比如 Playwright 正则值 `[token=/a]b/]`）时，`]` 之后的部分不换。
function selectorValueEnd(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return s.length;
      i = j;
    } else if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return s.length;
}

// 选择器里名字敏感的 `[名字 运算符 值]`，值换掉（含引号），名字、运算符、空白和 `]` 保留。名字不敏感时从值开头接着找。
function redactSelectorAttrs(s: string): string {
  const re = new RegExp(SELECTOR_ATTR.source, 'g');
  let out = '';
  let copied = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    if (!isSensitiveKey(safeDecode(m[1]!))) continue;
    const start = m.index + m[0].length;
    const end = selectorValueEnd(s, start);
    out += s.slice(copied, start) + REDACTED;
    copied = end;
    re.lastIndex = end;
  }
  return out + s.slice(copied);
}

// 自由文本里 JSON 形态的 `"名字":"值"`，名字是敏感键的，值换掉。逐字符找值的结尾，不交给正则回溯。
// 找不到结尾（引号没闭合）时，从值开头一直换到串尾，不再往后找（失败关闭）。
// 套了一层转义的形态（`\"名字\":\"值\"`）里，结束引号前恰好一个反斜杠；值里自带的引号是三个，不算结尾。
function redactJsonPairsInText(s: string, nameRe: RegExp, escaped: boolean): string {
  const re = new RegExp(nameRe.source, 'g');
  let out = '';
  let copied = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    if (!isSensitiveKey(m[1]!)) continue;
    const start = m.index + m[0].length;
    let close = -1;                                   // 值的结尾（不含）；-1 表示没找到
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (!escaped) {
        if (c === '\\') i++;
        else if (c === '"') { close = i; break; }
      } else if (c === '"') {
        let run = 0;
        while (i - 1 - run >= start && s[i - 1 - run] === '\\') run++;
        if (run === 1) { close = i - 1; break; }
      }
    }
    out += s.slice(copied, start) + REDACTED;
    if (close < 0) return out;
    copied = close;
    re.lastIndex = close + (escaped ? 2 : 1);
  }
  return out + s.slice(copied);
}

// 行首 `头名: 值`：头名是敏感键就整个值换掉（空值、非 ASCII、纯符号都换）。`Bearer`、`Basic` 方案名留下。
function redactHeaderLines(s: string): string {
  return s.replace(HEADER_LINE, (m, lead: string, name: string, value: string) => {
    if (!isSensitiveKey(name)) return m;
    const scheme = /^(?:bearer|basic)[ \t]+/i.exec(value)?.[0] ?? '';
    return `${lead}${name}: ${scheme}${REDACTED}`;
  });
}

export function redactText(s: string): string {
  return redactTextWith(s, false);
}

// 选择器（agent 给的目标、内核生成的稳定选择器）专用：在 redactText 之外，名字敏感的属性 `[名字 运算符 值]`（`=` 两边可有空白）
// 的值换到配对的 `]` 为止（见 selectorValueEnd），不把后面的选择器一起吞掉。自由文本仍用 redactText。
export function redactSelector(s: string): string {
  return redactTextWith(s, true);
}

function redactTextWith(s: string, selector: boolean): string {
  let out = s.replace(JWT, REDACTED);
  out = out.replace(AUTH_SCHEME, (_m, scheme: string, gap: string) => `${scheme}${gap}${REDACTED}`);
  out = out.replace(USERINFO, `://${REDACTED}@`);     // 先于邮箱：`://用户名:密码@主机` 要整段换掉
  out = out.replace(EMAIL, REDACTED);
  out = out.replace(HEX, REDACTED);
  out = out.replace(B64URL, (m) => (isMixedCase(m) ? REDACTED : m));
  if (selector) out = redactSelectorAttrs(out);
  out = redactParamsInText(out, selector);
  out = redactJsonPairsInText(out, JSON_PAIR_NAME, false);
  out = redactJsonPairsInText(out, JSON_PAIR_NAME_ESC, true);
  out = redactHeaderLines(out);
  return out.split('\n').map(redactCookieLine).join('\n');
}

// `a=1&b=2` 形式：名字是敏感键的，值换掉；名字不敏感时，值先解码再判（接住 URL 编码的 JSON 里的邮箱），
// 解码后过 redactText 有变化、或整个值是 token 形态，就整个值换掉。名字照旧保留，解码后的内容不会写回去。
function redactParams(s: string): string {
  return s.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0 || eq === part.length - 1) return part;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (isSensitiveKey(safeDecode(name))) return `${name}=${REDACTED}`;
    const decoded = safeDecode(value);
    return redactText(decoded) !== decoded || tokenValue(value) ? `${name}=${REDACTED}` : part;
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
    if (json.ok) out = jsonRedacted(json.value);
    else if (isFormType || (!isJsonType && looksLikeForm(body))) out = redactText(redactParams(body));
    else out = redactText(body);
  }
  return out.length > max ? `${out.slice(0, max)}…[truncated ${out.length}]` : out;
}

// 失败关闭：出任何异常都给固定标记，绝不退回去输出原文。
function jsonRedacted(value: unknown): string {
  try {
    return JSON.stringify(redactDeep(value));
  } catch {
    return REDACTED;
  }
}

function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  // 用 defineProperty：键是 `__proto__` 时普通赋值会改原型，而不是建自有属性。
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

// 嵌套超过这么多层的对象或数组整个换成 REDACTED：页面可以给出很深的 JSON，不能让递归爆栈。
const MAX_DEPTH = 64;

function walk(v: unknown, extra: ReadonlySet<string>, skip: ReadonlySet<string>, sel: ReadonlySet<string>, inSel: boolean, depth: number): unknown {
  if (typeof v === 'string') return tokenShaped(v) ? REDACTED : inSel ? redactSelector(v) : redactText(v);
  if (typeof v !== 'object' || v === null) return v;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(v)) return v.map((x: unknown) => walk(x, extra, skip, sel, inSel, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (isSensitiveKey(k) || extra.has(k.toLowerCase())) setOwn(out, k, REDACTED);
    else if (skip.has(k) && typeof val === 'string') setOwn(out, k, val);
    else setOwn(out, k, walk(val, extra, skip, sel, sel.has(k), depth + 1));
  }
  return out;
}

// 递归处理 JSON 形态的对象和数组，返回新值，不改入参。嵌套超过 MAX_DEPTH 层的子树整个换成 REDACTED。敏感键优先于 skipKeys；extraKeys 不分大小写，skipKeys 精确匹配。
// 值是字符串、或字符串数组的 selectorKeys（精确匹配）用 redactSelector，其余用 redactText；选择器键下面的对象里，别的键照常用 redactText。
export function redactDeep<T>(v: T, o?: { extraKeys?: readonly string[]; skipKeys?: readonly string[]; selectorKeys?: readonly string[] }): T {
  const extra = new Set((o?.extraKeys ?? []).map((k) => k.toLowerCase()));
  const skip = new Set(o?.skipKeys ?? []);
  return walk(v, extra, skip, new Set(o?.selectorKeys ?? []), false, 0) as T;
}
