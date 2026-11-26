// 写请求里的 GraphQL 分类（只用来给报告分组，不做拦截）。输入是驱动给的原始请求体（已被截到 MAX_BODY 字节）。
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
// （同一个键重复出现时 JSON.parse 取最后一个，前面的读不到；README 写明了这个边界。）
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
