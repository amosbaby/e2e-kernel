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
// 选择器里的 `名字=`：和 URL_PARAM_NAME 一样，只是名字前的分隔符另外认引号和 `=`（`text=token=…`、`[name="token=…"]`），
// 并且分隔符放在后顾里，前一个匹配吃掉的 `=` 也能当分隔符。名字的字符类不含这些分隔符，所以每段名字只有一个起点，不回溯。
// 宽的名字可以含 `]`（`pw]x=`、`[token]=` 按整段判），窄的把 `]` 也当分隔符（`[pw=1]sessionid=` 里第一个值的扫描会跨过第二个名字，
// 要单独找到它）；窄的名字不能含 `]`，否则每个 `]` 后都成起点、扫到串尾。
// _PLAIN 的名字和 `=` 之间只认空白（`pw =x`）；另外两条还认不含 `*`、`=` 的注释（`pw /**/ =x`）。这两条的名字不能以 `/*` 开头、
// 名字里也不能有 `*/`，所以注释的开头和收尾都当不了名字的起点，一串空白和注释前最多一个起点；名字和名字后的空白、注释再用
// 「先行断言加反向引用」做成原子的（不回溯）。不然 `/**/ /**/ …`、`/* x */ /* x */ …` 会让每个起点都扫到串尾。
// 名字中间夹注释的（`t/*x*/oken=`）交给 _PLAIN；认注释的那两条又会把注释吞进前一个名字（`x /*pw*/=` 里的 `pw`），所以四条都跑、结果取并集。
const SELECTOR_PARAM_NAME_WIDE_PLAIN = /(?<=(^|[?&#\s;,({\["'=]))([^=&#?\s"'<>;,({\[]+)\s*=/g;
const SELECTOR_PARAM_NAME_NARROW_PLAIN = /(?<=(^|[?&#\s;,({\[\]"'=]))([^=&#?\s"'<>;,({\[\]]+)\s*=/g;
const SELECTOR_PARAM_NAME_WIDE = /(?<=(^|[?&#\s;,({\["'=]))(?!\/\*)(?=((?:[^=&#?\s"'<>;,({\[*]|\*(?!\/))+))\2(?=((?:\s|\/\*[^*=]*\*\/)*))\3=/g;
const SELECTOR_PARAM_NAME_NARROW = /(?<=(^|[?&#\s;,({\[\]"'=]))(?!\/\*)(?=((?:[^=&#?\s"'<>;,({\[\]*]|\*(?!\/))+))\2(?=((?:\s|\/\*[^*=]*\*\/)*))\3=/g;
const SELECTOR_PARAM_NAMES = [SELECTOR_PARAM_NAME_WIDE_PLAIN, SELECTOR_PARAM_NAME_NARROW_PLAIN, SELECTOR_PARAM_NAME_WIDE, SELECTOR_PARAM_NAME_NARROW];
// 属性选择器的 `]` 后面常见的接续字符：空白、下一个属性或谓词、伪类、类、id、组合符、逗号、`)`，以及 XPath 的 `/`、`]`、`|`。
// 不在里面的（引号、XPath 的 `=`、`!=`、`<`、`*`、`-`，CSS 嵌套的 `&`）按值的一部分处理、换到串尾：少数合法写法会多换，偏向失败关闭。
const ATTR_FOLLOW = /[\s[\]:.#>+~,)/|]/;
const ATTR_OPS = new Set(['~', '|', '^', '$', '*', '!']);   // `!=` 是 XPath 的
const USERINFO = /:\/\/[^/\s:@?#]*(?::[^/\s?#]*)?@/g;
// 自由文本里 JSON 形态的 `"名字" : "`，以及套了一层转义的 `\"名字\" : \"`。值的结尾由 redactJsonPairsInText 逐字符找。
const JSON_PAIR_NAME = /"([^"\\\r\n]{1,100})"\s*:\s*"/g;
const JSON_PAIR_NAME_ESC = /\\"([^"\\\r\n]{1,100})\\"\s*:\s*\\"/g;
// 行首的 `头名: 值`。头名是敏感键（cookie、authorization、x-api-key……）就换值。
// 行中间的 `名字: 值`（名字后可带一个引号，接住 `"password": 123`、`'token': '…'`）。名字前不能是名字字符，名字最长 64，不回溯。
const COLON_PAIR_NAME = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{1,64})["']?[ \t]*:([ \t]*)/g;
const COLON_VALUE_END = /[\s,;})\]"'<>]/;
// 参数值外面的实体引号、转义引号：只换两者之间的内容。
const URL_NAME_DELIM = /[?&#\s;,({\[]/;               // URL_PARAM_NAME 里名字前的分隔符
const ENTITY_QUOTES = ['&quot;', '&#34;', '&#x22;', '&#X22;', '&apos;', '&#39;', '&#x27;', '&#X27;', '\\"', "\\'"];
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
// 给了 selectorRe 时（只用于选择器，SELECTOR_PARAM_NAMES 之一）：名字前的分隔符另外认引号和 `=`（窄的还认 `]`）；
// 名字紧跟 `[`（中间可有空白）、本身不含 `]` 的，值的结尾由 selectorValueEnd 定（和 redactSelectorAttrs 一致）；别的位置换到串尾。
// decode 为真时（自由文本的顶层调用）：名字不敏感、值里有 `%` 的，解码后露出秘密就整个值换掉（见 decodedRevealsSecret；嵌套的值另查自己那一段）。
// 值以实体引号或转义引号开头（`&quot;…&quot;`、`\"…\"`）时，只换两者之间的内容；找不到结尾就换到串尾。
function redactParamsInText(s: string, selectorRe?: RegExp, decode = false): string {
  const selector = selectorRe !== undefined;
  const re = new RegExp((selectorRe ?? URL_PARAM_NAME).source, 'g');
  let out = '';
  let copied = 0;
  // 把 [from, to) 换成 [REDACTED]。解码命中后会回到被换的值里接着扫（里面可能嵌着原样的敏感参数，它带引号的值可能伸到外面），
  // 所以可能和已换的部分重叠：只补没换到的那段。
  const emit = (from: number, to: number): void => {
    if (to <= copied) return;
    if (from >= copied) out += s.slice(copied, from);
    out += REDACTED;
    copied = to;
  };
  let checkedEnd = -1;                                     // 上一个整段做过解码检查的值的结尾
  // 从 at 起到第一个 PARAM_VALUE_END 字符（不含）：上次找到的结尾记下来，起点不超过它的，结尾也是它（中间没有这类字符），不重扫。
  // 回扫（解码命中后、引号尾巴之后）时起点只会落在已扫过的范围里，所以总量线性。
  let scanEnd = -1;
  const valueEnd = (at: number): number => {
    let e = at <= scanEnd ? scanEnd : at;
    while (e < s.length && !PARAM_VALUE_END.test(s[e]!)) e++;
    scanEnd = e;
    return e;
  };
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    // lastIndex 停在 `=` 后；m[1] 是名字前的分隔符，不属于值（选择器模式下在后顾里）。选择器模式下名字另按 selectorNameSensitive 判（`/cb/pw=`、`data-pw=`）。
    if (!isSensitiveKey(safeDecode(m[2]!)) && !(selector && selectorNameSensitive(m[2]!))) {
      if (!decode) continue;
      const vStart = m.index + m[0].length;
      const vEnd = valueEnd(vStart);
      // 同一结尾的值嵌在前一个值里（`next=/cb?ret=token%3D…`）：整段已查过，但上下文不同（整段里它前面是 `=`），
      // 所以只查它自己这一段（到下一个名字分隔符为止）。各段互不重叠，整段每个结尾只查一次，总量线性。
      let checkTo = vEnd;
      if (vEnd === checkedEnd) {
        checkTo = vStart;
        while (checkTo < vEnd && !URL_NAME_DELIM.test(s[checkTo]!)) checkTo++;
      } else checkedEnd = vEnd;
      const value = s.slice(vStart, checkTo);
      if (!value.includes('%') || !decodedRevealsSecret(value)) continue;
      emit(vStart, vEnd);
      re.lastIndex = vStart;                               // 回到值里接着找原样的嵌套名字（`a=%2F…?token="x"`）
      continue;
    }
    let start = m.index + m[0].length;
    if (selector) {
      // 名字紧跟 `[`（中间可有空白）：属性值，到配对的 `]` 为止。别的位置不知道值在哪结束，换到串尾（失败关闭，再过一遍也不变）。
      while (start < s.length && /\s/.test(s[start]!)) start++;   // `=` 后的空白保留（和 redactSelectorAttrs 一致）
      const attrLike = bracketBefore(s, m.index - 1) || nameStartsInBracketComment(s, m.index, m[2]!);
      const end = attrLike && !m[2]!.includes(']') ? selectorValueEnd(s, start) : s.length;
      emit(start, end);
      re.lastIndex = end;
      continue;
    }
    const qv = quotedValue(s, start);
    if (qv !== null) {
      // 值以引号开头（含实体、转义引号）：只换两个引号之间的内容，再从结束引号之后接着找；结束引号后面紧跟着别的字符
      // （`token='a'x`）时，那一段也换到值的结尾。找不到结束引号就从值开头换到串尾（失败关闭）。
      if (qv.close < 0) {
        emit(qv.from, s.length);
        return out;
      }
      emit(qv.from, qv.close);
      const after = qv.close + qv.closeLen;
      const tail = valueEnd(after);
      if (tail > after) emit(after, tail);
      // 尾巴里可能嵌着原样的敏感参数（`token="a",password="x"`），回去接着找；从结束引号的最后一个字符起，
      // 实体引号结尾的 `;` 也能当后面名字的分隔符（`token=&quot;&quot;token="x"`）。
      re.lastIndex = after - 1;
      continue;
    }
    const end = valueEnd(start);
    emit(start, end);
    re.lastIndex = end;
  }
  return out + s.slice(copied);
}

// 选择器里属性值的结尾（不含）：从 start 起到配对的 `]` 为止。值里成对的方括号、反斜杠连同下一个字符、引号里的内容（含 `]`）
// 都算进值，空白和引号外的其他字符也是；所以已换成 [REDACTED] 的值再过一遍不变。`/* … */` 注释和引号一样整段算进值（里面的 `]` 不算结尾）。
// 找不到配对的 `]`、引号或注释没闭合，就到串尾（失败关闭）。
// 配对的 `]` 后面是接不上属性选择器的字符（`[token=/a]b/]` 里的 `b`）时，这个 `]` 只可能是值的一部分，也到串尾。
// 已知的边界：值里有不成对、也没转义、不在引号里的 `]`，后面又恰好是能接上的字符（空白、`[`、`]`、`:`、`.`、`#`、`>`、`+`、`~`、`,`、`)`、`/`、`|`）时，
// `]` 之后的部分不换。
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
    } else if (c === '/' && s[i + 1] === '*') {
      const k = s.indexOf('*/', i + 2);
      if (k < 0) return s.length;
      i = k + 1;
    } else if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i + 1 >= s.length || ATTR_FOLLOW.test(s[i + 1]!) ? i : s.length;
      depth--;
    }
  }
  return s.length;
}

// 从 b 往回跳过空白和完整的 `/* … */` 注释后是不是 `[`（`[/* c */ pw /* c */= x]` 里的 `pw` 是属性名）。注释体里不会有 `*/`，
// 往回找 `/*` 时先碰到另一个 `*/` 就不是注释；每段只扫一次。
function bracketBefore(s: string, b: number): boolean {
  for (;;) {
    while (b >= 0 && /\s/.test(s[b]!)) b--;
    if (b < 1 || s[b] !== '/' || s[b - 1] !== '*') return b >= 0 && s[b] === '[';
    let k = b - 2;
    while (k >= 1 && !(s[k - 1] === '/' && s[k] === '*') && !(s[k - 1] === '*' && s[k] === '/')) k--;
    if (k < 1 || s[k - 1] !== '/' || s[k] !== '*') return false;
    b = k - 2;
  }
}

// 名字是从 `[` 后一段带空白的注释中间截出来的（`[/* c */pw = x]` 里的 `*/pw`）：名字里有 `*/`，往回找这段注释的 `/*`
// （先碰到 `*/` 就不是），`/*` 前跳过空白和完整的注释是 `[`（见 bracketBefore）。往回扫到上一个注释记号为止，每段注释体最多扫一次。
function nameStartsInBracketComment(s: string, nameStart: number, name: string): boolean {
  if (!name.includes('*/')) return false;
  for (let k = nameStart - 1; k >= 0; k--) {
    if (s[k] === '*' && s[k + 1] === '/') return false;
    if (s[k] === '/' && s[k + 1] === '*') return bracketBefore(s, k - 1);
  }
  return false;
}

// CSS 转义在 i 处（s[i] 是 `\`）的结尾（不含）：`\` 加 1–6 位十六进制、可再跟一个空白；或者 `\` 加任意一个字符。
function cssEscapeEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length && j - i <= 6 && /[0-9A-Fa-f]/.test(s[j]!)) j++;
  if (j === i + 1) return Math.min(j + 1, s.length);
  return j < s.length && /\s/.test(s[j]!) ? j + 1 : j;
}

// 选择器里的名字是否敏感：先解开 CSS 转义；原样的名字、还原后的名字、URL 解码后的名字、只解合法 `%XX` 的宽松解码结果
// （非法的 `%` 原样留下，不影响别处编码过的字符）、去掉 `/* … */` 注释后的名字（`t/*x*/oken`），或其中按非字母数字字符分出的任一段
// 是敏感键，就算敏感
// （`data-pw`、`data_pass`、`ns|pw`、`@ns:pw`、`data.pw`、`/cb/pw`、`%|p%77`；拿不准时偏向敏感）。
function selectorNameSensitive(raw: string): boolean {
  if (isSensitiveKey(raw)) return true;
  if (!/[^A-Za-z0-9]/.test(raw)) return false;            // 纯字母数字：没有转义、分段和编码，上一行已经判完
  let name = '';
  for (let i = 0; i < raw.length;) {
    if (raw[i] !== '\\') {
      name += raw[i];
      i++;
      continue;
    }
    const end = cssEscapeEnd(raw, i);
    const body = raw.slice(i + 1, end).trim();
    if (/^[0-9A-Fa-f]+$/.test(body)) {
      const cp = parseInt(body, 16);
      name += cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
    } else name += body;
    i = end;
  }
  const lenient = name.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  const candidates = [raw, name, safeDecode(name), lenient, withoutComments(name)];
  return candidates.some((n) => isSensitiveKey(n) || n.split(/[^A-Za-z0-9]+/).some((part) => isSensitiveKey(part)));
}

// 去掉 `/* … */` 注释；没闭合的注释连同后面全部去掉。逐段找，线性。
function withoutComments(s: string): string {
  let out = '';
  let i = 0;
  for (let k = s.indexOf('/*'); k >= 0; k = s.indexOf('/*', i)) {
    out += s.slice(i, k);
    const e = s.indexOf('*/', k + 2);
    if (e < 0) return out;
    i = e + 2;
  }
  return out + s.slice(i);
}

// 选择器里名字敏感的 `[名字 运算符 值]`，值换掉（含引号），名字、运算符、空白和 `]` 保留。手写扫描，不交给正则：
// `[`、名字、运算符、`=` 之间可以有空白；运算符是 `~ | ^ $ * !` 加 `=`；名字到空白、`=`、方括号、引号或「运算符=」为止，
// 反斜杠转义（见 cssEscapeEnd）算进名字。comments 为真时，`[`、名字、运算符、`=` 之间的 `/* … */` 注释也当空白，
// 紧贴名字或在名字中间的注释算进名字（`t/*x*/oken`，判敏感时去掉）；注释没闭合时名字到此为止，敏感名后面的注释没闭合时，
// 从名字结尾换到串尾（失败关闭）。调用方两种各跑一遍：两遍都只把值换成 [REDACTED]，结果是并集，认注释不会比不认注释漏得多
// （开头注释没闭合、注释里的 `[`，不认注释的那遍能接住）。
// 没匹配上就从名字里最后一个转义的 `[`（没有就从名字结尾）找下一个 `[`：名字里（注释外）不含真正的 `[`，所以只有最后一个转义的 `[`
// 可能另起一个属性（名字中注释里的 `[` 由不认注释的那遍接住）；每个字符最多扫两次。找 `*/` 的结果记下来，同一段注释不重复扫。
function redactSelectorAttrs(s: string, comments: boolean): string {
  let out = '';
  let copied = 0;
  let commentFrom = -1;
  let commentEnd = -1;                                     // 上次从 commentFrom 找到的 `*/` 之后的位置；-1 表示到串尾都没有
  const closeAfter = (from: number): number => {
    if (commentFrom >= 0 && from >= commentFrom && (commentEnd < 0 || from <= commentEnd - 2)) return commentEnd;
    const k = s.indexOf('*/', from);
    commentFrom = from;
    commentEnd = k < 0 ? -1 : k + 2;
    return commentEnd;
  };
  // 跳过空白和注释；注释没闭合返回 -1。
  const gap = (from: number): number => {
    let j = from;
    for (;;) {
      if (j < s.length && /\s/.test(s[j]!)) j++;
      else if (comments && s[j] === '/' && s[j + 1] === '*') {
        j = closeAfter(j + 2);
        if (j < 0) return -1;
      } else return j;
    }
  };
  // 认注释时，注释里的 `[` 不当属性开头（不认注释的那遍会接住）：没匹配上就从这次扫到的最远处（far）往后找下一个 `[`，
  // 扫过的地方除了名字里转义的 `[` 都不会再扫，所以是线性的。不认注释时从名字结尾找（名字后面的空白里不会有 `[`）。
  let i = s.indexOf('[');
  while (i >= 0) {
    let j = gap(i + 1);
    if (j < 0) break;                                      // 只在认注释时出现：后面整个是没闭合的注释
    const nameStart = j;
    let escBracket = -1;                                   // 名字里最后一个被转义的 `[`：没匹配上时它也可能是属性开头
    while (j < s.length) {
      const c = s[j]!;
      if (c === '\\') {
        if (s[j + 1] === '[') escBracket = j + 1;
        j = cssEscapeEnd(s, j);
      }
      else if (comments && c === '/' && s[j + 1] === '*') {
        const e = closeAfter(j + 2);                       // 名字里（或紧贴名字）的注释算进名字，判敏感时去掉；没闭合就到此为止
        if (e < 0) break;
        j = e;
      }
      else if (/[\s=[\]"']/.test(c) || (ATTR_OPS.has(c) && s[j + 1] === '=')) break;
      else j++;
    }
    const nameEnd = j;
    const sensitive = (): boolean => nameEnd > nameStart && selectorNameSensitive(s.slice(nameStart, nameEnd));
    j = gap(j);
    if (j < 0) {
      if (sensitive()) {
        out += s.slice(copied, nameEnd) + REDACTED;
        copied = s.length;
        break;
      }
      if (escBracket < 0) break;
      i = escBracket;
      continue;
    }
    let far = j;
    if (j < s.length && ATTR_OPS.has(s[j]!)) {
      // 运算符和 `=` 之间也可以有空白、注释，运算符也可以重复（`[pw ^ =x]`、`[pw ^ ^=x]`，不是合法 CSS，但要接住）；j 停在最后一个运算符上。
      let k = gap(j + 1);
      while (k >= 0 && k < s.length && ATTR_OPS.has(s[k]!)) {
        j = k;
        k = gap(k + 1);
      }
      if (k < 0 && sensitive()) {                          // 敏感名的运算符后面注释没闭合：从运算符后换到串尾（失败关闭）
        out += s.slice(copied, j + 1) + REDACTED;
        copied = s.length;
        break;
      }
      far = k < 0 ? s.length : k;
      if (k >= 0 && s[k] === '=') j = k;
    }
    if (s[j] === '=' && sensitive()) {
      j++;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      const end = selectorValueEnd(s, j);
      out += s.slice(copied, j) + REDACTED;
      copied = end;
      i = s.indexOf('[', end);
      continue;
    }
    i = escBracket >= 0 ? escBracket : s.indexOf('[', comments ? Math.max(nameEnd, far) : nameEnd);
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

// 值以引号开头（普通引号，或 ENTITY_QUOTES 里的实体、转义引号）：返回引号内容的起点、结束引号的位置（没闭合是 -1）和它的长度。
// 普通引号里的反斜杠跳过下一个字符。
function quotedValue(s: string, start: number): { from: number; close: number; closeLen: number } | null {
  const opener = ENTITY_QUOTES.find((q) => s.startsWith(q, start));
  if (opener !== undefined) {
    const from = start + opener.length;
    return { from, close: s.indexOf(opener, from), closeLen: opener.length };
  }
  const quote = s[start];
  if (quote !== '"' && quote !== "'") return null;
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === quote) return { from: start + 1, close: i, closeLen: 1 };
  }
  return { from: start + 1, close: -1, closeLen: 1 };
}

// 行中间的 `名字: 值`（行首的由 redactHeaderLines 整行换）：名字敏感时，值换掉。值以引号开头就换到结束引号（找不到就到串尾），
// 否则换到空白、`,`、`;`、括号、引号或尖括号为止；`Bearer`、`Basic` 方案名留下；已是 [REDACTED] 的不再换（幂等）。
// 引号包括实体、转义引号；结束引号后紧跟的内容（`password: "a"x`）也换。引号没闭合时，多半是外面一段引号文本的结束引号
// （`label:has-text("Password: ")`）：选择器里不换，自由文本里只换到下一个空白或分隔符（`password: "x` 里的 `x`）。
// 不换的还有：`名字:=`（交给参数规则）、冒号后紧跟 1–5 位、不超过 65535 的数字再接 `/` 或 `:` 的端口（`auth:8080/`、`auth-service:50051:`），
// 以及冒号后没有空白、名字前是 `.` 或 `#`、值是小写字母和 `-` 并接着 `{`、`,`、`(` 的 CSS 伪类（`.password:focus {`）。
// selector 为真时冒号后必须有空白：选择器里 `#auth:hover`、`.password:focus` 是伪类，不是键值对。
function redactColonPairs(s: string, selector: boolean): string {
  const re = new RegExp(COLON_PAIR_NAME.source, 'g');
  let out = '';
  let copied = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    if (!isSensitiveKey(m[1]!) || (selector && m[2] === '')) continue;
    const before = s[m.index - 1];
    let start = m.index + m[0].length;
    if (m[2] === '' && (before === '.' || before === '#') && /^[a-z-]+\s*[{,(]/.test(s.slice(start, start + 64))) continue;
    if (s[start] === '=') continue;
    start += /^(?:bearer|basic)[ \t]+/i.exec(s.slice(start, start + 16))?.[0].length ?? 0;
    if (s.startsWith(REDACTED, start)) {
      re.lastIndex = start + REDACTED.length;
      continue;
    }
    const qv = quotedValue(s, start);
    if (qv !== null && qv.close >= 0) {
      out += s.slice(copied, qv.from) + REDACTED;
      const after = qv.close + qv.closeLen;
      let tail = after;
      if (!s.startsWith(REDACTED, after)) while (tail < s.length && !COLON_VALUE_END.test(s[tail]!)) tail++;
      if (tail > after) out += s.slice(qv.close, after) + REDACTED;
      copied = tail > after ? tail : qv.close;
      re.lastIndex = tail;
      continue;
    }
    if (qv !== null) {
      if (selector || s.startsWith(REDACTED, qv.from)) continue;
      start = qv.from;
    }
    let digits = start;
    while (digits < s.length && digits - start < 6 && s[digits]! >= '0' && s[digits]! <= '9') digits++;
    const port = digits - start <= 5 && Number(s.slice(start, digits)) <= 65535;
    if (m[2] === '' && digits > start && port && (s[digits] === '/' || s[digits] === ':')) continue;
    let end = start;
    while (end < s.length && !COLON_VALUE_END.test(s[end]!)) end++;
    if (end === start) continue;
    out += s.slice(copied, start) + REDACTED;
    copied = end;
    re.lastIndex = end;
  }
  return out + s.slice(copied);
}

// 只解合法的 `%XX`（逐字节，不管 UTF-8），`+` 当空白；不会失败，所以整段解码后一定含着它任一后缀的解码。
function lenientDecode(s: string): string {
  return s.replace(/\+/g, ' ').replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

// 参数值编码过（可能不止一层）时，最多解三层；任一层不带解码地过 redactText 有变化、或按 `=` 切开后有一段是 token 形态，就算露出了秘密。
function decodedRevealsSecret(value: string): boolean {
  let cur = value;
  for (let n = 0; n < 3; n++) {
    const next = lenientDecode(cur);
    if (next === cur) return false;
    if (redactTextWith(next, false, false) !== next || next.split(/=+/).some(tokenValue)) return true;
    cur = next;
  }
  return false;
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
// 各条规则依次跑一遍不一定是不动点（比如自由文本的 cookie 行规则会改动已换过的属性值），所以反复跑到不再变化，最多 4 遍；
// 还在变就整个换掉（失败关闭）。这样再过一遍一定不变。
export function redactSelector(s: string): string {
  let cur = redactTextWith(s, true);
  for (let n = 0; n < 3; n++) {
    const next = redactTextWith(cur, true);
    if (next === cur) return cur;
    cur = next;
  }
  return REDACTED;
}

function redactTextWith(s: string, selector: boolean, decode = true): string {
  let out = s.replace(JWT, REDACTED);
  out = out.replace(AUTH_SCHEME, (_m, scheme: string, gap: string) => `${scheme}${gap}${REDACTED}`);
  out = out.replace(USERINFO, `://${REDACTED}@`);     // 先于邮箱：`://用户名:密码@主机` 要整段换掉
  out = out.replace(EMAIL, REDACTED);
  out = out.replace(HEX, REDACTED);
  out = out.replace(B64URL, (m) => (isMixedCase(m) ? REDACTED : m));
  if (selector) out = redactSelectorAttrs(redactSelectorAttrs(out, false), true);
  out = selector ? SELECTOR_PARAM_NAMES.reduce((acc, re) => redactParamsInText(acc, re), out) : redactParamsInText(out, undefined, decode);
  out = redactJsonPairsInText(out, JSON_PAIR_NAME, false);
  out = redactJsonPairsInText(out, JSON_PAIR_NAME_ESC, true);
  out = redactHeaderLines(out);
  out = redactColonPairs(out, selector);
  return out.split('\n').map(redactCookieLine).join('\n');
}

// `a=1&b=2` 形式：名字是敏感键的，值换掉；名字不敏感时，值本身或解码后（最多三层，见 decodedRevealsSecret）过 redactText 有变化、
// 或按 `=` 切开后有一段是 token 形态（`a=b=<token>`），就整个值换掉（接住 URL 编码的 JSON 里的邮箱）。这里的值是 `&` 之间的全部、
// 名字可以是任意字符，和自由文本的参数规则（值到 `&#`、空白、引号、尖括号为止）不等价，所以两边都查。名字照旧保留，解码后的内容不会写回去。
function redactParams(s: string): string {
  return s.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0 || eq === part.length - 1) return part;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (isSensitiveKey(safeDecode(name))) return `${name}=${REDACTED}`;
    const hit = value.split(/=+/).some(tokenValue) || redactTextWith(value, false, false) !== value || decodedRevealsSecret(value);
    return hit ? `${name}=${REDACTED}` : part;
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
