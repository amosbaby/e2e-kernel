import { basename, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { Driver } from '../driver/types.ts';
import { noDialog } from '../kernel/approval.ts';
import { inspectRules } from '../kernel/rules.ts';
import { listenerErrorLogger, startKernel } from '../kernel/server.ts';
import type { KernelHandle, KernelOptions } from '../kernel/server.ts';
import type { StatusResult } from '../kernel/server.ts';
import { call } from '../shared/client.ts';
import { E2kError } from '../shared/errors.ts';
import type { Viewport } from '../shared/ops.ts';
import { resolveHome } from '../shared/paths.ts';
import type { Home } from '../shared/paths.ts';
import { ExitCode, MAX_OPS_BYTES, exitCodeFor, validateParams } from '../shared/protocol.ts';
import type { CloseResult, Method, OpenResult, StepResult } from '../shared/protocol.ts';
import { redactText, safely } from '../shared/redact.ts';
import { isObject } from '../shared/validate.ts';
import { kernelVersion } from '../shared/version.ts';
import { runDoctor } from './doctor.ts';
import { formatChecks, formatClose, formatError, formatOpen, formatRuleDiff, formatRuleList, formatStatus, formatStep } from './format.ts';
import type { RuleDiffResult, RuleListResult } from './format.ts';

// e2k 命令行（设计 5.9）。只做校验和转发：参数先用和内核同一套 validateParams 校验，再经 socket 发给内核。
// 这一版没有 run、save-case，rule 只有只读的 list 和 diff，也没有任何批准类的命令。
// 报错不回显调用方给的值：参数解析、JSON 解析的原始错误消息都不打印。

export interface Io {
  out(s: string): void; err(s: string): void; env: NodeJS.ProcessEnv;
  selfCmd: string;                        // 这个 CLI 实际该怎么调用，用在提示里
  stdin: { isTTY: boolean; readLine(): Promise<string>; readAll(maxBytes: number): Promise<string> };   // 超过 maxBytes 抛 E2kError('usage')
  makeDriver(): Promise<Driver>;
  startKernel?(o: KernelOptions): Promise<KernelHandle>;   // 缺省是真的 startKernel；测试用它看 start 传了什么
  onStopSignal(cb: () => void): void;     // 真实实现挂 SIGINT、SIGTERM 和 SIGHUP；每收到一次调用一次 cb
  exit(code: number): void;               // 真实实现是 process.exit：第二次停止信号时不再等收尾
}

type Options = Record<string, { type: 'string' | 'boolean' }>;
interface Parsed { values: Record<string, string | boolean | undefined>; positionals: string[] }
interface Ctx { io: Io; json: boolean }

const JSON_OPTION: Options = { json: { type: 'boolean' } };

function usage(message: string, next?: string): E2kError {
  return new E2kError('usage', message, next);
}

function malformed(): E2kError {
  return new E2kError('internal', '内核的回应格式不对');
}

function helpText(selfCmd: string): string {
  return [
    `用法：${selfCmd} <命令>`,
    '',
    '  start [--no-dialogs]                   前台运行内核（Ctrl-C 或 SIGTERM 停止）；--no-dialogs 不弹确认框，需要人批准的事一律走不通（22）',
    '  status [--json]                        版本、驱动、浏览器、会话、profile（含最近一次 login）和域名规则',
    '  doctor [--json]                        自检（含 profile 状态和域名规则；只读）',
    '  rule list [--json]                     读 $E2K_HOME/rules.json 列出域名规则，注明是否已批准（只读，不需要内核；规则文件只由人维护）',
    '  rule diff [--json]                     规则文件和已批准的规则之间的完整差异（只读，不需要内核；批准只能由人在内核弹出的框里做）',
    '  open <url> [--viewport <宽>x<高>] [--touch] [--readonly] [--name <名字>] [--profile <组>[/<槽>]] [--json]',
    '                                          --profile 选 profile：不写就用域名所在的组；域名没编组时可借用某个组的登录（不能带槽）；域名属于别的组则拒绝',
    '                                          --readonly 强制这个会话只读（不管域名规则）：只放行读和严格的 GraphQL query，其余写请求一律拦下；驱动不能拦网络时 open 失败',
    '                                          --touch 只让这个会话页模拟触屏（(pointer: coarse)、触摸事件）；click 仍发鼠标事件，弹窗和新标签页不继承；不能模拟时 open 失败（11）',
    '  step <会话> <JSON 数组> [--keep-going] [--json]    失败默认拦住后面的操作；--keep-going 让后面的照跑',
    '  step <会话> --stdin [--keep-going] [--json]        从标准输入读 JSON 数组',
    '  close <会话> [--verdict pass|fail|exists|absent|undetermined] [--because <文字>]',
    '               [--findings <JSON>] [--not-done <JSON>] [--superseded <JSON>] [--json]',
    '                                          --findings 每条可带 "verdict"；--superseded 如 [{"failed":3,"by":5}]：序号 3 的失败由之后的序号 5 取代',
    '  login <url> [--profile <组>[/<槽>]]    在专用 profile 里登录（要在终端里由人按回车确认）；--profile 同 open',
    '  --version',
    '  help',
    '',
    '退出码：0 正常；10 有断言不符；11 有动作失败；20 撞到登录墙（open / step，请人运行 login）；21 等人在弹框里批准（原样重试）；2 用法错误、会话不存在或正忙；22 要人处理（内核没在跑、login 没有终端、状态目录有问题）',
  ].join('\n');
}

// 解析失败的原始消息会带上调用方给的选项或参数，不打印，只按错误码给固定说明。
function parse(ctx: Ctx, args: string[], options: Options): Parsed {
  let parsed: Parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true }) as Parsed;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    const message = code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? '有不认识的选项'
      : code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? '有选项缺少值，或给了不该带值的选项'
        : '参数不对';
    throw usage(message, `${ctx.io.selfCmd} help 查看用法`);
  }
  ctx.json = parsed.values.json === true;
  return parsed;
}

function positionals(ctx: Ctx, p: Parsed, n: number, what: string): string[] {
  if (p.positionals.length !== n) throw usage(`需要 ${n} 个参数：${what}`, `${ctx.io.selfCmd} help 查看用法`);
  return p.positionals;
}

function optString(p: Parsed, key: string): string | undefined {
  const v = p.values[key];
  return typeof v === 'string' ? v : undefined;
}

function parseJson(text: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw usage(message);
  }
}

function parseViewport(v: string): Viewport {
  const m = /^([0-9]{1,5})x([0-9]{1,5})$/.exec(v);
  if (m === null) throw usage('--viewport 要写成 <宽>x<高>，比如 1280x800');
  return { width: Number(m[1]), height: Number(m[2]) };
}

// 发给内核。内核没在跑时补上启动命令；内核回的错误原样往上抛（code、message、next 都不改）。
async function send(ctx: Ctx, home: Home, method: Method, params: unknown): Promise<unknown> {
  let r;
  try {
    r = await call(home, method, params);
  } catch (e) {
    if (e instanceof E2kError && e.code === 'needs-human' && e.next === undefined) {
      throw new E2kError(e.code, e.message, `运行 ${ctx.io.selfCmd} start（前台运行，可以放到后台）`);
    }
    throw e;
  }
  if (!r.ok) throw new E2kError(r.error.code, r.error.message, r.error.next);
  return r.result;
}

function print<T>(ctx: Ctx, result: T, format: (r: T) => string): void {
  ctx.io.out(ctx.json ? JSON.stringify(result) : format(result));
}

function needsTerminal(ctx: Ctx, command: string): void {
  if (!ctx.io.stdin.isTTY) throw new E2kError('needs-human', `${command} 需要人在终端里运行`);
}

// ---- 命令 ----

async function start(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(ctx, args, { 'no-dialogs': { type: 'boolean' } });
  positionals(ctx, p, 0, '无');
  const home = resolveHome(ctx.io.env);
  let wake = (): void => {};
  const stopSignal = new Promise<void>((resolve) => { wake = resolve; });
  let kernel: KernelHandle | undefined;
  let signals = 0;
  // 第一次信号开始收尾；收尾期间再来一次就直接停浏览器实例并以 1 退出，不等关停期限。
  ctx.io.onStopSignal(() => {
    if (signals++ === 0) {
      wake();
      return;
    }
    ctx.io.out('再次收到停止信号，立即退出');
    void (kernel?.abort() ?? Promise.resolve()).finally(() => { ctx.io.exit(ExitCode.INTERNAL); });
  });
  const noDialogs = p.values['no-dialogs'] === true;
  kernel = await (ctx.io.startKernel ?? startKernel)({ home, driver: await ctx.io.makeDriver(), ...(noDialogs ? { dialog: noDialog } : {}) });
  ctx.io.out(`内核已启动，状态目录 ${home.root}`);
  if (noDialogs) ctx.io.out('已用 --no-dialogs 启动：不弹确认框，需要人批准的事一律走不通');
  ctx.io.out('按 Ctrl-C 或发送 SIGTERM 停止（收尾期间再按一次立即退出）');
  await stopSignal;
  ctx.io.out('正在停止内核……');
  await kernel.stop();
  if (signals > 1) return ExitCode.INTERNAL;
  ctx.io.out('内核已停止');
  return ExitCode.OK;
}

async function status(ctx: Ctx, args: string[]): Promise<number> {
  positionals(ctx, parse(ctx, args, JSON_OPTION), 0, '无');
  const params = validateParams('status', {});
  const result = await send(ctx, resolveHome(ctx.io.env), 'status', params) as StatusResult;
  print(ctx, result, formatStatus);
  return ExitCode.OK;
}

async function doctor(ctx: Ctx, args: string[]): Promise<number> {
  positionals(ctx, parse(ctx, args, JSON_OPTION), 0, '无');
  const home = resolveHome(ctx.io.env);
  const checks = await runDoctor(home, await ctx.io.makeDriver(), ctx.io.selfCmd);
  print(ctx, checks, formatChecks);
  return checks.every((c) => c.ok) ? ExitCode.OK : ExitCode.NEEDS_HUMAN;
}

// 解析错误会带上文件里的未知键名，和主机写法一样先脱敏。
function redactError(error: string | null): string | null {
  return error === null ? null : safely(() => redactText(error));
}

// 规则文件和批准记录由 CLI 自己读，不需要内核。文件有错：照样打印（--json 里在 error 字段），退出码 2。
async function rule(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'list' && sub !== 'diff') throw usage(sub === undefined ? '缺少子命令' : '没有这个子命令', `${ctx.io.selfCmd} help 查看可用命令`);
  positionals(ctx, parse(ctx, rest, JSON_OPTION), 0, '无');
  const home = resolveHome(ctx.io.env);
  const r = inspectRules(home.rulesFile, home.approvalsFile);
  const f = r.file;
  if (sub === 'diff') {
    // 差异里的主机和接口写法进输出前同样先脱敏。
    const result: RuleDiffResult = {
      path: home.rulesFile, approvals: r.approvals, pending: r.pending, hash: r.hash,
      lines: r.summary.map((x) => redactText(x)), error: redactError(f.error),
    };
    print(ctx, result, formatRuleDiff);
    return f.error === null ? ExitCode.OK : ExitCode.USAGE;
  }
  const approvedRule = (x: { match: string; mode: string }): boolean => r.approvedRules.rules.some((a) => a.match === x.match && a.mode === x.mode);
  const approvedGroup = (g: (typeof f.groups)[number]): boolean => {
    const a = r.approvedRules.groups.find((y) => y.name === g.name);
    return a !== undefined && JSON.stringify(a) === JSON.stringify(g);
  };
  // 主机写法进输出前和别的命令一样先脱敏。
  const result: RuleListResult = {
    path: home.rulesFile,
    rules: f.rules.map((x) => ({ match: redactText(x.match), mode: x.mode, approved: approvedRule(x) })),
    loginHosts: f.loginHosts.map((x) => redactText(x)),
    groups: f.groups.map((g) => ({
      name: g.name, hosts: g.hosts.map((x) => redactText(x)), loginHosts: g.loginHosts.map((x) => redactText(x)),
      readPosts: g.readPosts.length, persistedQueries: g.persistedQueries.length, logout: g.logout.length, identity: g.identity !== null,
      approved: approvedGroup(g),
    })),
    hash: f.hash, error: redactError(f.error),
    approved: f.error === null && !r.pending && r.approvals !== 'unreadable', pending: r.pending, approvals: r.approvals,
  };
  print(ctx, result, formatRuleList);
  return f.error === null ? ExitCode.OK : ExitCode.USAGE;
}

async function open(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(ctx, args, { ...JSON_OPTION, viewport: { type: 'string' }, name: { type: 'string' }, touch: { type: 'boolean' }, readonly: { type: 'boolean' }, profile: { type: 'string' } });
  const [url] = positionals(ctx, p, 1, '<url>');
  const raw: Record<string, unknown> = { url };
  const viewport = optString(p, 'viewport');
  const name = optString(p, 'name');
  if (viewport !== undefined) raw.viewport = parseViewport(viewport);
  if (name !== undefined) raw.name = name;
  const profile = optString(p, 'profile');
  if (profile !== undefined) raw.profile = profile;
  if (p.values.touch === true) raw.touch = true;
  if (p.values.readonly === true) raw.readonly = true;
  const params = validateParams('open', raw);
  const result = await send(ctx, resolveHome(ctx.io.env), 'open', params) as OpenResult;
  print(ctx, result, formatOpen);
  return result.blocked === 'login' ? ExitCode.WAIT_LOGIN : ExitCode.OK;
}

async function step(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(ctx, args, { ...JSON_OPTION, stdin: { type: 'boolean' }, 'keep-going': { type: 'boolean' } });
  const fromStdin = p.values.stdin === true;
  const [session, inlineOps] = positionals(ctx, p, fromStdin ? 1 : 2, fromStdin ? '<会话>' : '<会话> <JSON 数组>');
  // 先查长度、不解析：超长的一律当用法错误，什么都不发。
  const text = inlineOps ?? await ctx.io.stdin.readAll(MAX_OPS_BYTES);
  if (Buffer.byteLength(text, 'utf8') > MAX_OPS_BYTES) throw usage(`操作的 JSON 最多 ${MAX_OPS_BYTES} 字节`);
  const ops = parseJson(text, '操作必须是一个 JSON 数组');
  const raw: Record<string, unknown> = { session, ops };
  if (p.values['keep-going'] === true) raw.keepGoing = true;
  const params = validateParams('step', raw);
  const result = await send(ctx, resolveHome(ctx.io.env), 'step', params) as StepResult;
  if (result.exit !== 0 && result.exit !== 10 && result.exit !== 11 && result.exit !== 20) throw malformed();
  print(ctx, result, formatStep);
  return result.exit;
}

async function close(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(ctx, args, {
    ...JSON_OPTION, verdict: { type: 'string' }, because: { type: 'string' }, findings: { type: 'string' }, 'not-done': { type: 'string' }, superseded: { type: 'string' },
  });
  const [session] = positionals(ctx, p, 1, '<会话>');
  const raw: Record<string, unknown> = { session };
  const verdict = optString(p, 'verdict');
  const because = optString(p, 'because');
  const findings = optString(p, 'findings');
  const notDone = optString(p, 'not-done');
  const superseded = optString(p, 'superseded');
  if (verdict !== undefined) raw.verdict = because === undefined ? { value: verdict } : { value: verdict, because };
  else if (because !== undefined) throw usage('--because 要和 --verdict 一起用');
  if (findings !== undefined) raw.findings = parseJson(findings, '--findings 必须是 JSON 数组');
  if (notDone !== undefined) raw.notDone = parseJson(notDone, '--not-done 必须是 JSON 数组');
  if (superseded !== undefined) raw.superseded = parseJson(superseded, '--superseded 必须是 JSON 数组');
  const params = validateParams('close', raw);
  const result = await send(ctx, resolveHome(ctx.io.env), 'close', params) as CloseResult;
  if (result.exit !== 0 && result.exit !== 10) throw malformed();
  print(ctx, result, formatClose);
  return result.exit;
}

async function login(ctx: Ctx, args: string[]): Promise<number> {
  needsTerminal(ctx, 'login');
  const p = parse(ctx, args, { profile: { type: 'string' } });
  const [url] = positionals(ctx, p, 1, '<url>');
  const profile = optString(p, 'profile');
  const params = validateParams('login.begin', profile === undefined ? { url } : { url, profile });
  const home = resolveHome(ctx.io.env);
  const begun = await send(ctx, home, 'login.begin', params);
  let end: { loginId: string };
  try {
    end = validateParams('login.end', { loginId: isObject(begun) ? begun.loginId : undefined });
  } catch {
    throw malformed();
  }
  ctx.io.out('请在浏览器窗口里登录，完成后回到这里按回车');
  await ctx.io.stdin.readLine();
  const ended = await send(ctx, home, 'login.end', end);
  ctx.io.out('登录页已关闭，登录状态留在专用 profile 里');
  // 老内核不返回 writesBlocked：当作 0。
  const blocked = isObject(ended) && typeof ended.writesBlocked === 'number' ? ended.writesBlocked : 0;
  if (blocked > 0) {
    ctx.io.out(`登录过程中有 ${blocked} 条写被只读规则拦下：身份提供方（SSO、SAML、OIDC）的主机可能没列进 rules.json 的 loginHosts`);
  }
  return ExitCode.OK;
}

async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case '--version':
    case 'help':
      positionals(ctx, parse(ctx, rest, {}), 0, '无');
      ctx.io.out(command === 'help' ? helpText(ctx.io.selfCmd) : kernelVersion());
      return ExitCode.OK;
    case 'start': return start(ctx, rest);
    case 'status': return status(ctx, rest);
    case 'doctor': return doctor(ctx, rest);
    case 'rule': return rule(ctx, rest);
    case 'open': return open(ctx, rest);
    case 'step': return step(ctx, rest);
    case 'close': return close(ctx, rest);
    case 'login': return login(ctx, rest);
    default:
      // 不回显命令名：它可能是调用方误贴的任何东西。
      throw usage(command === undefined ? '缺少命令' : '没有这个命令', `${ctx.io.selfCmd} help 查看可用命令`);
  }
}

export async function main(argv: string[], io: Io): Promise<number> {
  const ctx: Ctx = { io, json: false };
  try {
    return await run(ctx, argv);
  } catch (e) {
    let error: { code: E2kError['code']; message: string; next?: string };
    if (e instanceof E2kError) {
      error = e.next === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, next: e.next };
    } else {
      // 意外的异常：消息里可能带着输入，只报错误类型和系统错误码。
      const errno = (e as { code?: unknown } | null)?.code;
      const kind = e instanceof Error ? e.name : typeof e;
      error = { code: 'internal', message: `CLI 内部错误（${kind}${typeof errno === 'string' ? ` ${errno}` : ''}）` };
    }
    if (ctx.json) io.out(JSON.stringify({ error }));
    else io.err(formatError(error));
    return exitCodeFor(error.code);
  }
}

// ---- 真实的 Io ----

// 入口脚本叫 e2k（装成了命令）就是 e2k；否则是 node 加入口脚本相对当前目录的路径。
function selfCmdFor(entry: string | undefined, cwd: string): string {
  if (entry === undefined || basename(entry) === 'e2k') return 'e2k';
  const rel = relative(cwd, entry);
  return `node ${/^[\w./-]+$/.test(rel) ? rel : `'${rel.replaceAll("'", `'\\''`)}'`}`;
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    let done = false;
    const finish = (line: string): void => {
      if (done) return;
      done = true;
      rl.close();
      resolve(line);
    };
    rl.once('line', finish);
    rl.once('close', () => { finish(''); });
  });
}

async function readAll(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer;
    size += b.length;
    if (size > maxBytes) throw usage(`标准输入最多 ${maxBytes} 字节`);   // 跳出循环时流会被销毁，不再读
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

let streamErrorsIgnored = false;

export function realIo(): Io {
  const env = process.env;
  // 读端关掉后再写会 EPIPE；不挂监听就是未处理的 'error' 事件，进程崩溃，清理做不完。输出丢了无所谓，只挂一次。
  if (!streamErrorsIgnored) {
    streamErrorsIgnored = true;
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
  }
  return {
    out: (s) => { process.stdout.write(`${s}\n`); },
    err: (s) => { process.stderr.write(`${s}\n`); },
    env,
    selfCmd: selfCmdFor(process.argv[1], process.cwd()),
    stdin: { isTTY: process.stdin.isTTY === true, readLine, readAll },
    // 动态引入：只有真要驱动浏览器的命令才加载 Playwright。监听器的错误脱敏后进 kernel.log。
    makeDriver: async () => (await import('../drivers/playwright/driver.ts'))
      .createPlaywrightDriver({ onListenerError: listenerErrorLogger(resolveHome(env)) }),
    onStopSignal: (cb) => {
      process.on('SIGINT', cb);
      process.on('SIGTERM', cb);
      process.on('SIGHUP', cb);
    },
    exit: (code) => { process.exit(code); },
  };
}
