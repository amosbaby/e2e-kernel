import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { DriverError } from '../../driver/types.ts';

// 浏览器进程：由驱动自己 spawn，控制通道走管道（--remote-debugging-pipe），不开任何调试端口。
// 为什么不用 launchPersistentContext：它给浏览器带一个 about:blank 启动页，开浏览器就抢前台；
// 不用 --remote-debugging-port：本机任何进程都能连上无认证的调试端口、完全控制这个带登录态的浏览器。
// 管道只有两端（内核和这个浏览器进程）持有，别的进程碰不到（docs/m0-findings.md §7.3）。
// Playwright 通过 connectOverCDP 的公开重载（ConnectOverCDPTransport，见 types.d.ts）接管这条管道。

// Chromium 命令行开关。来自 Playwright 1.65.1 自己启动浏览器时用的那一份（packages/playwright-core 的 chromiumSwitches），
// 去掉了只对 Windows、Edge、Android 有意义的几项，也不带 --no-sandbox（保留浏览器自己的沙箱）。
// 不是随手挑的：Playwright 的文档提醒，不用它的启动参数，部分功能会坏。要紧的几项：
// - --use-mock-keychain、--password-store=basic：profile 里的 cookie 是按这个方式加密的，换了就读不出登录态，还会弹钥匙串框；
// - --disable-popup-blocking：页面自己 window.open 的弹窗不被拦；
// - --disable-renderer-backgrounding、--disable-background-timer-throttling、--disable-backgrounding-occluded-windows：
//   后台开的页和被遮住的窗口不降速，否则 fill、截图会卡；
// - --disable-back-forward-cache、--disable-features 里的 HttpsUpgrades 等：保证请求都走路由，http 不被自动升级。
// 版本升级时对照新版本的 chromiumSwitches 复核；test/unit/browser-process.test.ts 守着这几项不丢。
const DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'HttpsUpgrades', 'HttpsFirstBalancedModeAutoEnable',
  'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'AvoidCorsURLLoaderRestartOnRedirect',
  'OptimizationHints', 'NetworkTimeServiceQuerying', 'AimEnabled', 'PreconnectToSearch',
];
const ENABLED_FEATURES = ['CDPScreenshotNewSurface', 'SkipListAccountsWithoutGaiaCookies'];

export const BROWSER_SWITCHES: readonly string[] = [
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-extensions',
  `--disable-features=${DISABLED_FEATURES.join(',')}`,
  `--enable-features=${ENABLED_FEATURES.join(',')}`,
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--disable-search-engine-choice-screen',
  '--unsafely-disable-devtools-self-xss-warnings',
  '--enable-unsafe-swiftshader',
  '--disable-infobars',
  '--disable-sync',
];

// 完整参数：开关 + 管道 + 不开启动窗口 + profile 目录。
// 绝不能出现：--remote-debugging-port、--remote-debugging-address（会开 TCP 口）、不带 - 的参数（会被当成启动页，开窗口抢前台）。
export function browserArgs(userDataDir: string): string[] {
  return [...BROWSER_SWITCHES, '--remote-debugging-pipe', '--no-startup-window', `--user-data-dir=${userDataDir}`];
}

// ---- 管道上的 CDP 传输 ----
// 帧格式：一条 JSON 消息后面跟一个 NUL 字节（Chromium 的约定）。我们写 fd 3（浏览器读），读 fd 4（浏览器写）。
// 这个形状就是 Playwright 的 ConnectOverCDPTransport。
export interface PipeTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  send(message: object): void;
  close(): void;
}

// 单条消息的上限：截图的 base64 能到几十 MB，给到 256 MiB；超过当管道坏了，直接断开（失败关闭）。已经收完的消息不累计。
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

function isPlainObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function pipeTransport(write: Writable, read: Readable, maxMessageBytes: number = MAX_MESSAGE_BYTES): PipeTransport {
  let closed = false;
  let chunks: Buffer[] = [];
  let pending = 0;

  // 一条消息一个事件循环任务（setImmediate）：Node 在每个 setImmediate 回调之间清微任务，所以一条消息的 promise 续接
  // 一定先于下一条消息。Playwright 在处理上一条响应的续接里才登记 frame、建上下文，浏览器一口气发来的「响应 + 紧跟的事件」
  // 如果在同一个同步循环里全派发，事件会赶在登记之前到，页面的主世界执行上下文就丢了（实测：新开页里 evaluate 一直挂着）。
  // Playwright 自带的管道传输同样一条一任务；WebSocket 传输天然如此。setImmediate 按登记顺序先进先出，onclose 排在已收到的消息之后。
  const finish = (reason: string): void => {
    if (closed) return;
    closed = true;
    chunks = [];
    pending = 0;
    try { write.end(); } catch { /* 写端已经没了 */ }
    read.destroy();
    setImmediate(() => { t.onclose?.(reason); });
  };

  const t: PipeTransport = {
    send(message) {
      if (closed) return;
      try {
        write.write(`${JSON.stringify(message)}\0`);
      } catch {
        finish('pipe write failed');
      }
    },
    close() {
      if (closed) return;
      closed = true;
      chunks = [];
      pending = 0;
      try { write.end(); } catch { /* 写端已经没了 */ }
      read.destroy();
      setImmediate(() => { t.onclose?.('closed'); });
    },
  };

  write.on('error', () => { finish('pipe write failed'); });
  read.on('error', () => { finish('pipe read failed'); });
  read.on('close', () => { finish('pipe closed'); });
  read.on('data', (data: Buffer) => {
    if (closed) return;
    let start = 0;
    for (;;) {
      const nul = data.indexOf(0, start);
      if (nul < 0) break;
      chunks.push(data.subarray(start, nul));
      const text = Buffer.concat(chunks).toString('utf8');
      chunks = [];
      pending = 0;
      start = nul + 1;
      if (text === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish('malformed message on the pipe');
        return;
      }
      if (!isPlainObject(parsed)) {
        finish('malformed message on the pipe');
        return;
      }
      const message = parsed;
      setImmediate(() => { t.onmessage?.(message); });
    }
    if (start < data.length) {
      chunks.push(data.subarray(start));
      pending += data.length - start;
      if (pending > maxMessageBytes) finish('message too large');
    }
  });
  return t;
}

// ---- 浏览器进程 ----

export interface BrowserProcess {
  readonly transport: PipeTransport;
  // 在 exit 事件（或 spawn 失败）之后 resolve，值是退出码（被信号结束或 spawn 失败为 null）。
  readonly exited: Promise<number | null>;
  hasExited(): boolean;
  // spawn 失败时的错误码（比如 ENOENT），没有就是 null。不含路径。
  spawnErrorCode(): string | null;
  // 先关管道（浏览器看到管道断了会自己退），等 graceMs；还在就 SIGTERM，再等；还在就 SIGKILL（连同它自己的进程组）。
  // 只对自己 spawn 出来的这一个进程动手，且只在它还没退出时发信号（退出之后 pid 可能已被别的进程用掉）。永不抛错。
  terminate(graceMs?: number): Promise<void>;
}

export interface BrowserProcessDeps {
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  // 发信号：pid 为负表示进程组。默认 process.kill。
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

const DEFAULT_GRACE_MS = 3000;

export function startBrowser(executable: string, userDataDir: string, deps: BrowserProcessDeps = {}): BrowserProcess {
  const spawn = deps.spawn ?? nodeSpawn;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals): void => { process.kill(pid, signal); });
  // 一律 argv，不经 shell。detached：自成进程组，终端里的 Ctrl-C 不会直接打到浏览器（关停由内核自己做）；
  // 内核自己意外没了，管道断开，浏览器随之退出，不会留下带登录态的孤儿进程。
  // stdio：0、1、2 不要；3 是浏览器读的管道，4 是浏览器写的管道。
  const child = spawn(executable, browserArgs(userDataDir), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true, shell: false });
  const write = child.stdio[3];
  const read = child.stdio[4];
  if (write === null || write === undefined || read === null || read === undefined) {
    try { child.kill('SIGKILL'); } catch { /* 没起来 */ }
    throw new DriverError('other', 'browser pipes are not available');
  }
  const transport = pipeTransport(write as Writable, read as Readable);

  let exited = false;
  let errorCode: string | null = null;
  const pid = child.pid;
  const exitedPromise = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => { exited = true; resolve(code); });
    child.once('error', (e: NodeJS.ErrnoException) => {
      // spawn 失败（没有可执行文件、没权限）：不会再有 exit 事件。
      if (pid === undefined) { exited = true; errorCode = typeof e.code === 'string' ? e.code : 'ERROR'; resolve(null); }
    });
  });

  const waitExit = (ms: number): Promise<boolean> => {
    if (exited) return Promise.resolve(true);
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      exitedPromise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  };
  const signal = (sig: NodeJS.Signals, group: boolean): void => {
    if (exited || pid === undefined) return;
    try { kill(pid, sig); } catch { /* 已经没了 */ }
    if (group) {
      try { kill(-pid, sig); } catch { /* 进程组已经空了 */ }
    }
  };

  return {
    transport,
    exited: exitedPromise,
    hasExited: () => exited,
    spawnErrorCode: () => errorCode,
    async terminate(graceMs = DEFAULT_GRACE_MS) {
      try {
        transport.close();
        if (await waitExit(graceMs)) return;
        signal('SIGTERM', false);
        if (await waitExit(graceMs)) return;
        signal('SIGKILL', true);
        await waitExit(graceMs);
      } catch { /* 不抛 */ }
    },
  };
}
