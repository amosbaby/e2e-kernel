import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { E2kError } from '../shared/errors.ts';

// 人工批准的通道（设计 5.4）：内核自己弹 macOS 原生对话框，批准不经 CLI、不经协议。
// 这里只管「弹框」和「待批表」：谁来问、问什么由调用方定；没有任何开关、参数、环境变量能让批准自动通过，
// 弹不出框（没有桌面、被 --no-dialogs 关掉、osascript 出错）一律按没批准处理。

export interface DialogRequest { title: string; lines: string[]; buttons: string[]; defaultButton: string; timeoutSec: number }
export type DialogResult = { kind: 'button'; button: string } | { kind: 'timeout' } | { kind: 'unavailable'; why: string };
export interface Dialog { show(r: DialogRequest): Promise<DialogResult> }

export type ExecFn = (file: string, args: string[], o: { timeout: number }) => Promise<{ stdout: string }>;

export const MAX_LINE_CHARS = 200;
export const MAX_BODY_CHARS = 1500;
const KILL_GRACE_SEC = 15;
const MAX_TIMEOUT_SEC = 3600;
const COOLING_MS = 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_SHOWN = 6;
const ID_TRIES = 50;

// 对话框文字原样显示，不脱敏不截断，所以太长就直接拒绝这次请求，不弹框。
export function checkDialogText(r: DialogRequest): void {
  if (r.lines.some((l) => l.length > MAX_LINE_CHARS) || r.lines.join('\n').length > MAX_BODY_CHARS) {
    throw new E2kError('usage', '内容太长，框里显示不全', '拆开再来');
  }
}

// 请求的形状不对是内核自己的 bug：按钮 1 到 3 个、互不相同、不含换行，默认按钮在其中，秒数是正整数。
function shapeProblem(r: DialogRequest): string | null {
  if (r.buttons.length < 1 || r.buttons.length > 3) return '按钮数不对';
  if (new Set(r.buttons).size !== r.buttons.length) return '按钮重名';
  if (r.buttons.some((b) => b === '' || /[\r\n]/.test(b))) return '按钮名不合法';
  // 英文 Cancel：点它 osascript 以 -128 退出，会被当成弹不出，整个内核的弹框就此失效。
  if (r.buttons.some((b) => /^cancel$/i.test(b))) return '按钮名不能叫 Cancel';
  if (!r.buttons.includes(r.defaultButton)) return '默认按钮不在按钮里';
  if (!Number.isInteger(r.timeoutSec) || r.timeoutSec < 1 || r.timeoutSec > MAX_TIMEOUT_SEC) return '超时秒数不合法';
  return null;
}

// 脚本文本是固定的：正文、标题、默认按钮、秒数、按钮名全部经 argv 传入，绝不拼进脚本。
const SCRIPT_LINES = [
  'on run argv',
  'set theButtons to items 5 thru -1 of argv',
  'return display dialog (item 1 of argv) with title (item 2 of argv) buttons theButtons default button (item 3 of argv) giving up after ((item 4 of argv) as integer)',
  'end run',
];

const RESULT_SHAPE = /^button returned:(.*), gave up:(true|false)$/;

export const defaultExec: ExecFn =(file, args, o) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: o.timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    // 回调式 execFile 的 error 上没有 stderr：挂上它，osascript 的「用户取消」靠它认（isUserCancel 只看这个字段）。
    if (error !== null) reject(Object.assign(error, { stderr }));
    else resolve({ stdout });
  });
});

export async function defaultManagerName(): Promise<string | null> {
  try {
    return (await defaultExec('launchctl', ['managername'], { timeout: 5000 })).stdout.trim();
  } catch {
    return null;
  }
}

// 只认去掉一个末尾换行后的精确形状；按钮名必须在请求的按钮里，其余（非 0 退出、被杀、多出的输出）都算弹不出。
function parseResult(stdout: string, buttons: string[]): DialogResult {
  const text = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  const m = RESULT_SHAPE.exec(text);
  if (m === null) return { kind: 'unavailable', why: 'osascript 的输出格式不对' };
  if (m[2] === 'true') return { kind: 'timeout' };
  const button = m[1] ?? '';
  return buttons.includes(button) ? { kind: 'button', button } : { kind: 'unavailable', why: 'osascript 返回了未知的按钮' };
}

function isUserCancel(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const { stderr, killed } = e as { stderr?: unknown; killed?: unknown };
  return killed !== true && typeof stderr === 'string' && /\(-128\)|User canceled/i.test(stderr);
}

export function osascriptDialog(o: { exec?: ExecFn; managerName?: () => Promise<string | null> } = {}): Dialog {
  const exec = o.exec ?? defaultExec;
  const managerName = o.managerName ?? defaultManagerName;
  let aqua: Promise<boolean> | undefined;   // 第一次 show 前问一次 launchctl，之后沿用
  return {
    async show(r) {
      aqua ??= managerName().then((n) => n === 'Aqua', () => false);
      if (!(await aqua)) return { kind: 'unavailable', why: '当前不在图形登录会话里，弹不了框' };
      if (shapeProblem(r) !== null) return { kind: 'unavailable', why: '对话框请求不合法' };
      // argv 顺序：正文、标题、默认按钮、秒数、各按钮名。`--` 之后的内容不会被当成 osascript 的选项。
      const args = [...SCRIPT_LINES.flatMap((l) => ['-e', l]), '--', r.lines.join('\n'), r.title, r.defaultButton, String(r.timeoutSec), ...r.buttons];
      try {
        const { stdout } = await exec('osascript', args, { timeout: (r.timeoutSec + KILL_GRACE_SEC) * 1000 });
        return parseResult(stdout, r.buttons);
      } catch (e) {
        // 人取消（点了被当作系统取消键的按钮；真机实测按 Esc 对这些框没有作用，所以这里只是兜底）：osascript 以 1 退出，stderr 里是「User canceled. (-128)」。
        // 这是人的答复，不是弹不出：按「按了默认按钮」处理（所有批准框的默认按钮都是拒绝一类，ask 保证批准键不含默认按钮）。
        // 只看 stderr 字段：错误消息里带着命令行参数（正文），正文里出现这几个字不能算取消；被杀（超时）的更不算。
        if (isUserCancel(e)) return { kind: 'button', button: r.defaultButton };
        // 非 0 退出、超时被杀、找不到 osascript：原始错误里会带着命令行参数（正文），不往外传。
        return { kind: 'unavailable', why: 'osascript 没有正常结束' };
      }
    },
  };
}

export const noDialog: Dialog = {
  show: async () => ({ kind: 'unavailable', why: '内核以 --no-dialogs 启动' }),
};

export type ApprovalKind = 'rules' | 'writes' | 'login';
export type ApprovalState =
  | { status: 'approved'; button: string }
  | { status: 'denied'; cooling: boolean }
  | { status: 'pending'; id: string }
  | { status: 'unavailable'; why: string };

interface Entry {
  id: string; kind: ApprovalKind; req: DialogRequest; approveButtons: string[];
  state: 'queued' | 'showing' | 'approved' | 'denied';
  button?: string;
}

export function pendingError(id: string, what: string): E2kError {
  return new E2kError('wait-approval', `等人在弹框里批准：${what}（请求 ${id}）`, '人点完以后，原样重试这条命令');
}

// 待批表。结果在内存里按内容键存放，调用方重试时靠同一个键对上；ask 同步返回，框在后台弹。
// 同一时刻屏幕上最多一个框，其余按先来先弹排队。
export class Approvals {
  private readonly dialog: Dialog;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private showing: string | null = null;
  private readonly lastDenied = new Map<ApprovalKind, number>();
  private shown: number[] = [];
  private broken: string | null = null;

  constructor(dialog: Dialog, log: (line: string) => void, o: { now?: () => number; newId?: () => string } = {}) {
    this.dialog = dialog;
    this.log = log;
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => `a-${randomBytes(3).toString('hex')}`);
  }

  ask(key: string, kind: ApprovalKind, req: DialogRequest, approveButtons: string[]): ApprovalState {
    checkDialogText(req);
    const problem = shapeProblem(req);
    if (problem !== null) throw new E2kError('internal', `对话框请求不合法：${problem}`);
    // 批准键必须是这个框里的按钮，且不能是默认按钮（回车就批准了）。
    if (approveButtons.includes(req.defaultButton) || !approveButtons.every((b) => req.buttons.includes(b))) {
      throw new E2kError('internal', '对话框请求不合法：批准按钮不对');
    }
    const t = this.now();
    const have = this.entries.get(key);
    if (have !== undefined) {
      if (have.state === 'approved') return { status: 'approved', button: have.button ?? '' };
      if (have.state === 'denied') {
        return { status: 'denied', cooling: false };   // 被拒的请求一直记到 forget 或内核重启，不再问
      } else {
        return { status: 'pending', id: have.id };
      }
    }
    if (this.broken !== null) return { status: 'unavailable', why: this.broken };
    const last = this.lastDenied.get(kind);
    if (last !== undefined && t - last < COOLING_MS) return { status: 'denied', cooling: true };
    if (this.showing === null && this.shownRecently(t) >= RATE_MAX_SHOWN) return { status: 'unavailable', why: '弹框太频繁，请人看一下' };
    const entry: Entry = { id: this.freshId(), kind, req, approveButtons: [...approveButtons], state: 'queued' };
    this.entries.set(key, entry);
    this.queue.push(key);
    this.pump();
    return { status: 'pending', id: entry.id };
  }

  // 只读：这个键现在的状态（没有这个键是 undefined）。调用方用它发现自己问过的框已经被拒了，不改变任何状态。
  stateOf(key: string): 'queued' | 'showing' | 'approved' | 'denied' | undefined {
    return this.entries.get(key)?.state;
  }

  // 调用方把批准的结果落盘之后调：之后同一个键重新来问就是一件新事。
  forget(key: string): void {
    const e = this.entries.get(key);
    if (e === undefined || e.state === 'queued' || e.state === 'showing') return;   // 还在弹或排队的不动
    this.entries.delete(key);
  }

  // 把已经批准、还没被用掉的答案作废（键满足 match 的）：调用方换了新的基线之后，旧基线上的批准不该再留着。
  // 被拒的键、还在弹或排队的不动：被拒的一直记到内核重启，是 Task 2 定的规则。
  forgetApproved(match: (key: string) => boolean): void {
    for (const [key, e] of [...this.entries]) {
      if (e.state === 'approved' && match(key)) this.entries.delete(key);
    }
  }

  private shownRecently(t: number): number {
    this.shown = this.shown.filter((x) => t - x < RATE_WINDOW_MS);
    return this.shown.length;
  }

  private freshId(): string {
    for (let i = 0; i < ID_TRIES; i++) {
      const id = this.newId();
      if (![...this.entries.values()].some((e) => e.id === id)) return id;
    }
    throw new E2kError('internal', '请求 id 重复太多次');
  }

  private pump(): void {
    while (this.showing === null && this.broken === null) {
      const key = this.queue.shift();
      if (key === undefined) return;
      const entry = this.entries.get(key);
      if (entry === undefined || entry.state !== 'queued') continue;
      const t = this.now();
      const denied = this.lastDenied.get(entry.kind);
      if (denied !== undefined && t - denied < COOLING_MS) {
        this.entries.delete(key);   // 排队期间同类被拒了：不弹，调用方重试时 ask 走冷却分支
        continue;
      }
      if (this.shownRecently(t) >= RATE_MAX_SHOWN) {
        this.entries.delete(key);   // 排队期间额度用完了：不弹，调用方重试时会得到 unavailable
        this.log('待批请求因弹框太频繁被丢弃');
        continue;
      }
      this.shown.push(t);
      entry.state = 'showing';
      this.showing = key;
      void this.run(key, entry);
    }
  }

  private async run(key: string, entry: Entry): Promise<void> {
    let result: DialogResult;
    try {
      result = await this.dialog.show({ ...entry.req, title: `${entry.req.title}（请求 ${entry.id}）` });
    } catch (e) {
      result = { kind: 'unavailable', why: `对话框出错（${e instanceof Error ? e.name : typeof e}）` };   // 不带消息：消息里可能有正文
    }
    this.showing = null;
    const t = this.now();
    if (result.kind === 'button') {
      if (entry.approveButtons.includes(result.button)) {
        entry.state = 'approved';
        entry.button = result.button;
      } else {
        entry.state = 'denied';
        this.lastDenied.set(entry.kind, t);
      }
    } else if (result.kind === 'timeout') {
      this.entries.delete(key);   // 没人理：下次再问
    } else {
      this.entries.delete(key);
      this.broken = result.why;
      this.log(`对话框不可用：${result.why}`);
      for (const k of this.queue.splice(0)) this.entries.delete(k);
    }
    this.pump();
  }
}
