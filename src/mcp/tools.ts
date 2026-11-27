import type { Io } from '../cli/main.ts';
import { closeSession, doctorChecks, kernelStatus, listRules, makeSend, openSession, realClock, runCaseFile, saveCase, stepOps } from '../cli/commands.ts';
import type { CommandOutcome, Send } from '../cli/commands.ts';
import type { Driver } from '../driver/types.ts';
import { E2kError } from '../shared/errors.ts';
import { exitCodeFor } from '../shared/protocol.ts';
import type { Home } from '../shared/paths.ts';
import { resolveHome } from '../shared/paths.ts';
import { kernelVersion } from '../shared/version.ts';
import { RpcError, serveJsonRpc } from './jsonrpc.ts';

// MCP 壳（R14）：把 open、step、close、run、save_case、status、doctor、rule_list 暴露成工具，不新增任何权限判断。
// 参数先过和 CLI 同一套校验（validateParams、parseCase 等，在 ../cli/commands.ts），这里只多一层「键名白名单」。
// 没有 login、批准、改规则的工具：这些只能由人在终端和弹框里做。
// 错误不回显输入：报错只说哪个参数不对。

export interface ToolDeps {
  home: Home;
  makeDriver(): Promise<Driver>;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  selfCmd?: string;                                   // 提示里怎么调用 e2k；缺省 e2k
  managerName?: () => Promise<string | null>;         // doctor 取 launchctl managername 的办法
  send?: Send;                                        // 发给内核的办法；缺省是真的 socket，测试注入假的
  onWaiting?: (id: string | null) => void;            // run 等人批准时的提示（走标准错误）
}

interface ToolDef { name: string; description: string; inputSchema: object }

const str = (description: string): object => ({ type: 'string', description });
const allowSchema = {
  type: 'array',
  description: '写请求放行声明，每次最多 12 条；一律弹框要人批准',
  items: {
    type: 'object',
    properties: { method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] }, url: { type: 'string' }, operation: { type: 'string' } },
    required: ['method', 'url'],
    additionalProperties: false,
  },
};
const VERDICTS = ['pass', 'fail', 'exists', 'absent', 'undetermined'];
const noArgs = { type: 'object', properties: {}, required: [], additionalProperties: false };

export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'open',
    description: '打开一个页面并开会话，返回会话号和页面快照。退出码在 exit 里：20 是撞到登录墙（请人运行 login），22 要人处理。',
    inputSchema: {
      type: 'object',
      properties: {
        url: str('要打开的 http(s) 地址'),
        viewport: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } }, required: ['width', 'height'], additionalProperties: false },
        name: str('会话名（小写字母、数字、连字符）'),
        touch: { type: 'boolean', description: '模拟触屏' },
        readonly: { type: 'boolean', description: '强制这个会话只读' },
        profile: str('profile：组 或 组/槽'),
        allow: allowSchema,
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'step',
    description: '在会话里依次执行一批操作（ops），失败默认拦住后面的操作。exit：0 正常，10 有断言不符，11 有动作失败，20 撞到登录墙，21 等人批准（原样重试）。',
    inputSchema: {
      type: 'object',
      properties: {
        session: str('会话号，如 s-a1b2c3'),
        ops: { type: 'array', items: { type: 'object' } },
        keepGoing: { type: 'boolean', description: '失败后后面的操作照跑' },
        allow: allowSchema,
      },
      required: ['session', 'ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'close',
    description: '结束会话并写报告。verdict 和 because 一起给出你的结论（undetermined 必须带 because）；最终结论由内核按记录核对。',
    inputSchema: {
      type: 'object',
      properties: {
        session: str('会话号'),
        verdict: { type: 'string', enum: VERDICTS },
        because: str('结论的理由'),
        findings: { type: 'array', items: { type: 'object' }, description: '每条 { claim, basis, verdict? }' },
        notDone: { type: 'array', items: { type: 'string' }, description: '没做的事' },
        superseded: { type: 'array', items: { type: 'object' }, description: '每条 { failed, by }：序号 failed 的失败由之后的序号 by 取代' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'run',
    description: '重放 save_case 导出的用例文件（open、step、close），结论由重放结果定。',
    inputSchema: {
      type: 'object',
      properties: { file: str('用例文件路径'), name: str('新会话名；缺省用用例里的名字') },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_case',
    description: '从已 close 的会话记录导出可重放的用例到 out（.json，已存在就拒绝，不能放在状态目录里）。',
    inputSchema: {
      type: 'object',
      properties: { session: str('已 close 的会话号'), out: str('输出文件路径'), steps: { type: 'array', items: { type: 'integer' }, description: '只导出这些序号' } },
      required: ['session', 'out'],
      additionalProperties: false,
    },
  },
  { name: 'status', description: '内核的版本、驱动、浏览器、会话、profile 和域名规则。', inputSchema: noArgs },
  { name: 'doctor', description: '自检（只读）：环境、状态目录、规则、内核是否在跑。有一项不过 exit 是 22。', inputSchema: noArgs },
  { name: 'rule_list', description: '列出域名规则、是否已批准（只读；规则只由人维护，批准只能由人在弹框里做）。', inputSchema: noArgs },
]);

// ---- 参数 ----

const KEYS: Record<string, readonly string[]> = {
  open: ['url', 'viewport', 'name', 'touch', 'readonly', 'profile', 'allow'],
  step: ['session', 'ops', 'keepGoing', 'allow'],
  close: ['session', 'verdict', 'because', 'findings', 'notDone', 'superseded'],
  run: ['file', 'name'],
  save_case: ['session', 'out', 'steps'],
  status: [], doctor: [], rule_list: [],
};

function usage(message: string): E2kError {
  return new E2kError('usage', message);
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// 键名白名单；多余的键拒绝，但不回显键名。
function argsOf(name: string, raw: unknown): Record<string, unknown> {
  if (!isPlain(raw)) throw usage('arguments 要是一个对象');
  const allowed = KEYS[name] ?? [];
  if (Object.keys(raw).some((k) => !allowed.includes(k))) throw usage('arguments 里有这个工具不认识的参数');
  return raw;
}

function optStr(a: Record<string, unknown>, key: string): string | undefined {
  const v = a[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw usage(`参数 ${key} 要是字符串`);
  return v;
}

function reqStr(a: Record<string, unknown>, key: string): string {
  const v = optStr(a, key);
  if (v === undefined) throw usage(`缺少参数 ${key}`);
  return v;
}

function closeRaw(a: Record<string, unknown>): Record<string, unknown> {
  const { verdict, because, ...rest } = a;
  if (verdict === undefined) {
    if (because !== undefined) throw usage('because 要和 verdict 一起用');
    return rest;
  }
  if (typeof verdict !== 'string') throw usage('参数 verdict 要是字符串');
  // because 不是字符串时原样交给 validateParams 拒绝。
  return { ...rest, verdict: because === undefined ? { value: verdict } : { value: verdict, because } };
}

// ---- 调用 ----

const IS_ERROR_EXITS: ReadonlySet<number> = new Set([1, 2, 22]);

function toResult(outcome: CommandOutcome): { content: { type: 'text'; text: string }[]; isError: boolean } {
  const body = 'error' in outcome ? { exit: outcome.exit, error: outcome.error } : { exit: outcome.exit, result: outcome.result };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: IS_ERROR_EXITS.has(outcome.exit) };
}

async function dispatch(deps: ToolDeps, name: string, raw: unknown): Promise<CommandOutcome> {
  const selfCmd = deps.selfCmd ?? 'e2k';
  const send: Send = deps.send ?? makeSend(deps.home, selfCmd);
  switch (name) {
    case 'open': return openSession(send, argsOf(name, raw));
    case 'step': return stepOps(send, argsOf(name, raw));
    case 'close': return closeSession(send, closeRaw(argsOf(name, raw)));
    case 'status': argsOf(name, raw); return kernelStatus(send);
    case 'doctor': argsOf(name, raw); return doctorChecks(deps.home, deps.makeDriver, selfCmd, deps.managerName);
    case 'rule_list': argsOf(name, raw); return listRules(deps.home);
    case 'run': {
      const a = argsOf(name, raw);
      const file = reqStr(a, 'file');
      const n = optStr(a, 'name');
      return await runCaseFile(send, file, { ...(n === undefined ? {} : { name: n }), clock: deps.clock, ...(deps.onWaiting === undefined ? {} : { onWaiting: deps.onWaiting }) });
    }
    case 'save_case': {
      const a = argsOf(name, raw);
      const session = reqStr(a, 'session');
      const out = reqStr(a, 'out');
      return saveCase(deps.home, { session, out, ...(a.steps === undefined ? {} : { steps: a.steps as number[] }) });
    }
    default:
      throw usage('没有这个工具');
  }
}

// 工具出错按 MCP 的办法报：结果里 isError，不是 JSON-RPC 错误。未知工具、多余的参数都是用法错误（exit 2）。
export async function callTool(deps: ToolDeps, name: string, args: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  try {
    return toResult(await dispatch(deps, name, args));
  } catch (e) {
    if (e instanceof E2kError) {
      return toResult({ exit: exitCodeFor(e.code), error: e.next === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, next: e.next } });
    }
    // 意外的异常：消息里可能带着输入，只报错误类型和系统错误码。
    const errno = (e as { code?: unknown } | null)?.code;
    const kind = e instanceof Error ? e.name : typeof e;
    return toResult({ exit: 1, error: { code: 'internal', message: `MCP 内部错误（${kind}${typeof errno === 'string' ? ` ${errno}` : ''}）` } });
  }
}

// ---- MCP 方法 ----

const PROTOCOL_VERSIONS: readonly string[] = ['2024-11-05', '2025-03-26', '2025-06-18'];
const FALLBACK_VERSION = '2025-06-18';

export function mcpHandler(deps: ToolDeps): (method: string, params: unknown) => Promise<unknown> {
  return async (method, params) => {
    switch (method) {
      case 'initialize': {
        if (params !== undefined && !isPlain(params)) throw new RpcError(-32602, 'Invalid params');
        const asked = params?.protocolVersion;
        const protocolVersion = typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : FALLBACK_VERSION;
        return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'e2k', version: kernelVersion() } };
      }
      case 'notifications/initialized':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        if (!isPlain(params) || Object.keys(params).some((k) => k !== 'name' && k !== 'arguments' && k !== '_meta')) throw new RpcError(-32602, 'Invalid params');
        if (typeof params.name !== 'string') throw new RpcError(-32602, 'Invalid params');
        if (params.arguments !== undefined && !isPlain(params.arguments)) throw new RpcError(-32602, 'Invalid params');
        return callTool(deps, params.name, params.arguments ?? {});
      }
      default:
        throw new RpcError(-32601, 'Method not found');
    }
  };
}

// 在标准输入输出上服务，直到输入关闭。标准输出只写协议消息，诊断（等人批准的提示）写标准错误。
export async function startMcp(io: Io): Promise<number> {
  const deps: ToolDeps = {
    home: resolveHome(io.env), makeDriver: io.makeDriver, clock: io.clock ?? realClock, selfCmd: io.selfCmd,
    ...(io.managerName === undefined ? {} : { managerName: io.managerName }),
    onWaiting: (id) => { io.err(id === null ? '请在弹出的对话框里选择' : `请在弹出的对话框里选择（请求 ${id}）`); },
  };
  await serveJsonRpc(io.input ?? process.stdin, (line) => { io.out(line); }, mcpHandler(deps));
  return 0;
}
