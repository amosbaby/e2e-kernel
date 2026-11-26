export type ErrorCode = 'usage' | 'not-found' | 'busy' | 'action-failed' | 'internal' | 'needs-human' | 'wait-login' | 'wait-approval';

// 内核和 CLI 共用的错误：code 决定退出码，next 是给调用方的下一步建议（可选）。
export class E2kError extends Error {
  code: ErrorCode;
  next?: string;

  constructor(code: ErrorCode, message: string, next?: string) {
    super(message);
    this.name = 'E2kError';
    this.code = code;
    if (next !== undefined) this.next = next;
  }
}
