import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { E2kError } from '../shared/errors.ts';

// 批准记录（设计 5.4）：人批准过的东西，由内核自己存在 $E2K_HOME/approvals.json。
// 只有内核写；启动时读一次，运行中以内存里的为准——磁盘上的文件被改了、删了、换成符号链接，都不会让内存里的批准降级，
// 只会让 externallyChanged() 报一声（给 status 和 doctor 当提示）。读不了就当没批准过，现有规则全部重新批准。

// 规范化后的放行声明；url 是规范化字符串（不带查询串）。
export interface Declaration { method: string; url: string; operation: string | null }
export type HostMode = 'default' | 'readonly';
export interface ApprovalRecord {
  rules: { hash: string; text: string } | null;
  writes: Record<string, Declaration[]>;
  hostModes: Record<string, HostMode>;
}
export type ApprovalsStatus = 'ok' | 'absent' | 'unreadable';

const MAX_BYTES = 2 * 1024 * 1024;
const TEMP_TRIES = 5;
const KEYS = ['hostModes', 'rules', 'schema', 'writes'];

const emptyRecord = (): ApprovalRecord => ({ rules: null, writes: {}, hostModes: {} });

function plain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(o).sort().join(',') === keys.join(',');
}

// `__proto__` 作键会在后面按键赋值时改掉原型：当成坏文件。
function safeKeys(o: Record<string, unknown>): boolean {
  return !Object.keys(o).includes('__proto__');
}

function parseDeclaration(v: unknown): Declaration | null {
  if (!plain(v) || !exactKeys(v, ['method', 'operation', 'url'])) return null;
  if (typeof v.method !== 'string' || typeof v.url !== 'string') return null;
  if (v.operation !== null && typeof v.operation !== 'string') return null;
  return { method: v.method, url: v.url, operation: v.operation };
}

// 形状严格：多一个键、少一个键、值的类型不对，都是 null。
function parseRecord(text: string): ApprovalRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!plain(v) || !exactKeys(v, KEYS) || v.schema !== 1) return null;
  let rules: ApprovalRecord['rules'] = null;
  if (v.rules !== null) {
    if (!plain(v.rules) || !exactKeys(v.rules, ['hash', 'text']) || typeof v.rules.hash !== 'string' || typeof v.rules.text !== 'string') return null;
    rules = { hash: v.rules.hash, text: v.rules.text };
  }
  if (!plain(v.writes) || !safeKeys(v.writes) || !plain(v.hostModes) || !safeKeys(v.hostModes)) return null;
  const writes: Record<string, Declaration[]> = {};
  for (const [k, list] of Object.entries(v.writes)) {
    if (!Array.isArray(list)) return null;
    const ds = list.map(parseDeclaration);
    if (ds.some((d) => d === null)) return null;
    writes[k] = ds as Declaration[];
  }
  const hostModes: Record<string, HostMode> = {};
  for (const [k, m] of Object.entries(v.hostModes)) {
    if (m !== 'default' && m !== 'readonly') return null;
    hostModes[k] = m;
  }
  return { rules, writes, hostModes };
}

type Raw = { status: 'absent' } | { status: 'unreadable' } | { status: 'ok'; text: string };

// 按「不信任」读：不跟符号链接、O_NONBLOCK（换成 FIFO 也不会卡住）、必须是不超过 2 MB 的普通文件。
function readRaw(file: string): Raw {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { status: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return { status: 'unreadable' };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, got) > 0) return { status: 'unreadable' };   // 读的当中变大了
    return { status: 'ok', text: buf.subarray(0, got).toString('utf8') };
  } catch {
    return { status: 'unreadable' };
  } finally {
    closeSync(fd);
  }
}

// 读不了（不是普通文件、符号链接、超 2 MB、坏 JSON、形状不对）和没有文件，都返回空记录，只靠 status 区分。
export function readApprovals(file: string): { record: ApprovalRecord; status: ApprovalsStatus } {
  const raw = readRaw(file);
  if (raw.status !== 'ok') return { record: emptyRecord(), status: raw.status };
  const record = parseRecord(raw.text);
  return record === null ? { record: emptyRecord(), status: 'unreadable' } : { record, status: 'ok' };
}

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// 磁盘上现在是什么：'absent'、'unreadable'，或 'ok:' 加内容哈希。
function labelOf(file: string): string {
  const raw = readRaw(file);
  if (raw.status !== 'ok') return raw.status;
  return parseRecord(raw.text) === null ? 'unreadable' : `ok:${digest(raw.text)}`;
}

export interface StoreOptions { randomName?: () => string }

export class ApprovalStore {
  readonly startupStatus: ApprovalsStatus;
  private record: ApprovalRecord;
  private expected: string;   // 内核认为磁盘上该是什么（启动时读到的，或自己最后写出的）
  private readonly file: string;
  private readonly log: (line: string) => void;
  private readonly randomName: () => string;

  private constructor(file: string, log: (line: string) => void, o: StoreOptions) {
    this.file = file;
    this.log = log;
    this.randomName = o.randomName ?? (() => randomBytes(6).toString('hex'));
    const raw = readRaw(file);
    const parsed = raw.status === 'ok' ? parseRecord(raw.text) : null;
    if (raw.status === 'ok' && parsed !== null) {
      this.startupStatus = 'ok';
      this.record = parsed;
      this.expected = `ok:${digest(raw.text)}`;
    } else {
      this.startupStatus = raw.status === 'absent' ? 'absent' : 'unreadable';
      this.record = emptyRecord();
      this.expected = raw.status === 'absent' ? 'absent' : 'unreadable';
      if (this.startupStatus === 'unreadable') log('批准记录读不了：现有规则全部要重新批准');
    }
  }

  static open(file: string, log: (line: string) => void, o: StoreOptions = {}): ApprovalStore {
    return new ApprovalStore(file, log, o);
  }

  // 内存里的副本：改它不会改变批准。
  get(): ApprovalRecord {
    return structuredClone(this.record);
  }

  // f 拿到副本，返回新记录。先落盘、成功了才换内存里的：太大、形状不对、写不出去，内存和磁盘都不变。
  update(f: (r: ApprovalRecord) => ApprovalRecord): void {
    const next = f(structuredClone(this.record));
    const text = `${JSON.stringify({ schema: 1, rules: next.rules, writes: next.writes, hostModes: next.hostModes })}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new E2kError('needs-human', '批准记录太大');
    const back = parseRecord(text);
    if (back === null) throw new E2kError('internal', '批准记录的形状不对');   // 写出去自己读不回来的东西不写
    this.writeAtomic(text);
    this.record = back;
    this.expected = `ok:${digest(text)}`;
  }

  // 磁盘上现在的样子和内核认为的不一样（被改、被删、读不了）。每次读一次磁盘；只用来报提示，从不把磁盘内容读回内存。
  externallyChanged(): boolean {
    return labelOf(this.file) !== this.expected;
  }

  // 同目录随机名临时文件（O_EXCL、不跟符号链接、0600）写完再 rename；撞名换一个名字，绝不覆盖已有的文件。
  private writeAtomic(text: string): void {
    const dir = dirname(this.file);
    for (let i = 0; i < TEMP_TRIES; i++) {
      const tmp = join(dir, `.${basename(this.file)}.${this.randomName()}.tmp`);
      let fd: number;
      try {
        fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ELOOP') continue;
        this.log(`批准记录写不出去（${code ?? 'error'}）`);
        throw new E2kError('needs-human', '批准记录写不进磁盘');
      }
      try {
        fchmodSync(fd, 0o600);
        const bytes = Buffer.from(text, 'utf8');
        let at = 0;
        while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
        closeSync(fd);
        fd = -1;
        renameSync(tmp, this.file);
        return;
      } catch (e) {
        if (fd >= 0) closeSync(fd);
        try { unlinkSync(tmp); } catch { /* 已经没了 */ }
        this.log(`批准记录写不出去（${(e as NodeJS.ErrnoException).code ?? 'error'}）`);
        throw new E2kError('needs-human', '批准记录写不进磁盘');
      }
    }
    this.log('批准记录写不出去（临时文件名一直撞名）');
    throw new E2kError('needs-human', '批准记录写不进磁盘');
  }
}
