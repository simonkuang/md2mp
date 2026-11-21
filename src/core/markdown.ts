import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import container from "markdown-it-container";
import type { MarkdownConfig, TypographyConfig } from "../types";

export interface MarkdownRenderOptions {
  markdown?: MarkdownConfig;
  typography?: TypographyConfig;
}

/**
 * 确定性的任务列表插件：把 - [x] / - [ ] 的 inline 开头 token 转成自定义 input。
 * 不使用 markdown-it-task-lists（它生成随机 id，破坏确定性且产生畸形 HTML）。
 * 输出：<input class="task-list-item-checkbox" data-checked="true|false" type="checkbox">
 * DOM 后处理阶段据此转 ☑/☐ 字形。
 */
function deterministicTaskLists(md: MarkdownIt): void {
  md.core.ruler.push("md2mp_task_list", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type !== "inline" || !t.children) continue;
      // 仅处理列表项内的 inline（前一个是 paragraph_open 且再前是 list_item_open）
      const first = t.children[0];
      if (!first || first.type !== "text") continue;
      const m = first.content.match(/^(\s*)\[([ xX])\](\s?)/);
      if (!m) continue;
      const checked = m[2]!.toLowerCase() === "x" ? "true" : "false";
      const inputToken = new state.Token("html_inline", "", 0);
      inputToken.content = `<input class="task-list-item-checkbox" data-checked="${checked}" type="checkbox">`;
      // 去掉 [x] 部分，保留后续文本
      first.content = m[3]! ? first.content.slice(m[0]!.length - m[3]!.length) : first.content.slice(m[0]!.length);
      // 给父 li 加类
      for (let j = i - 1; j >= 0; j--) {
        if (tokens[j]!.type === "list_item_open") {
          tokens[j]!.attrJoin("class", "task-list-item");
          break;
        }
      }
      t.children.unshift(inputToken);
    }
    return true;
  });
}

/**
 * 创建 markdown-it 实例。
 */
export function createMarkdownIt(opts: MarkdownRenderOptions = {}): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    breaks: opts.markdown?.breaks ?? false,
  });

  md.use(footnote);
  md.use(deterministicTaskLists);

  // 删除线统一渲染为 <del>（模板 CSS 使用 del 选择器；markdown-it 默认输出 <s>）
  md.renderer.rules.s_open = () => "<del>";
  md.renderer.rules.s_close = () => "</del>";

  // container：:::tip / :::warning 等 → <section class="mp-tip">
  const names = ["tip", "warning", "info", "note", "danger", "success", "quote"];
  for (const name of names) {
    md.use(container, name, {
      validate: (params: string) => params.trim() === name,
      render: (tokens: { type: string; nesting: number }[], idx: number) => {
        const t = tokens[idx]!;
        const className = `mp-${name}`;
        if (t.nesting === 1) {
          const label = name.charAt(0).toUpperCase() + name.slice(1);
          return `<section class="${className}"><p class="mp-container-label">${label}</p>\n`;
        }
        return "</section>\n";
      },
    });
  }

  return md;
}

export function renderMarkdown(body: string, opts: MarkdownRenderOptions = {}): string {
  return createMarkdownIt(opts).render(body);
}
