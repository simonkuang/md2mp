import type { LintIssue } from "../../types";

/** var() 正则：匹配 var(--x) 或 var(--x, fallback)，支持嵌套括号 */
const VAR_RE = /var\(\s*(--[\w-]+)\s*(,\s*([^()]*))?\)/g;

export interface ResolveVarsResult {
  /** 展开后的变量表 */
  vars: Record<string, string>;
  lint: LintIssue[];
}

/**
 * 解析变量表本身：展开变量值中可能存在的 var() 引用。
 * @param sources 变量来源，按优先级从低到高排列（后者覆盖前者）
 */
export function resolveVariables(
  sources: Array<Record<string, string>>,
): ResolveVarsResult {
  const merged: Record<string, string> = {};
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "string") merged[k] = v;
    }
  }

  const lint: LintIssue[] = [];
  const MAX_DEPTH = 32;

  const resolveValue = (value: string, stack: string[], depth: number): string => {
    if (depth > MAX_DEPTH) return value;
    return value.replace(VAR_RE, (whole, name: string, _group: string | undefined, fallback: string | undefined) => {
      if (stack.includes(name)) {
        // 循环引用：返回空，让外层记录
        return "";
      }
      if (Object.prototype.hasOwnProperty.call(merged, name)) {
        return resolveValue(merged[name]!, [...stack, name], depth + 1);
      }
      if (fallback !== undefined) {
        return resolveValue(fallback.trim(), [...stack, name], depth + 1);
      }
      // 未定义变量：保留占位但记录 lint
      lint.push({
        ruleId: "MP044",
        level: "error",
        message: `var(${name}) 引用了未定义变量，已保留原样`,
        snippet: whole,
      });
      return whole;
    });
  };

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    out[k] = resolveValue(v, [k], 0);
  }
  return { vars: out, lint };
}

/** 对单条声明值展开 var()（使用已解析变量表） */
export function expandVarsInValue(value: string, vars: Record<string, string>): string {
  let result = value;
  // 迭代展开，最多 32 轮，处理 fallback 中嵌套的 var
  for (let i = 0; i < 32; i++) {
    const next = result.replace(VAR_RE, (whole, name: string, _group: string | undefined, fallback: string | undefined) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name]!;
      if (fallback !== undefined) return fallback.trim();
      return whole; // 未定义则保留，由 def 阶段的 lint 报告
    });
    if (next === result) break;
    result = next;
  }
  return result;
}
