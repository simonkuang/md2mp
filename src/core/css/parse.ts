import postcss from "postcss";
import { parse as parseSelector } from "css-what";
import type { LintIssue } from "../../types";

/** 一条声明 */
export interface Declaration {
  prop: string;
  value: string;
  important: boolean;
  /** 源码行号 */
  line: number;
}

/** specificity：(id, class/attr/pseudo-class, type/pseudo-element) */
export type Specificity = [number, number, number];

/** 一条 CSS 规则 */
export interface CssRule {
  selector: string;
  decls: Declaration[];
  specificity: Specificity;
  sourceOrder: number;
  line: number;
}

export interface ParsedCss {
  /** 参与内联的规则（已排除 :root、@ 规则、伪元素规则） */
  rules: CssRule[];
  /** :root { --x: y } 中的变量声明 */
  rootVars: Record<string, string>;
  /** 解析过程中发现的 lint 命中 */
  lint: LintIssue[];
}

/** 忽略的 at-rule → lint 规则映射 */
const AT_RULE_LINT: Record<string, { ruleId: string; level: "error" | "warn"; message: string }> = {
  media: { ruleId: "MP041", level: "error", message: "@media 查询在公众号编辑器无效（MP041）" },
  "font-face": { ruleId: "MP042", level: "error", message: "@font-face 外部字体在公众号编辑器无效（MP042）" },
  keyframes: { ruleId: "MP040", level: "warn", message: "@keyframes 动画在公众号编辑器无效" },
  import: { ruleId: "MP042", level: "warn", message: "@import 在公众号编辑器无效" },
  supports: { ruleId: "MP041", level: "warn", message: "@supports 在公众号编辑器无效" },
};

const INTERACTIVE_PSEUDO = new Set(["hover", "focus", "active", "visited", "link", "focus-within", "focus-visible"]);

/**
 * 计算选择器 specificity。基于 css-what 的 AST。
 * :not()/:is()/:where() 的参数以其内部最高优先级参与（此处简化为递归取内部最大值；:where 贡献 0）。
 */
export function calcSpecificity(selector: string): Specificity {
  let ast: ReturnType<typeof parseSelector>;
  try {
    ast = parseSelector(selector);
  } catch {
    return [0, 0, 0];
  }
  const scan = (parts: ReturnType<typeof parseSelector>): Specificity => {
    let a = 0, b = 0, c = 0;
    for (const group of parts) {
      for (const token of group) {
        switch (token.type) {
          case "attribute":
            if (token.name === "id" && token.action === "equals") a++;
            else if (token.name === "class" && token.action === "element") b++;
            else b++;
            break;
          case "pseudo": {
            const name = token.name.replace(/^:/, "");
            if (["not", "is", "where", "has", "matches"].includes(name)) {
              if (name === "where") break; // :where 贡献 0
              let data = token.data;
              if (Array.isArray(data)) {
                // css-what 对 :is() 等返回的 data 可能是数组 [selectors[]] 或扁平
                const nested = (data as unknown[]).flat(Infinity);
                const sub = scan(nested as ReturnType<typeof parseSelector>);
                a = Math.max(a, sub[0]); b = Math.max(b, sub[1]); c = Math.max(c, sub[2]);
              }
            } else if (name === "nth-child" || name === "nth-of-type" || name === "first-child" ||
              name === "last-child" || name === "only-child" || name === "empty" ||
              name === "root" || name === "first-of-type" || name === "last-of-type" || name === "checked") {
              b++;
            }
            break;
          }
          case "pseudo-element":
            c++;
            break;
          case "tag":
            if (token.name !== "*") c++;
            break;
          // descendant/child/adjacent/sibling 不贡献
        }
      }
    }
    return [a, b, c];
  };
  return scan(ast);
}

function specificityCmp(x: Specificity, y: Specificity): number {
  for (let i = 0; i < 3; i++) {
    if (x[i]! !== y[i]!) return x[i]! - y[i]!;
  }
  return 0;
}

/** 选择器是否含伪元素（公众号不生效，需降级/丢弃） */
export function hasPseudoElement(selector: string): boolean {
  try {
    return parseSelector(selector).some((group) => group.some((t) => t.type === "pseudo-element"));
  } catch {
    return false;
  }
}

/** 选择器是否含交互伪类 */
export function hasInteractivePseudo(selector: string): boolean {
  try {
    return parseSelector(selector).some((group) =>
      group.some((t) => t.type === "pseudo" && INTERACTIVE_PSEUDO.has(t.name.replace(/^:/, ""))),
    );
  } catch {
    return false;
  }
}

/** 解析 theme.css 文本 */
export function parseThemeCss(cssText: string): ParsedCss {
  const lint: LintIssue[] = [];
  let root: postcss.Root;
  try {
    root = postcss.parse(cssText, { from: undefined });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const lineMatch = msg.match(/:(\d+):/);
    throw new Error(`theme.css 解析失败（第 ${lineMatch?.[1] ?? "?"} 行）：${msg}`);
  }

  const rules: CssRule[] = [];
  const rootVars: Record<string, string> = {};
  let order = 0;

  root.walk((node) => {
    const line = node.source?.start?.line ?? 0;
    // 跳过 at-rule 内部的规则（@media 等已整体丢弃）
    let p: postcss.Container | undefined = node.parent as postcss.Container | undefined;
    while (p) {
      if (p.type === "atrule") return;
      p = (p as postcss.Container).parent as postcss.Container | undefined;
    }
    if (node.type === "atrule") {
      const name = (node as postcss.AtRule).name.toLowerCase();
      const hit = AT_RULE_LINT[name];
      if (hit) {
        lint.push({ ruleId: hit.ruleId, level: hit.level, message: `${hit.message}（第 ${line} 行）`, line });
      }
      // @ 规则整体丢弃，不参与内联
      return;
    }
    if (node.type !== "rule") return;
    const rule = node as postcss.Rule;
    const selectorText = rule.selector.trim();

    // :root 变量声明
    if (/(^|,)\s*:root\s*(,|$)/.test(selectorText)) {
      for (const d of rule.nodes) {
        if (d.type === "decl" && d.prop.startsWith("--")) {
          rootVars[d.prop.trim()] = d.value.trim();
        }
      }
      return;
    }

    const decls: Declaration[] = [];
    for (const d of rule.nodes) {
      if (d.type !== "decl") continue;
      decls.push({
        prop: d.prop.trim(),
        value: d.value.trim(),
        important: d.important === true,
        line: d.source?.start?.line ?? line,
      });
    }
    if (decls.length === 0) return;

    // 拆分逗号分隔的多选择器，逐个处理以获得准确 specificity
    const selectors = postcss.list.comma(selectorText).map((s) => s.trim()).filter(Boolean);
    for (const selector of selectors) {
      // 伪元素规则丢弃 + lint
      if (hasPseudoElement(selector)) {
        lint.push({
          ruleId: "MP040",
          level: "error",
          message: `CSS 伪元素在公众号编辑器不生效，已忽略该规则：${selector}（第 ${line} 行）`,
          line,
          snippet: selector,
        });
        continue;
      }

      // 交互伪类规则丢弃 + lint
      if (hasInteractivePseudo(selector)) {
        lint.push({
          ruleId: "MP043",
          level: "warn",
          message: `交互伪类在公众号编辑器无意义，已忽略该规则：${selector}（第 ${line} 行）`,
          line,
          snippet: selector,
        });
        continue;
      }

      rules.push({
        selector,
        decls,
        specificity: calcSpecificity(selector),
        sourceOrder: order++,
        line,
      });
    }
  });

  // 稳定排序：specificity 升序，sourceOrder 升序
  rules.sort((x, y) => {
    const s = specificityCmp(x.specificity, y.specificity);
    return s !== 0 ? s : x.sourceOrder - y.sourceOrder;
  });

  return { rules, rootVars, lint };
}
