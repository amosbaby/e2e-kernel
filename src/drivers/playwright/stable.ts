import type { Stable } from '../../driver/types.ts';
import type { Target } from '../../shared/ops.ts';

// 把快照引用对应的元素变成稳定选择器的候选规则（设计 5.8）。纯函数，不碰浏览器。

export interface ElementInfo { testId: string | null; id: string | null; role: string | null; name: string | null; cssPath: string }

// 保守地只认 ASCII：不是这里认得的标识符一律走 [id="…"]，那种写法对任何字符串都成立。
const CSS_IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
// 角色只允许普通单词，免得页面给的角色字符串把选择器的括号提前闭合。
const ROLE_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ROLE_TARGET = /^role=([A-Za-z][A-Za-z0-9_-]*)\[name="((?:[^"\\]|\\[\s\S])*)"\]$/;

function has(v: string | null): v is string {
  return v !== null && v !== '';
}

function quote(v: string): string {
  return v.replace(/[\\"]/g, '\\$&');
}

// 按 testid → id → role → css 的顺序出候选；css 总是最后一个。
export function stableCandidates(info: ElementInfo): Stable[] {
  const out: Stable[] = [];
  if (has(info.testId)) out.push({ selector: `[data-testid="${quote(info.testId)}"]`, via: 'testid' });
  if (has(info.id)) out.push({ selector: CSS_IDENT.test(info.id) ? `#${info.id}` : `[id="${quote(info.id)}"]`, via: 'id' });
  if (has(info.role) && has(info.name) && ROLE_WORD.test(info.role))
    out.push({ selector: `role=${info.role}[name="${quote(info.name)}"]`, via: 'role' });
  out.push({ selector: info.cssPath, via: 'css' });
  return out;
}

// 只认 role=<role>[name="<name>"] 这一种写法，是 stableCandidates 写出来的那种的逆。
export function parseRoleTarget(t: Target): { role: string; name: string } | null {
  const m = ROLE_TARGET.exec(t);
  if (m === null) return null;
  return { role: m[1] ?? '', name: (m[2] ?? '').replace(/\\([\s\S])/g, '$1') };
}
