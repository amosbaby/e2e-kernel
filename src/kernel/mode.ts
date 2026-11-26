import type { Mode } from '../shared/protocol.ts';

// 域名规则里能写的模式。'denied' 是 M3 的事，规则文件现在不收。
export type RuleMode = 'readonly' | 'default';

// 规则缓存的当前状态。hash：当前生效那份文件内容的 'sha256:' + 前 16 位十六进制；没有文件为 null。
// 文件改坏了：hash 仍是上一份好文件的（生效的那份），error 非 null。
export interface RulesState { count: number; hash: string | null; error: string | null }

// 按主机名（不带端口）定会话模式（设计 5.2）。
export interface ModeResolver {
  // 入口先规范化主机；规范化失败按 'readonly'（失败关闭）。用缓存，不碰文件。
  resolve(host: string): Mode;
  // 命中的规则模式，没命中（或主机不合格）为 null。给 ModeChange.reason 用。
  ruleFor(host: string): RuleMode | null;
  // 入口先规范化主机；失败为 false。
  isLoginHost(host: string): boolean;
  // 读文件比内容哈希，变了才重新解析。解析失败：保留上一份好的，error 置为说明。
  refresh(): void;
  state(): RulesState;
}

// 测试用：永远「默认」、没有登录主机。
export const defaultOnlyResolver: ModeResolver = Object.freeze({
  resolve: (): Mode => 'default',
  ruleFor: (): RuleMode | null => null,
  isLoginHost: (): boolean => false,
  refresh: (): void => {},
  state: (): RulesState => ({ count: 0, hash: null, error: null }),
});
