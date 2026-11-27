// 写请求里的 GraphQL 分类：`graphqlKind` 只给报告分组；拦截只用 `isStrictQuery`（和 `isPersistedOnly`，它只决定拦截的原因）。输入是驱动给的原始请求体（已被截到 MAX_BODY 字节）。
// 原则：拿不准一律给 'unknown'，绝不把拿不准的判成 'query'；返回值只是这四个词或 null，不带体里的任何内容。

export type GraphqlKind = 'query' | 'mutation' | 'subscription' | 'unknown';

// 驱动先按字节把请求体截到 64 KB、再按 utf8 解码（解码后的字节数不会比截断前少）。
// 字节数到了这个数就当作可能被截断：尾部可能藏着任何东西，除了已经看到 mutation，一律不判。
const MAX_BODY_BYTES = 64 * 1024;

const WORD = /[_0-9A-Za-z]/;
// GraphQL 词法里合法的标点（括号另处理）；其余字符说明文档不合法或我们读不懂，不下结论。
const PUNCT = '!$&.:=@|-+';

// 线性扫描一份 GraphQL 文档：跳过字符串、块字符串和 # 注释，括号用栈配对；
// 只有在深度 0、而且前一个有效记号是文档开头或上一个定义的 `}` 时，query / mutation / subscription / 匿名 `{` 才算定义的开头。
// 字段名、变量名、指令名、片段名都在别处出现，不会被当成定义。mutation > subscription > query；
// 括号不配对、字符串没结尾、定义开头是 query / mutation / subscription / fragment 以外的词（type、scalar、extend……）、
// 出现不合法的字符时，除了已经看到 mutation 的情况，一律 'unknown'。
function scanDocument(doc: string): GraphqlKind {
  let mutation = false; let subscription = false; let query = false; let broken = false;
  const stack: string[] = [];   // 期待的右括号
  let atStart = true;   // 下一个深度 0 的记号是否可能开始一个新定义
  const n = doc.length;
  let i = 0;
  while (i < n) {
    const c = doc[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') { i++; continue; }   // U+2028/2029 不是 GraphQL 的空白：走下面的非法字符分支
    if (c === '#') {
      while (i < n && doc[i] !== '\n' && doc[i] !== '\r') i++;
      continue;
    }
    if (c === '"') {
      if (doc.startsWith('"""', i)) {
        i += 3;
        let closed = false;
        while (i < n) {
          if (doc.startsWith('\\"""', i)) { i += 4; continue; }
          if (doc.startsWith('"""', i)) { i += 3; closed = true; break; }
          i++;
        }
        if (!closed) broken = true;
      } else {
        i++;
        let closed = false;
        while (i < n) {
          const d = doc[i]!;
          if (d === '\\') { i += 2; continue; }
          if (d === '"') { i++; closed = true; break; }
          if (d === '\n' || d === '\r') break;   // 普通字符串不能跨行
          i++;
        }
        if (!closed) broken = true;
      }
      // 深度 0 的字符串是 Description，可以写在定义前面：不改 atStart。
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      if (stack.length === 0) {
        if (c === '{' && atStart) query = true;
        atStart = false;
      }
      stack.push(c === '{' ? '}' : c === '(' ? ')' : ']');
      i++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      const want = stack.pop();
      if (want !== c) broken = true;   // 多出来的右括号，或类型不配对
      if (stack.length === 0) atStart = want === c && c === '}';
      i++;
      continue;
    }
    if (WORD.test(c)) {
      let j = i + 1;
      while (j < n && WORD.test(doc[j]!)) j++;
      if (stack.length === 0) {
        if (atStart) {
          const w = doc.slice(i, j);
          if (w === 'mutation') mutation = true;
          else if (w === 'subscription') subscription = true;
          else if (w === 'query') query = true;
          else if (w !== 'fragment') broken = true;
        }
        atStart = false;
      }
      i = j;
      continue;
    }
    if (!PUNCT.includes(c)) broken = true;
    if (stack.length === 0) atStart = false;
    i++;
  }
  if (stack.length !== 0) broken = true;
  if (mutation) return 'mutation';
  if (broken) return 'unknown';
  if (subscription) return 'subscription';
  return query ? 'query' : 'unknown';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 一个 JSON 对象（单个操作）。不是 GraphQL 形状给 null。
// `query` 键不分大小写匹配：只有唯一一个、而且恰好是小写 `query` 的键才按普通情形处理；
// 多于一个、或唯一的键不是小写，都对每个字符串值各扫一遍，有 mutation 就是 mutation，否则 unknown。
// （同一个键重复出现时 JSON.parse 取最后一个，前面的读不到：这只是报告分组的边界，README 写明了；拦截不靠它，isStrictQuery 看到重复的 query 键就不放行。）
function ofOperation(o: Record<string, unknown>): GraphqlKind | null {
  const keys = Object.keys(o).filter((k) => k.toLowerCase() === 'query');
  if (keys.length === 1 && keys[0] === 'query') return typeof o.query === 'string' ? scanDocument(o.query) : 'unknown';
  if (keys.length > 0) {
    return keys.some((k) => typeof o[k] === 'string' && scanDocument(o[k] as string) === 'mutation') ? 'mutation' : 'unknown';
  }
  if (isRecord(o.extensions) && Object.hasOwn(o.extensions, 'persistedQuery')) return 'unknown';
  return null;
}

function pathIsGraphql(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return path.toLowerCase().includes('/graphql');
}

function ofJson(value: unknown): GraphqlKind | null {
  if (Array.isArray(value)) {
    const kinds = value.map((v) => (isRecord(v) ? ofOperation(v) : null));
    if (kinds.length === 0 || kinds.every((k) => k === null)) return null;
    if (kinds.includes('mutation')) return 'mutation';
    return kinds.every((k) => k === 'query') ? 'query' : 'unknown';
  }
  return isRecord(value) ? ofOperation(value) : null;
}

// URL 查询串里的 query 参数（键不分大小写）：有的服务端处理 POST 时以它为准，不管请求体里写了什么。
// 返回每个值的分类；没有这个参数返回 null；URL 读不了、又像带了这个参数时返回 ['unknown']。
function urlQueryKinds(url: string): GraphqlKind[] | null {
  try {
    const kinds: GraphqlKind[] = [];
    for (const [k, v] of new URL(url).searchParams) if (k.toLowerCase() === 'query') kinds.push(scanDocument(v));
    return kinds.length > 0 ? kinds : null;
  } catch {
    return /[?&]query=/i.test(url) ? ['unknown'] : null;
  }
}

export function graphqlKind(body: string | null, contentType: string | null, url: string): GraphqlKind | null {
  const fromBody = graphqlOfBody(body, contentType, url);
  const fromUrl = urlQueryKinds(url);
  if (fromUrl === null) return fromBody;
  // 两边都可能被执行：任一边是 mutation 就是 mutation，其余一律 unknown（不信哪一边是「真正执行的」）。
  return fromBody === 'mutation' || fromUrl.includes('mutation') ? 'mutation' : 'unknown';
}

function graphqlOfBody(body: string | null, contentType: string | null, url: string): GraphqlKind | null {
  const fallback = (): GraphqlKind | null => (pathIsGraphql(url) ? 'unknown' : null);
  if (body === null) return fallback();
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const isDoc = mime === 'application/graphql';
  const head = body.trimStart()[0];
  const jsonLike = head === '{' || head === '[';
  const kind = ((): GraphqlKind | null => {
    // 不管 Content-Type，长得像 JSON 的先按 JSON 试；只有读不出 GraphQL 形状时，application/graphql 才按文档扫描。
    if (jsonLike) {
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        // 看起来是 JSON 却解析不了（例如被截断，或是 `{ a }` 这样的文档）：application/graphql 按文档扫；
        // 其他情况只要提到 "query" 就不能当普通 JSON。
        if (isDoc) return scanDocument(body);
        return pathIsGraphql(url) || body.includes('"query"') ? 'unknown' : null;
      }
      const r = ofJson(value);
      if (r !== null) return r;
      return isDoc ? 'unknown' : fallback();   // 合法 JSON 但没有 GraphQL 形状：不会是一份可执行的文档
    }
    return isDoc ? scanDocument(body) : fallback();
  })();
  if (kind !== 'mutation' && Buffer.byteLength(body, 'utf8') >= MAX_BODY_BYTES && (isDoc || jsonLike)) return 'unknown';
  return kind;
}

// 只带持久化查询哈希、没有查询文档的请求：服务端会按哈希去取一份我们看不到的文档，无法判断是不是 mutation。
// JSON 对象，或数组里任一项，带 extensions.persistedQuery 且没有字符串 query。读不出来一律 false（别的判断会照样拦住它）。
export function isPersistedOnly(body: string | null): boolean {
  if (body === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }
  const items = Array.isArray(value) ? value : [value];
  return items.some((o) => isRecord(o) && isRecord(o.extensions) && Object.hasOwn(o.extensions, 'persistedQuery') && typeof o.query !== 'string');
}

// 注释只从 `#` 删到行尾，不分字符串里外。这个检查只是挡掉 `query builder` 这类明显当不了操作的文本，不是文法校验：
// 字符串里藏着 `{` 的非法文档也能通过它（合规的服务端会拒绝这种文档，真正的把关是 graphqlKind 判成 query）。
function hasSelectionSet(doc: string): boolean {
  return doc.replace(/#[^\r\n]*/g, '').includes('{');
}

const OPERATION_KEYS = new Set(['query', 'variables', 'operationName', 'extensions']);

// 操作对象里的键只能是标准那四个，extensions 里不能有 persistedQuery；多余的键可能让服务端把它当成别的接口的写请求。
function isPlainOperation(o: Record<string, unknown>): boolean {
  if (!Object.keys(o).every((k) => OPERATION_KEYS.has(k))) return false;
  return !(isRecord(o.extensions) && Object.hasOwn(o.extensions, 'persistedQuery'));
}

// 同一个对象里有没有两个（不分大小写）等于 `query` 的键。JSON.parse 对重复键取最后一个，取第一个的服务端会执行另一份文档，
// 所以要看原文。body 已经是合法 JSON：逐字符走，字符串读到结尾（认转义），后面紧跟 `:` 的字符串就是键。
// 跨对象的数量不合并，但出错只会多拦，不会少拦。
function hasRepeatedQueryKey(body: string): boolean {
  const counts: (number | null)[] = [];   // 每层一个：对象是 query 键的个数，数组是 null
  const n = body.length;
  let i = 0;
  while (i < n) {
    const c = body[i]!;
    if (c === '{') counts.push(0);
    else if (c === '[') counts.push(null);
    else if (c === '}' || c === ']') counts.pop();
    else if (c === '"') {
      let j = i + 1;
      while (j < n && body[j] !== '"') j += body[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (k < n && /\s/.test(body[k]!)) k++;
      const top = counts.length - 1;
      if (body[k] === ':' && top >= 0 && counts[top] !== null) {
        let key: unknown;
        try {
          key = JSON.parse(body.slice(i, j + 1));
        } catch {
          return true;   // 读不了就当重复
        }
        if (typeof key === 'string' && key.toLowerCase() === 'query' && (counts[top] = (counts[top] as number) + 1) > 1) return true;
      }
      i = j;
    }
    i++;
  }
  return false;
}

// 每个操作的文档：application/graphql 且体不是 JSON 时是整个体；JSON 时是每个操作的 query 字符串
// （有一个不是字符串、键不标准、或有重复的 query 键，就返回 null）。
function documentsOf(body: string, isDoc: boolean): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return isDoc ? [body] : null;
  }
  if (hasRepeatedQueryKey(body)) return null;
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) return null;
  const docs: string[] = [];
  for (const o of items) {
    if (!isRecord(o) || typeof o.query !== 'string' || !isPlainOperation(o)) return null;
    docs.push(o.query);
  }
  return docs;
}

// 只读模式里唯一放行的写：方法 POST，Content-Type 的 MIME 是 application/json 或 application/graphql，
// graphqlKind 判成 'query'（批量、subscription、unknown 都不行），并且每个操作的文档去掉注释后含 `{`
// （挡住 `query builder` 这种当不了操作的文本），JSON 的键和重复键也要合规（见 documentsOf）。
// url 可选：给了就连 URL 一起看，URL 里有 query 参数（键按解码后比，`;` 分隔、百分号编码的写法都算，键解不开也算）就不放行，失败关闭。
export function isStrictQuery(method: string, body: string | null, contentType: string | null, url = ''): boolean {
  if (method.toUpperCase() !== 'POST' || body === null) return false;
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime !== 'application/json' && mime !== 'application/graphql') return false;
  if (urlQueryParams(url).length > 0) return false;
  if (graphqlKind(body, contentType, url) !== 'query') return false;
  const docs = documentsOf(body, mime === 'application/graphql');
  return docs !== null && docs.every(hasSelectionSet);
}

// 按 URL 查询串的原文读 query 参数：取第一个 `?` 之后、`#` 之前的部分，按 `&` 和 `;` 切开
// （有的服务端把 `;` 当分隔符，URLSearchParams 不当），键、值都先把 `+` 换成空格再百分号解码，键不分大小写地比 `query`。
// 键解不开的也算（失败关闭）。返回每个命中的值（已解码，解不开时用原文）。
function decodePart(v: string): string | null {
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function urlQueryParams(url: string): string[] {
  const hash = url.indexOf('#');
  const base = hash < 0 ? url : url.slice(0, hash);
  const q = base.indexOf('?');
  if (q < 0) return [];
  const values: string[] = [];
  for (const item of base.slice(q + 1).split(/[&;]/)) {
    const eq = item.indexOf('=');
    const rawKey = eq < 0 ? item : item.slice(0, eq);
    const rawValue = eq < 0 ? '' : item.slice(eq + 1);
    const key = decodePart(rawKey);
    if (key !== null && key.toLowerCase() !== 'query') continue;
    values.push(decodePart(rawValue) ?? rawValue.replace(/\+/g, ' '));
  }
  return values;
}

// 一个 query 参数值看起来是不是 mutation：扫描器判成 mutation，或判不出（unknown）但出现了 mutation 这个词。
// 扫描器遇到 VT、FF、NBSP 这类不是 GraphQL 空白的字符会判 unknown，词检查把这种藏法也算上。
function looksLikeMutation(value: string): boolean {
  const kind = scanDocument(value);
  return kind === 'mutation' || (kind === 'unknown' && /\bmutation\b/i.test(value));
}

// GET/HEAD 的 URL 里有没有看起来像 mutation 的 query 参数（读法见 urlQueryParams）。多拦只会更严。
export function isMutationLikeUrl(url: string): boolean {
  return graphqlKind(null, null, url) === 'mutation' || urlQueryParams(url).some(looksLikeMutation);
}

// ---- 组级白名单用的两个检查（M2b） ----

// JSON 里任何对象有没有重复的键（精确相等，转义解码后比）。JSON.parse 对重复键取最后一个，取第一个的服务端会读到另一份，
// 所以要看原文。body 已经是合法 JSON：逐字符走，字符串读到结尾（认转义），后面紧跟 `:` 的字符串就是键。
// 比 hasRepeatedQueryKey 严：不限于 query 键，每个对象各记一个键集；读不了的键当重复（失败关闭）。
export function hasRepeatedKey(body: string): boolean {
  const stack: (Set<string> | null)[] = [];   // 每层一个：对象是已见过的键，数组是 null
  const n = body.length;
  let i = 0;
  while (i < n) {
    const c = body[i]!;
    if (c === '{') stack.push(new Set());
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      let j = i + 1;
      while (j < n && body[j] !== '"') j += body[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (k < n && /\s/.test(body[k]!)) k++;
      const keys = stack[stack.length - 1];
      if (body[k] === ':' && keys !== undefined && keys !== null) {
        let key: unknown;
        try {
          key = JSON.parse(body.slice(i, j + 1));
        } catch {
          return true;
        }
        if (typeof key !== 'string' || keys.has(key)) return true;
        keys.add(key);
      }
      i = j;
    }
    i++;
  }
  return false;
}

const PERSISTED_ITEM_KEYS = new Set(['operationName', 'variables', 'extensions']);
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

// 恰好这些键（不多不少）。
function exactlyKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const have = Object.keys(o).sort();
  return have.length === keys.length && have.every((k, i) => k === keys[i]);
}

// 一个持久化查询操作：键只在 {operationName, variables, extensions} 里（没有 query，大小写变体也不行），
// extensions 只有 persistedQuery，persistedQuery 恰好是 {version, sha256Hash}，哈希是 64 位十六进制（转小写）。
// operationName 和 variables 的值不解释（文档由哈希决定），只收形状：字符串 / null、对象 / null。
function persistedHashOf(o: Record<string, unknown>): string | null {
  if (!Object.keys(o).every((k) => PERSISTED_ITEM_KEYS.has(k))) return null;
  if (o.operationName !== undefined && o.operationName !== null && typeof o.operationName !== 'string') return null;
  if (o.variables !== undefined && o.variables !== null && !isRecord(o.variables)) return null;
  const ext = o.extensions;
  if (!isRecord(ext) || !exactlyKeys(ext, ['persistedQuery'])) return null;
  const pq = ext.persistedQuery;
  if (!isRecord(pq) || !exactlyKeys(pq, ['sha256Hash', 'version'])) return null;
  if (typeof pq.version !== 'number' || typeof pq.sha256Hash !== 'string' || !SHA256_HEX.test(pq.sha256Hash)) return null;
  return pq.sha256Hash.toLowerCase();
}

// 只带哈希的持久化查询请求：POST、Content-Type 的 MIME 是 application/json、体不到 64 KB（到了就可能被截断）、
// 是合法 JSON 且没有重复的键、单个或数组（不能为空）、每一项都合规（见 persistedHashOf）。全部满足才返回哈希列表（小写，按出现顺序），
// 否则 null（失败关闭）。URL 不在这里看：调用方用接口白名单匹配 URL（带查询串的 URL 不匹配）。
export function persistedHashes(method: string, body: string | null, contentType: string | null): string[] | null {
  if (method.toUpperCase() !== 'POST' || body === null) return null;
  if ((contentType ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') return null;
  if (Buffer.byteLength(body, 'utf8') >= MAX_BODY_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (hasRepeatedKey(body)) return null;
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) return null;
  const hashes: string[] = [];
  for (const o of items) {
    const h = isRecord(o) ? persistedHashOf(o) : null;
    if (h === null) return null;
    hashes.push(h);
  }
  return hashes;
}

// 体看起来像 GraphQL 请求：JSON（单个或数组）的任一项有 query 键（不分大小写，不管值是什么类型），或 extensions（不分大小写）里有
// persistedQuery 键（不分大小写）。拿不准的一律算（宁可多拦）：体到了 64 KB（驱动在这里截断，query 可能还没出现，比如键序
// operationName、variables、query）；长得像 JSON（`{`/`[` 开头）却解析不了；GraphQL 的 multipart 上传（有 `name="operations"` 字段）。
// 读型 POST 白名单靠它挡住「借非 GraphQL 接口的地址发 GraphQL」。
export function looksGraphql(body: string | null): boolean {
  if (body === null) return false;
  if (Buffer.byteLength(body, 'utf8') >= MAX_BODY_BYTES) return true;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    const head = body.trimStart()[0];
    return head === '{' || head === '[' || /name\s*=\s*"?operations"?/i.test(body);
  }
  const items = Array.isArray(value) ? value : [value];
  return items.some((o) => isRecord(o) && Object.keys(o).some((k) => {
    const key = k.toLowerCase();
    if (key === 'query') return true;
    const ext = o[k];
    return key === 'extensions' && isRecord(ext) && Object.keys(ext).some((e) => e.toLowerCase() === 'persistedquery');
  }));
}

// 每一项的 operationName 都等于 operation（放行声明的 operation 命中）：体是合法 JSON、没有重复的键、单个或数组（不能为空）。
export function operationsAre(body: string | null, operation: string): boolean {
  if (body === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }
  if (hasRepeatedKey(body)) return false;
  const items = Array.isArray(value) ? value : [value];
  return items.length > 0 && items.every((o) => isRecord(o) && o.operationName === operation);
}
