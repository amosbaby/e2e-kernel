import type { Decision, RequestInfo } from '../driver/types.ts';
import type { Mode } from '../shared/protocol.ts';

// 写策略（设计 5.3）。M1 一律放行；M2 在这里实现规则。
// decide 收到还没有实现的模式时必须拒绝（返回 abort），不能放行。
export interface WritePolicy {
  decide(req: RequestInfo, ctx: { mode: Mode; topHost: string | null }): Decision;   // 属于某个会话的页发出的请求
  decideUnattributed(req: RequestInfo): Decision;                                    // 归不到任何会话或登录页的请求
}

export const allowAllPolicy: WritePolicy = Object.freeze({ decide: (): Decision => ({ action: 'continue' }), decideUnattributed: (): Decision => ({ action: 'continue' }) });
