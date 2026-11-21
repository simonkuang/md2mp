import type { CheerioAPI, Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";
import type { LintIssue } from "../../types";
import type { CssRule, Declaration } from "./parse";
import { mergeDeclarations, parseInlineStyle, serializeStyle } from "./cascade";

/** 需要在根节点上强制设置、保证公众号可复制的基线样式 */
const BASE_STYLES: Record<string, string> = {
  "box-sizing": "border-box",
};

export interface InlineOptions {
  /** 根节点选择器（选择器规则都挂在其下） */
  rootSelector?: string;
}

/**
 * CSS 内联化主入口。
 * 规则已按 specificity + 源码顺序排序；对每个元素：收集匹配声明 → 合并（原有 inline 最低优先级）→ 写 style。
 * 完全确定性：遍历顺序、声明顺序、排序都是稳定的。
 * 返回 lint：值中 var() 展开后仍未定义的残留（MP044）。
 */
export function inlineStyles(
  $: CheerioAPI,
  rules: CssRule[],
  vars: Record<string, string>,
  opts: InlineOptions = {},
): LintIssue[] {
  const lint: LintIssue[] = [];
  const reportedVars = new Set<string>();
  const rootSel = opts.rootSelector ?? "#js_article";
  const root = $(rootSel);
  if (root.length === 0) return lint;

  // 收集所有元素：根节点 + 后代。按文档顺序。
  const elements: Cheerio<AnyNode>[] = [root];
  root.find("*").each((_i, el) => { elements.push($(el)); });

  for (const $el of elements) {
    const el = $el.get(0);
    if (!el) continue;
    if (el.type !== "tag" && el.type !== "script" && el.type !== "style") continue;

    // 原有 inline style 作为最低优先级
    const decls: Declaration[] = parseInlineStyle($el.attr("style"));

    // 根节点补充基线样式（最低优先级，位于规则之前）
    if ($el.is(rootSel)) {
      for (const [prop, value] of Object.entries(BASE_STYLES)) {
        decls.push({ prop, value, important: false, line: 0 });
      }
    }

    // 收集匹配的规则声明（已按优先级排序，顺序即级联顺序）
    for (const rule of rules) {
      if (matchesSelector($el, rule.selector)) {
        for (const d of rule.decls) decls.push(d);
      }
    }

    const merged = mergeDeclarations(decls, vars);
    const style = serializeStyle(merged);
    // var() 展开后仍残留 → 变量未定义（MP044）
    for (const m of style.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = m[1]!;
      if (!reportedVars.has(name)) {
        reportedVars.add(name);
        lint.push({
          ruleId: "MP044",
          level: "error",
          message: `样式值引用了未定义变量 var(${name})，输出将保留原样`,
          snippet: `var(${name})`,
        });
      }
    }
    if (style) {
      $el.attr("style", style);
    } else {
      $el.removeAttr("style");
    }
  }
  return lint;
}

/**
 * 判断元素是否匹配选择器（css-select 在完整 DOM 树中判定祖先关系）。
 */
function matchesSelector($el: Cheerio<AnyNode>, selector: string): boolean {
  try {
    return $el.is(selector);
  } catch {
    return false;
  }
}
