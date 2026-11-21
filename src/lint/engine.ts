import type { CheerioAPI } from "cheerio";
import type { LintIssue } from "../types";

/** 规则元信息（供 template lint 与 build 面板展示） */
export const RULE_CATALOG: Record<string, { level: "error" | "warn"; title: string }> = {
  MP001: { level: "error", title: "<script> 标签" },
  MP002: { level: "error", title: "<style> 标签" },
  MP003: { level: "error", title: "manifest 校验失败" },
  MP004: { level: "warn", title: "class/id 属性残留" },
  MP010: { level: "warn", title: "外链图片" },
  MP011: { level: "warn", title: "data URL 单图过大" },
  MP012: { level: "warn", title: "SVG 资源/内联 SVG" },
  MP020: { level: "warn", title: "外部链接" },
  MP030: { level: "warn", title: "图片尺寸过大" },
  MP040: { level: "error", title: "CSS 伪元素" },
  MP041: { level: "error", title: "@media 查询" },
  MP042: { level: "error", title: "@font-face 外部字体" },
  MP043: { level: "warn", title: "交互伪类" },
  MP044: { level: "error", title: "未定义变量 var()" },
  MP045: { level: "warn", title: "未声明的 container 类名" },
  MP046: { level: "warn", title: "代码高亮失败" },
  MP050: { level: "error", title: "position:fixed/sticky" },
  MP060: { level: "warn", title: "表格无边框声明" },
};

/**
 * 对最终文章 DOM 执行 lint（HTML 层面的规则）。
 * CSS/manifest 层规则在解析阶段已收集，这里只做 DOM 相关检查。
 */
export function lintDom($: CheerioAPI): LintIssue[] {
  const issues: LintIssue[] = [];

  // MP001 / MP002
  const scriptCount = $("script").length;
  const styleCount = $("style").length;
  if (scriptCount > 0) {
    issues.push({ ruleId: "MP001", level: "error", message: `正文含 ${scriptCount} 个 <script> 标签，公众号将剥离` });
  }
  if (styleCount > 0) {
    issues.push({ ruleId: "MP002", level: "error", message: `正文含 ${styleCount} 个 <style> 标签，公众号将剥离` });
  }

  // class/id 残留（理论上被清洗，兜底检查；根节点 #js_article 的 id 属正常，排除）
  const withClass = $("[class]").length;
  const withId = $("[id]").not("#js_article").length;
  if (withClass > 0) {
    issues.push({ ruleId: "MP004", level: "warn", message: `正文中仍有 ${withClass} 个元素带 class 属性（将被公众号剥离）` });
  }
  if (withId > 0) {
    issues.push({ ruleId: "MP004", level: "warn", message: `正文中仍有 ${withId} 个元素带 id 属性（将被公众号剥离）` });
  }

  // MP012 / MP011 / MP030：图片
  $("img").each((_i, el) => {
    const src = $(el).attr("src") ?? "";
    if (src.startsWith("data:image/svg+xml")) {
      issues.push({ ruleId: "MP012", level: "warn", message: "正文含内联 SVG 图片，公众号渲染不稳定" });
    }
    if (src.startsWith("data:") && src.length > 1024 * 1024) {
      issues.push({ ruleId: "MP011", level: "warn", message: "单张 data URL 图片超过 1MB，HTML 体积膨胀" });
    }
    if (src.startsWith("data:") && src.length > 3 * 1024 * 1024) {
      issues.push({ ruleId: "MP030", level: "warn", message: "图片 data URL 超过 3MB，粘贴可能失败" });
    }
    const width = $(el).attr("width");
    if (width && Number(width) > 1080) {
      issues.push({ ruleId: "MP030", level: "warn", message: `图片宽度 ${width}px 超过 1080px` });
    }
  });

  // MP020：外部链接（mp.weixin.qq.com 为站内，需按主机边界匹配，:// 之后的域名也算站内）
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    if (/^https?:\/\//i.test(href) && !/(^|\/\/|\.)mp\.weixin\.qq\.com(\/|$)/i.test(href)) {
      issues.push({ ruleId: "MP020", level: "warn", message: `外部链接可能被公众号过滤：${href.slice(0, 80)}`, snippet: href });
    }
  });

  // MP050 / MP060：从内联 style 中检查
  $("[style]").each((_i, el) => {
    const style = $(el).attr("style") ?? "";
    if (/(^|;)\s*position\s*:\s*(fixed|sticky)/i.test(style)) {
      issues.push({ ruleId: "MP050", level: "error", message: "内联样式含 position:fixed/sticky，公众号不生效" });
    }
  });

  // MP060：表格无边框声明
  $("table").each((_i, el) => {
    const $t = $(el);
    const thBorder = $t.find("th").first().attr("style");
    const tdBorder = $t.find("td").first().attr("style");
    const hasBorder = (s?: string) => !!s && /border\s*:/.test(s);
    if (!hasBorder(thBorder) && !hasBorder(tdBorder)) {
      issues.push({ ruleId: "MP060", level: "warn", message: "表格缺少边框声明，在公众号编辑器中可能不可读" });
    }
  });

  return issues;
}

/**
 * MP045：检查 DOM 中实际使用的 mp-* 结构类（容器/编号/分割线等管线产物）
 * 是否在主题 CSS 中有对应样式规则。必须在白名单清洗（剥 class）之前调用。
 */
export function lintContainerClasses($: CheerioAPI, rules: Array<{ selector: string }>): LintIssue[] {
  const used = new Set<string>();
  $("[class]").each((_i, el) => {
    const cls = $(el).attr("class") ?? "";
    for (const c of cls.split(/\s+/)) {
      if (c.startsWith("mp-")) used.add(c);
    }
  });

  const issues: LintIssue[] = [];
  for (const c of used) {
    // 选择器中出现 .类名（负向断言避免 .mp-h-num 匹配到 .mp-h-num-x）
    const re = new RegExp(`\\.${c}(?![\\w-])`);
    const styled = rules.some((r) => re.test(r.selector));
    if (!styled) {
      issues.push({
        ruleId: "MP045",
        level: "warn",
        message: `结构类 .${c} 被使用，但主题 CSS 中没有对应样式规则（容器/编号/分割线等将无样式）`,
        snippet: `.${c}`,
      });
    }
  }
  return issues;
}

/** 将 lint 结果格式化为文本 */
export function formatLintText(issues: LintIssue[]): string {
  if (issues.length === 0) return "✓ 未发现兼容性问题";
  const lines = issues.map((i) => `  [${i.ruleId}] ${i.level === "error" ? "✖" : "⚠"} ${i.message}`);
  const errors = issues.filter((i) => i.level === "error").length;
  const warns = issues.length - errors;
  return `发现 ${issues.length} 项（${errors} 错误 / ${warns} 警告）：\n${lines.join("\n")}`;
}
