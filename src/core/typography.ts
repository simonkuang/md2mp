import type { CheerioAPI } from "cheerio";
import type { AnyNode, Element as DomElement, Text as TextNode } from "domhandler";
import type { Frontmatter, TypographyConfig } from "../types";

/** 数字 → 中文序号（1→一, 11→十一, 21→二十一, 100→一百） */
export function numberToChinese(n: number): string {
  const digits = "零一二三四五六七八九";
  if (n <= 0) return digits[0]!;
  if (n < 10) return digits[n]!;
  if (n < 20) return "十" + (n % 10 ? digits[n % 10]! : "");
  if (n < 100) {
    return digits[Math.floor(n / 10)]! + "十" + (n % 10 ? digits[n % 10]! : "");
  }
  // 100+：按位展开（够用即可）
  const units = ["", "十", "百", "千"];
  const str = String(n);
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const d = Number(str[i]);
    const u = units[str.length - i - 1]!;
    if (d === 0) {
      if (out && !out.endsWith("零")) out += "零";
    } else {
      out = out.replace(/零+$/, "") + digits[d]! + u;
    }
  }
  return out.replace(/零+$/, "");
}

/** 中英文之间加空格（保护代码块、行内代码、已有空格） */
export function autoChineseSpacing(text: string): string {
  const CJK = "\\u4e00-\\u9fff\\u3400-\\u4dbf";
  // 中文后紧跟英文/数字 → 加空格；英文/数字后紧跟中文 → 加空格
  return text
    .replace(new RegExp(`([${CJK}])([A-Za-z0-9])`, "g"), "$1 $2")
    .replace(new RegExp(`([A-Za-z0-9])([${CJK}])`, "g"), "$1 $2");
}

/** 判断文本节点是否在 code/pre 内 */
function inCode(node: AnyNode): boolean {
  let parent = node.parent;
  while (parent && parent.type === "tag") {
    if (parent.name === "code" || parent.name === "pre" || parent.name === "script" || parent.name === "style") return true;
    parent = parent.parent;
  }
  return false;
}

export interface TypographyResult {
  numbered: number;
  hrConverted: number;
  captions: number;
  zebraRows: number;
  tasksConverted: number;
  spacedNodes: number;
}

/** 执行全部 DOM 层排版增强（必须在 CSS 内联之前） */
export function applyTypography(
  $: CheerioAPI,
  cfg: TypographyConfig,
  meta: Frontmatter,
): TypographyResult {
  const result: TypographyResult = {
    numbered: 0, hrConverted: 0, captions: 0, zebraRows: 0, tasksConverted: 0, spacedNodes: 0,
  };

  // 1. 章节自动编号（h2→一、 h3→（一） h4→1. ）
  if (cfg.headingNumbering && meta.numbering !== false) {
    let h2 = 0, h3 = 0, h4 = 0;
    $("h1, h2, h3, h4").each((_i, el) => {
      const $h = $(el);
      const tag = (el as DomElement).name;
      let prefix = "";
      if (tag === "h2") {
        h2++; h3 = 0; h4 = 0;
        prefix = `${numberToChinese(h2)}、`;
      } else if (tag === "h3") {
        h3++; h4 = 0;
        prefix = `（${numberToChinese(h3)}）`;
      } else if (tag === "h4") {
        h4++;
        prefix = `${h4}. `;
      } else {
        return; // h1 不编号
      }
      $h.prepend(`<span class="mp-h-num">${prefix}</span>`);
      result.numbered++;
    });
  }

  // 2. 分割线形态
  const hrMode = cfg.hr ?? "plain";
  if (hrMode === "none") {
    $("hr").remove();
  } else if (hrMode === "diamond") {
    $("hr").each((_i, el) => {
      $(el).replaceWith(
        '<div class="mp-hr"><span class="mp-hr-line"></span><span class="mp-hr-dot"></span><span class="mp-hr-line"></span></div>',
      );
      result.hrConverted++;
    });
  }

  // 3. 任务列表字形：自定义插件生成 <input data-checked=true|false>
  if (cfg.taskListGlyph) {
    $("input.task-list-item-checkbox").each((_i, el) => {
      const $input = $(el);
      const checked = $input.attr("data-checked") === "true";
      const glyph = checked ? "☑" : "☐";
      const $li = $input.closest("li");
      $li.addClass("mp-task-item").prepend(`<span class="mp-task-box">${glyph}</span>`);
      $input.remove();
      result.tasksConverted++;
    });
  }

  // 4. 表格斑马纹：偶数行加 mp-alt 类（规避 :nth-child）；按表格逐个计数，与参考原型一致
  if (cfg.tableZebra) {
    $("table").each((_ti, table) => {
      $(table).find("tr").each((i, el) => {
        if (i % 2 === 1) {
          $(el).addClass("mp-alt");
          result.zebraRows++;
        }
      });
    });
  }

  // 5. 单图段落 → figure.mp-photo；紧随「图：」段落 → figcaption
  if (cfg.figureCaption) {
    $("p").each((_i, el) => {
      const $p = $(el);
      // 段落内仅一个 img（且有且仅有它）
      const imgs = $p.find("img");
      if (imgs.length === 1 && $p.text().trim() === "" ) {
        const $figure = $("<figure class=\"mp-photo\"></figure>");
        imgs.first().appendTo($figure);
        $p.replaceWith($figure);
        // 查找紧随的兄弟段落是否为题注
        let next = $figure.next();
        if (next.length && next.is("p")) {
          const txt = next.text().trim();
          if (/^图[:：]/.test(txt)) {
            const $cap = $("<figcaption></figcaption>").text(txt.replace(/^图[:：]\s*/, ""));
            next.replaceWith($cap);
            $figure.append($cap);
            result.captions++;
          }
        }
      }
    });
  }

  // 6. 代码块前导空格保护：将 pre>code 文本中的前导空格转为 &nbsp;
  if (cfg.codeIndentPreserve) {
    $("pre code").each((_i, el) => {
      const $code = $(el);
      // 高亮后 code 内是 span 树，直接处理整个 code 的 html 中每行前导空格
      let html = $code.html() ?? "";
      html = html.replace(/(^|\n)([ \t]+)/g, (_m, lead: string, spaces: string) => {
        return lead + spaces.replace(/ /g, "&nbsp;").replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;");
      });
      $code.html(html);
    });
  }

  // 7. 中英文自动加空格（文本节点级，跳过 code/pre/script/style）
  if (cfg.autoSpacing) {
    const textNodes: TextNode[] = [];
    $("#js_article").find("*").each((_i, el) => {
      const node = $(el).get(0);
      if (!node) return;
      for (const child of node.childNodes) {
        if (child.type === "text" && !inCode(child)) {
          textNodes.push(child as TextNode);
        }
      }
    });
    for (const node of textNodes) {
      const raw = node.data ?? "";
      if (!raw.trim()) continue;
      const spaced = autoChineseSpacing(raw);
      if (spaced !== raw) {
        node.data = spaced;
        result.spacedNodes++;
      }
    }
  }

  return result;
}
