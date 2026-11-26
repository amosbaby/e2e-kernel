import type { Decision, RequestInfo, Stable } from '../driver/types.ts';
import type { Op, Target } from '../shared/ops.ts';
import type { Mode, Outcome, RequestSummary } from '../shared/protocol.ts';
import { graphqlKind } from './graphql.ts';
import type { GraphqlKind } from './graphql.ts';
import { REDACTED, redactBody, redactText, redactUrl, safely } from '../shared/redact.ts';

// 会话的记录（设计 5.7、5.8）：动作、写、请求摘要、到过的域名。进记录之前先脱敏。

export interface ActionRecord { seq: number; at: string; ms: number; op: Op; target?: { given: Target; stable: Stable | null };
  outcome: Outcome; actual?: string | number | boolean | null; expected?: string | number | boolean; error?: string; shot?: string;
  // 只在 eval 上出现：output 是已脱敏、截到 1000 字符的返回值；页面有密码类字段（或探测不出）时不记 output，改记 outputOmitted。
  // jsHash 是源码的 'sha256:' + 十六进制前 16 位（源码本身不进记录）。
  output?: string; outputOmitted?: boolean; jsHash?: string;
  // 失败时的诊断；页面有密码类字段（或探不出）时只有一条固定说明，不记页面文字。
  hints?: string[] }
export interface WriteRecord { id: string; at: string; method: string; url: string; status: number | null; failed: boolean;
  body: string | null; bodyOmitted: boolean; pageUrl: string | null; decision: 'allowed' | 'blocked'; targetMode: Mode;
  // 主机名：取自原始 url、单独脱敏（和 addHost 一样），汇总按它分组；取不到是 REDACTED。
  // graphql：null 表示不是 GraphQL；从原始请求体算，请求体不记录时照样算；拿不准是 'unknown'。
  host: string; graphql: GraphqlKind | null }

const MAX_REQUESTS = 200;

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 不分大小写：fetch 不会把 patch 规范成大写，宁可多记一条写。
export function isWrite(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

function hostOf(url: string): string {
  return safely(() => redactText(new URL(url).hostname));
}

// 分类出错（它一抛错会让 onRequest 中止这条写请求）给 'unknown'。
function classify(req: RequestInfo): GraphqlKind | null {
  try {
    return graphqlKind(req.body, req.contentType, req.url);
  } catch {
    return 'unknown';
  }
}

export function toWriteRecord(req: RequestInfo, decision: Decision, targetMode: Mode, at: Date): WriteRecord {
  const { body, contentType, topUrl } = req;
  // 失败关闭：只有明确判断出「没有密码框」（false）才记体；true 和判断不出（null）都不记。
  const omit = body !== null && req.fromLoginForm !== false;
  return {
    id: req.id,
    at: at.toISOString(),
    method: safely(() => redactText(req.method)),
    url: safely(() => redactUrl(req.url)),
    status: null,
    failed: false,
    body: body === null || omit ? null : safely(() => redactBody(body, contentType) ?? REDACTED),
    bodyOmitted: omit,
    pageUrl: topUrl === null ? null : safely(() => redactUrl(topUrl)),
    decision: decision.action === 'continue' ? 'allowed' : 'blocked',
    targetMode,
    host: hostOf(req.url),
    graphql: classify(req),
  };
}

export class Recorder {
  readonly actions: ActionRecord[] = [];
  readonly writes: WriteRecord[] = [];
  readonly requests: RequestSummary[] = [];          // 只留最近 MAX_REQUESTS 条
  readonly hosts: { host: string; mode: Mode }[] = [];
  private seq = 0;
  private requestSeq = 0;
  // 按驱动给的请求 id 找回记录。摘要表和 requests 一起只留最近 MAX_REQUESTS 条；写和 writes 一样不删。
  private readonly summaryByRequest = new Map<string, RequestSummary>();
  private readonly writeByRequest = new Map<string, WriteRecord>();

  // 整场会话从 1 起连续编号。
  nextSeq(): number {
    return ++this.seq;
  }

  addAction(r: ActionRecord): void {
    this.actions.push(r);
  }

  // 每个请求都进 requests；写方法另进 writes。摘要的 id 由这里生成：它在脱敏的跳过键 id 下面，不能用外来的串。
  addRequest(req: RequestInfo, decision: Decision, targetMode: Mode, at: Date): void {
    const summary: RequestSummary = {
      id: `n${++this.requestSeq}`,
      method: safely(() => redactText(req.method)),
      url: safely(() => redactUrl(req.url)),
      status: null,
      resourceType: safely(() => redactText(req.resourceType)),
    };
    this.requests.push(summary);
    this.summaryByRequest.set(req.id, summary);
    if (this.requests.length > MAX_REQUESTS) this.requests.shift();
    if (this.summaryByRequest.size > MAX_REQUESTS) {
      const oldest = this.summaryByRequest.keys().next();
      if (oldest.done !== true) this.summaryByRequest.delete(oldest.value);
    }
    if (isWrite(req.method)) {
      const write = toWriteRecord(req, decision, targetMode, at);
      this.writes.push(write);
      this.writeByRequest.set(req.id, write);
    }
  }

  // 这个 id 是自己记的才返回 true。摘要已被挤出、又不是写的请求认不出来，返回 false。
  completeRequest(id: string, status: number | null, failed: boolean): boolean {
    const summary = this.summaryByRequest.get(id);
    const write = this.writeByRequest.get(id);
    if (summary !== undefined) summary.status = status;
    if (write !== undefined) {
      write.status = status;
      write.failed = failed;
    }
    return summary !== undefined || write !== undefined;
  }

  addHost(host: string, mode: Mode): void {
    const h = safely(() => redactText(host));
    if (!this.hosts.some((x) => x.host === h && x.mode === mode)) this.hosts.push({ host: h, mode });
  }
}
