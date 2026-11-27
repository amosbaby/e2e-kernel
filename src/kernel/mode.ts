import type { Mode } from '../shared/protocol.ts';
import type { ApprovalsStatus } from './approval-store.ts';
import type { Group } from './rules.ts';

// 域名规则里能写的模式。'denied' 是 M3 的事，规则文件现在不收。
export type RuleMode = 'readonly' | 'default';

// 规则的当前状态。count、hash：当前**生效**的那份（人批准过的快照）；没有批准过为 0 条、hash 为 null。
// error：规则文件现在改坏了（生效的仍是批准快照）。
// pending：规则文件和批准快照不一致，等人批准（hash 是显示用的短哈希，null 表示文件被删了）；没有为 null。
// 待批文件里的收紧同时已按「更严合并」生效，所以报告要同时记 hash（已批准的）和 pendingHash（待批的）。
// approvals：启动时批准记录的状态（读不了 = 现有规则全部重新批准）；approvalsChanged：运行中磁盘上的批准记录被外部改过
// （只是提示，生效的仍是内存里最后一次批准）。
export interface RulesState {
  count: number; hash: string | null; error: string | null;
  pending: { hash: string | null; tooLong: boolean } | null;
  pendingHash: string | null;   // 待批文件的短哈希（和 hash 同一写法，给报告用）；没有待批、或待批是删文件时为 null
  approvals: ApprovalsStatus; approvalsChanged: boolean;
}

// 待批的规则改动。text 是内存里留着的原文（批准时写的就是它，不重读磁盘），hash 是它的完整 sha256（64 位十六进制，待批的身份，approvePending 比的就是它；状态和报告里只露短哈希，64 位十六进制会被脱敏）；文件被删时两者都是 null。
// summary 是和已批准内容逐字段比较的完整差异，放宽的排前面；超过 12 行 tooLong 为 true。
export interface PendingRules { hash: string | null; text: string | null; summary: string[]; tooLong: boolean }

// 按主机名（不带端口）定会话模式（设计 5.2）。
export interface ModeResolver {
  // 入口先规范化主机；规范化失败按 'readonly'（失败关闭）。用缓存，不碰文件。
  // 只认批准快照；规则文件有待批的改动时，取「已批准」和「待批文件」里更严的那份（待批是删文件则只看已批准的）。
  resolve(host: string): Mode;
  // 命中的规则模式，没命中（或主机不合格）为 null。给 ModeChange.reason 用。
  ruleFor(host: string): RuleMode | null;
  // 主机所在的域名组；没编组、或主机不合格，是合成的 'default' 组。
  groupOf(host: string): Group;
  // 按名字取组；'default' 总有，没有这个名字为 null。
  group(name: string): Group | null;
  // 入口先规范化主机；失败为 false。只看 group 那个组的 loginHosts（'default' 组 = 顶层 loginHosts）；没有这个组为 false。
  isLoginHost(host: string, group: string): boolean;
  // 读规则文件和它的批准状态：和已批准的快照一样 = 无待批；不一样且解析得了 = 待批；改坏 = error（坏文件不进待批）。
  // 生效的永远是批准快照；这里只更新「待批」和「有错」。
  refresh(): void;
  state(): RulesState;
  // 内存里待批的那份（没有为 null）。
  pending(): PendingRules | null;
  // 只有内存里待批的哈希等于 hash 时，把内存里那份原文写进批准记录并生效，返回 true；否则 false（调用方重新 refresh）。
  // 不重读磁盘。批准记录写不进磁盘时抛 E2kError，什么都不变。
  approvePending(hash: string | null): boolean;
}

const emptyDefaultGroup = (): Group => ({ name: 'default', hosts: [], loginHosts: [], readPosts: [], persistedQueries: [], logout: [], identity: null });

// 测试用：永远「默认」、没有登录主机、没有组。
export const defaultOnlyResolver: ModeResolver = Object.freeze({
  resolve: (): Mode => 'default',
  ruleFor: (): RuleMode | null => null,
  groupOf: emptyDefaultGroup,
  group: (name: string): Group | null => (name === 'default' ? emptyDefaultGroup() : null),
  isLoginHost: (): boolean => false,
  refresh: (): void => {},
  state: (): RulesState => ({ count: 0, hash: null, error: null, pending: null, pendingHash: null, approvals: 'absent', approvalsChanged: false }),
  pending: (): PendingRules | null => null,
  approvePending: (): boolean => false,
});
