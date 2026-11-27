import { strict as assert } from 'node:assert';
import { ApprovalStore } from '../../src/kernel/approval-store.ts';
import { createRulesResolver } from '../../src/kernel/rules.ts';
import type { Home } from '../../src/shared/paths.ts';

// 把 rules.json 现在的内容批准掉：用解析器的 approvePending，走和内核同一条真路径，不直接写 approvals.json。
// 必须在没有内核跑在这个 home 上时调用（批准记录运行中以内核内存里的为准）。
export function approveRulesFile(home: Home): void {
  const resolver = createRulesResolver(home.rulesFile, ApprovalStore.open(home.approvalsFile, () => {}));
  const pending = resolver.pending();
  assert.ok(pending !== null, 'rules.json has something to approve');
  assert.equal(resolver.approvePending(pending.hash), true);
}
