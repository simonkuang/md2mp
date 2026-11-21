import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import type { CheerioAPI } from "cheerio";
import type { LintIssue } from "../types";

/** 固定语言注册顺序，保证确定性 */
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  javascript, js: javascript, typescript, ts: typescript,
  python, py: python, bash, sh: bash, shell: bash,
  json, xml, html: xml, css, sql, go, rust, java, c, cpp, "c++": cpp,
  markdown, md: markdown, yaml, yml: yaml,
};

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  for (const [name, fn] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, fn);
  }
  registered = true;
}

export interface HighlightResult {
  highlighted: number;
  failed: number;
  lint: LintIssue[];
}

/**
 * 对 pre>code 执行高亮，生成带 hljs-* class 的 span 树。
 * 高亮失败降级为纯文本并给出 lint 警告。
 */
export function highlightCodeBlocks($: CheerioAPI, enable: boolean): HighlightResult {
  const result: HighlightResult = { highlighted: 0, failed: 0, lint: [] };
  if (!enable) return result;
  ensureRegistered();

  $("pre code").each((_i, el) => {
    const $code = $(el);
    let lang = "";
    // markdown-it 输出：<code class="language-js">
    const cls = $code.attr("class") || "";
    const m = cls.match(/language-([\w+-]+)/);
    if (m) lang = m[1]!.toLowerCase();

    const text = $code.text();
    if (!text) return;

    if (!lang || !hljs.getLanguage(lang)) {
      // 未指定语言或不支持：保留纯文本，不算失败
      return;
    }

    try {
      const out = hljs.highlight(text, { language: lang, ignoreIllegals: true });
      $code.html(out.value);
      result.highlighted++;
    } catch (err) {
      result.failed++;
      result.lint.push({
        ruleId: "MP046",
        level: "warn",
        message: `代码高亮失败，已降级为纯文本：语言 ${lang}`,
        snippet: text.slice(0, 40),
      });
    }
  });

  return result;
}
