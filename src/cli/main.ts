import { basename, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { Driver } from '../driver/types.ts';
import { noDialog } from '../kernel/approval.ts';
import { inspectRules } from '../kernel/rules.ts';
import { startMcp } from '../mcp/tools.ts';
import { listenerErrorLogger, startKernel } from '../kernel/server.ts';
import type { KernelHandle, KernelOptions } from '../kernel/server.ts';
import { E2kError } from '../shared/errors.ts';
import type { Viewport } from '../shared/ops.ts';
import { resolveHome } from '../shared/paths.ts';
import type { Home } from '../shared/paths.ts';
import { ExitCode, MAX_OPS_BYTES, exitCodeFor, validateParams } from '../shared/protocol.ts';
import type { Method } from '../shared/protocol.ts';
import { redactText } from '../shared/redact.ts';
import { isObject } from '../shared/validate.ts';
import { kernelVersion } from '../shared/version.ts';
import { closeSession, doctorChecks, kernelStatus, listRules, makeSend, openSession, realClock, redactError, runCaseFile, saveCase, stepOps } from './commands.ts';
import type { CommandOutcome } from './commands.ts';
import { formatChecks, formatClose, formatError, formatOpen, formatRuleDiff, formatRuleList, formatRun, formatSaveCase, formatStatus, formatStep } from './format.ts';
import type { RuleDiffResult, RunResult, SaveCaseResult } from './format.ts';

// e2k 命令行（设计 5.9）。只做校验和转发：参数先用和内核同一套 validateParams 校验，再经 socket 发给内核。
// rule 只有只读的 list 和 diff，没有任何批准类的命令。
// 报错不回显调用方给的值：参数解析、JSON 解析的原始错误消息都不打印。

export interface Io {
  out(s: string): void; err(s: string): void; env: NodeJS.ProcessEnv;
  selfCmd: string;                        // 这个 CLI 实际该怎么调用，用在提示里
  stdin: { isTTY: boolean; readLine(): Promise<string>; readAll(maxBytes: number): Promise<string> };   // 超过 maxBytes 抛 E2kError('usage')
  makeDriver(): Promise<Driver>;
  managerName?(): Promise<string | null>;   // doctor 取 launchctl managername 的办法；缺省是真的，测试注入假的
  startKernel?(o: KernelOptions): Promise<KernelHandle>;   // 缺省是真的 startKernel；测试用它看 start 传了什么
  onStopSignal(cb: () => void): void;     // 真实实现挂 SIGINT、SIGTERM 和 SIGHUP；每收到一次调用一次 cb
  exit(code: number): void;               // 真实实现是 process.exit：第二次停止信号时不再等收尾
  clock?: { now(): number; sleep(ms: number): Promise<void> };   // login 等弹框时重试用的时钟；缺省是真的时间，测试用假的，不真等
  input?: NodeJS.ReadableStream;          // mcp 读请求的流；缺省是标准输入，测试给内存里的流
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
    '  open <url> [--viewport <宽>x<高>] [--touch] [--readonly] [--name <名字>] [--profile <组>[/<槽>]] [--allow <JSON>] [--json]',
    '                                          --profile 选 profile：不写就用域名所在的组；域名没编组时可借用某个组的登录（不能带槽）；域名属于别的组则拒绝',
    '                                          --readonly 强制这个会话只读（不管域名规则）：只放行读和严格的 GraphQL query，其余写请求一律拦下；驱动不能拦网络时 open 失败',
    '                                          --allow 只用在「不允许」的域名上：放行清单（格式同 step --allow），人在弹框里选「可写」才生效，只放行清单里的写，不记住；选「只读」则清单不生效',
    '                                          --touch 只让这个会话页模拟触屏（(pointer: coarse)、触摸事件）；click 仍发鼠标事件，弹窗和新标签页不继承；不能模拟时 open 失败（11）',
    '  step <会话> <JSON 数组> [--keep-going] [--allow <JSON>] [--json]    失败默认拦住后面的操作；--keep-going 让后面的照跑',
    '  step <会话> --stdin [--keep-going] [--allow <JSON>] [--json]        从标准输入读 JSON 数组',
    '                                          --allow 如 [{"method":"POST","url":"https://x.example.com/api/save","operation":"Save"}]：只读主机上被拦的写，要放行得声明，每次最多 12 条，',
    '                                          一律弹框要人批准（21，批准后原样重试）；operation 可省（省了不放行 GraphQL mutation）；地址不带查询串',
    '  close <会话> [--verdict pass|fail|exists|absent|undetermined] [--because <文字>]',
    '               [--findings <JSON>] [--not-done <JSON>] [--superseded <JSON>] [--json]',
    '                                          --findings 每条可带 "verdict"；--superseded 如 [{"failed":3,"by":5}]：序号 3 的失败由之后的序号 5 取代',
    '  save-case <会话> --out <文件> [--steps <JSON>] [--json]    从已 close 的会话记录导出可重放的用例（不需要内核）',
    '                                          --out 必填、.json 结尾、文件已存在就拒绝（不覆盖）、不能放在状态目录里；--steps 如 [3,4,7]：只导出这些序号（可含 eval，写成跳过项），',
    '                                          不给就留成功的动作和执行了的断言；不能重放的步骤（eval、没有稳定选择器的引用、含脱敏内容）写成跳过项',
    '  run <用例文件> [--name <名字>] [--json]    重放 save-case 导出的用例：open、每批最多 50 步的 step、close（要内核在跑）',
    '                                          结论由重放结果定：有失败或未执行、有不符是 fail；有不能重放的步骤是 undetermined；都相符是 pass；原会话里 agent 的结论照带，但标成未判定',
    '                                          --name 给新会话起名（缺省用用例里的名字）；放行声明和不允许的域名仍要人在弹框里批准（21：每 2 秒重试，同一个请求等满 120 秒才退出 21）',
    '                                          退出码：撞到登录墙 20 > 失败 11 > 不符 10 > 0；open、step 出错时是那个错误的码（2、21、22），已开的会话仍会收尾成 undetermined',
    '  login <url> [--profile <组>[/<槽>]]    在专用 profile 里登录（要在终端里由人按回车确认）；--profile 同 open',
    '  mcp                                    经标准输入输出提供 MCP 服务（每行一条 JSON-RPC；工具 open、step、close、run、save_case、status、doctor、rule_list；没有 login 和批准类工具；不带选项）',
    '  --version',
    '  help',
    '',
    '退出码：0 正常；10 有断言不符；11 有动作失败；20 撞到登录墙（open / step，请人运行 login）；21 等人在弹框里批准（原样重试）；2 用法错误、会话不存在或正忙；22 要人处理（内核没在跑、login 没有终端、状态目录有问题、身份探针不符：open 照样开会话，之后的 step 都是 22）',
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

// 发给内核（经共用的 makeSend：内核没在跑时补上启动命令；内核回的错误原样往上抛）。
function send(ctx: Ctx, home: Home, method: Method, params: unknown): Promise<unknown> {
  return makeSend(home, ctx.io.selfCmd)(method, params);
}

function print<T>(ctx: Ctx, result: T, format: (r: T) => string): void {
  ctx.io.out(ctx.json ? JSON.stringify(result) : format(result));
}

// 共用命令返回的结果：出错就当错误抛给 main 去打印，否则按格式打印、返回它的退出码。
function settle<T>(ctx: Ctx, outcome: CommandOutcome, format: (r: T) => string): number {
  if ('error' in outcome) throw new E2kError(outcome.error.code, outcome.error.message, outcome.error.next);
  print(ctx, outcome.result as T, format);
  return outcome.exit;
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
  const home = resolveHome(ctx.io.env);
  return settle(ctx, await kernelStatus((m, p) => send(ctx, home, m, p)), formatStatus);
}

async function doctor(ctx: Ctx, args: string[]): Promise<number> {
  positionals(ctx, parse(ctx, args, JSON_OPTION), 0, '无');
  return settle(ctx, await doctorChecks(resolveHome(ctx.io.env), ctx.io.makeDriver, ctx.io.selfCmd, ctx.io.managerName), formatChecks);
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
  return settle(ctx, listRules(home), formatRuleList);
}

async function open(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(ctx, args, { ...JSON_OPTION, viewport: { type: 'string' }, name: { type: 'string' }, touch: { type: 'boolean' }, readonly: { type: 'boolean' }, profile: { type: 'string' }, allow: { type: 'string' } });
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
  const allow = optString(p, 'allow');
  if (allow !== undefined) raw.allow = parseJson(allow, '--allow 必须是 JSON 数组');
  const home = resolveHome(ctx.io.env);
  return settle(ctx, await openSession((m, pp) => send(ctx, home, m, pp), raw), formatOpen);
}

async function step(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(ctx, args, { ...JSON_OPTION, stdin: { type: 'boolean' }, 'keep-going': { type: 'boolean' }, allow: { type: 'string' } });
  const fromStdin = p.values.stdin === true;
  const [session, inlineOps] = positionals(ctx, p, fromStdin ? 1 : 2, fromStdin ? '<会话>' : '<会话> <JSON 数组>');
  // 先查长度、不解析：超长的一律当用法错误，什么都不发。
  const text = inlineOps ?? await ctx.io.stdin.readAll(MAX_OPS_BYTES);
  if (Buffer.byteLength(text, 'utf8') > MAX_OPS_BYTES) throw usage(`操作的 JSON 最多 ${MAX_OPS_BYTES} 字节`);
  const ops = parseJson(text, '操作必须是一个 JSON 数组');
  const raw: Record<string, unknown> = { session, ops };
  if (p.values['keep-going'] === true) raw.keepGoing = true;
  const allow = optString(p, 'allow');
  if (allow !== undefined) raw.allow = parseJson(allow, '--allow 必须是 JSON 数组');
  const home = resolveHome(ctx.io.env);
  return settle(ctx, await stepOps((m, pp) => send(ctx, home, m, pp), raw), formatStep);
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
  const home = resolveHome(ctx.io.env);
  return settle(ctx, await closeSession((m, pp) => send(ctx, home, m, pp), raw), formatClose);
}

// 重试用的时钟：缺省是真的时间，测试注入假的。
function clockOf(ctx: Ctx): NonNullable<Io['clock']> {
  return ctx.io.clock ?? realClock;
}

const LOGIN_WAIT_MS = 120_000;
const LOGIN_RETRY_MS = 2000;

// login.begin 收到 21（等人在弹框里批准或选模式）就每 2 秒原样重试，最多等 120 秒；其他错误原样往上抛。
// 提示只打印一次。等到时间了返回 null。
async function beginLogin(ctx: Ctx, home: Home, params: unknown): Promise<unknown> {
  const clock = clockOf(ctx);
  const deadline = clock.now() + LOGIN_WAIT_MS;
  let told = false;
  for (;;) {
    try {
      return await send(ctx, home, 'login.begin', params);
    } catch (e) {
      if (!(e instanceof E2kError) || e.code !== 'wait-approval') throw e;
      if (!told) {
        told = true;
        const id = /请求 (a-[0-9a-f]{6})/.exec(e.message)?.[1];
        ctx.io.out(id === undefined ? '请在弹出的对话框里选择' : `请在弹出的对话框里选择（请求 ${id}）`);
      }
      if (clock.now() >= deadline) return null;
      await clock.sleep(LOGIN_RETRY_MS);
    }
  }
}

async function login(ctx: Ctx, args: string[]): Promise<number> {
  needsTerminal(ctx, 'login');
  const p = parse(ctx, args, { profile: { type: 'string' } });
  const [url] = positionals(ctx, p, 1, '<url>');
  const profile = optString(p, 'profile');
  const params = validateParams('login.begin', profile === undefined ? { url } : { url, profile });
  const home = resolveHome(ctx.io.env);
  const begun = await beginLogin(ctx, home, params);
  if (begun === null) {
    ctx.io.out('对话框超时，请重新运行 login');
    return ExitCode.WAIT_APPROVAL;
  }
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
  // 跨组导航被拦的次数（writesBlocked 里含它们）：不是只读规则拦的，另给一句；老内核没有这个字段。
  const cross = isObject(ended) && typeof ended.crossGroupBlocked === 'number' ? ended.crossGroupBlocked : 0;
  if (blocked - cross > 0) {
    ctx.io.out(`登录过程中有 ${blocked - cross} 条写被只读规则拦下：身份提供方（SSO、SAML、OIDC）的主机可能没列进 rules.json 的 loginHosts；在不允许的域名上登录时，窗口里这个域名也按只读算`);
  }
  if (cross > 0) {
    ctx.io.out(`登录过程中有 ${cross} 次跳到别的组的导航被拦：这个登录窗口只能用本组的域名和 loginHosts 里的主机`);
  }
  return ExitCode.OK;
}

async function saveCaseCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(ctx, args, { ...JSON_OPTION, out: { type: 'string' }, steps: { type: 'string' } });
  const [session] = positionals(ctx, p, 1, '<会话>');
  const out = optString(p, 'out');
  if (out === undefined) throw usage('缺少 --out <文件>');
  const steps = optString(p, 'steps');
  const outcome = saveCase(resolveHome(ctx.io.env), {
    session, out, ...(steps === undefined ? {} : { steps: parseJson(steps, '--steps 必须是 JSON 数组，如 [3,4,7]') as number[] }),
  });
  return settle<SaveCaseResult>(ctx, outcome, formatSaveCase);
}

// run：读用例文件、重放。等人批准的提示走标准错误（--json 时标准输出只有结果）。
async function runCmd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(ctx, args, { ...JSON_OPTION, name: { type: 'string' } });
  const [file] = positionals(ctx, p, 1, '<用例文件>');
  const name = optString(p, 'name');
  const home = resolveHome(ctx.io.env);
  const outcome = await runCaseFile((method, params) => send(ctx, home, method, params), file, {
    ...(name === undefined ? {} : { name }),
    clock: clockOf(ctx),
    onWaiting: (id) => { ctx.io.err(id === null ? '请在弹出的对话框里选择' : `请在弹出的对话框里选择（请求 ${id}）`); },
  });
  return settle<RunResult>(ctx, outcome, formatRun);
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
    case 'save-case': return saveCaseCmd(ctx, rest);
    case 'run': return runCmd(ctx, rest);
    case 'mcp':
      positionals(ctx, parse(ctx, rest, {}), 0, '无');
      return startMcp(ctx.io);
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
