import type { CheerioAPI } from "cheerio";
import { Md2mpError } from "../cli/errors";
import type { LintIssue } from "../types";

/** 清洗结果 */
export interface CleanResult {
  lint: LintIssue[];
}

/**
 * 白名单清洗：
 * - 剥除 class / id（根节点 id 保留到序列化前一刻由调用方决定）
 * - 移除注释节点
 * - 移除 script/style 标签（正文绝不允许；触达即内部错误或 lint）
 * - 移除空属性
 * - 规范化 <br> 等
 */
export function cleanDom($: CheerioAPI, keepRootId = false): CleanResult {
  const lint: LintIssue[] = [];

  // script / style：正文绝不允许
  const scripts = $("script").length;
  const styles = $("style").length;
  if (scripts > 0) {
    lint.push({ ruleId: "MP001", level: "error", message: `正文中发现 ${scripts} 个 <script> 标签，已移除` });
    $("script").remove();
  }
  if (styles > 0) {
    lint.push({ ruleId: "MP002", level: "error", message: `正文中发现 ${styles} 个 <style> 标签，已移除` });
    $("style").remove();
  }

  // 注释节点
  $("*").contents().each((_i, node) => {
    if (node.type === "comment") {
      $(node).remove();
    }
  });

  // 剥 class / id（根节点 #js_article 的 id 视参数保留）
  $("*").each((_i, el) => {
    const $el = $(el);
    const node = $el.get(0);
    if (!node) return;
    $el.removeAttr("class");
    if (keepRootId && $el.is("#js_article")) {
      $el.attr("id", "js_article");
    } else {
      $el.removeAttr("id");
    }
    // 移除空 style
    const style = $el.attr("style");
    if (style !== undefined && style.trim() === "") $el.removeAttr("style");
  });

  return { lint };
}

/** 序列化为文章片段 HTML（不含 html/head/body 包装） */
export function serializeArticle($: CheerioAPI): string {
  const root = $("#js_article");
  if (root.length === 0) {
    throw new Md2mpError(
      "渲染结果缺少根节点 #js_article",
      "内部序列化错误，文章根节点意外丢失。",
      "请检查 markdown 渲染与 DOM 解析步骤。",
    );
  }
  // 序列化前剥除根节点 id（公众号会剥离，且避免 id 残留）
  root.removeAttr("id");
  return $.html(root);
}
