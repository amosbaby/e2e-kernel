import type { Mode } from '../shared/protocol.ts';

// 按主机名（不带端口）定会话模式（设计 5.2）。M1 没有域名规则，一律「默认」；M2 在这里实现规则。
export interface ModeResolver { resolve(host: string): Mode }

export const defaultOnlyResolver: ModeResolver = Object.freeze({ resolve: (): Mode => 'default' });
