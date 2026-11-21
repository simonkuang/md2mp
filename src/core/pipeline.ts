import * as cheerio from "cheerio";
import type {
  Doc, RenderOptions, RenderResult, LintIssue, Frontmatter,
} from "../types";
import { resolveTitle, resolveDigest } from "./frontmatter";
import { renderMarkdown } from "./markdown";
import { parseThemeCss } from "./css/parse";
import { resolveVariables } from "./css/vars";
import { inlineStyles } from "./css/inline";
import { highlightCodeBlocks } from "./highlight";
import { applyTypography } from "./typography";
import { processImages, type AssetContext } from "./assets";
import { cleanDom, serializeArticle } from "./clean";
import { lintDom, lintContainerClasses } from "../lint/engine";
import { dedupeIssues } from "../template/lint";
import { generatePreviewHtml } from "../preview/page";

/** 渲染管线的可选外部依赖 */
export interface PipelineDeps {
  uploader?: AssetContext["uploader"];
  baseDir?: string;
}

/** 变量占位符替换 */
function replacePlaceholders(
  html: string,
  meta: Frontmatter & { title: string; digest: string },
  template: RenderOptions["template"],
  imageMode: RenderOptions["imageMode"],
): string {
  return html.replace(/\{\{([^}]+)\}\}/g, (whole, raw: string) => {
    const key = raw.trim();
    if (key === "title") return escapeHtml(meta.title ?? "");
    if (key === "author") return escapeHtml(String(meta.author ?? ""));
    if (key === "digest") return escapeHtml(meta.digest ?? "");
      if (key.startsWith("asset:")) {
        const name = key.slice("asset:".length);
        const def = template.manifest.assets?.find((a) => a.name === name);
        const bytes = template.assets.get(name);
        if (!def || !bytes) return whole;
        if (imageMode === "data") {
          // MIME 由实际文件扩展名决定（asset name 可能不带扩展名）
          const mime = def.file.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "png";
          const mimeFull = MIME_EXT[mime] ?? "application/octet-stream";
          return `data:${mimeFull};base64,${Buffer.from(bytes).toString("base64")}`;
        }
        // upload 模式：注入资源无法在渲染阶段上传，保留 asset://（上层可再处理）
        return `asset://${name}`;
      }
      return whole;
    });
  }

  const MIME_EXT: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml",
  };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 执行完整渲染管线（10 步）。纯函数式：不写文件，返回结果对象。
 */
export async function render(
  doc: Doc,
  opts: RenderOptions,
  deps: PipelineDeps = {},
): Promise<RenderResult> {
  const { template, imageMode, variables } = opts;
  const allLint: LintIssue[] = [];

  // 1. frontmatter（已在 doc 中解析）
  const title = resolveTitle(doc.meta, doc.body);
  const digest = resolveDigest(doc.meta, doc.body);
  const meta = { ...doc.meta, title, digest } as Frontmatter & { title: string; digest: string };

  // 2. 解析 CSS（含变量、@规则、伪元素 lint）
  const parsedCss = parseThemeCss(template.css);
  allLint.push(...parsedCss.lint);

  // 变量优先级：theme.css :root < manifest defaults < preset < rc < -V（外部已合并 preset/rc/-V 到 variables）
  const manifestDefaults: Record<string, string> = {};
  for (const v of template.manifest.variables ?? []) {
    if (v.default !== undefined) manifestDefaults[v.key] = v.default;
  }
  const { vars, lint: varLint } = resolveVariables([parsedCss.rootVars, manifestDefaults, variables]);
  allLint.push(...varLint);

  // 3. Markdown 渲染
  const ctx = {
    markdown: template.manifest.markdown,
    typography: template.manifest.typography,
  };
  let bodyHtml = renderMarkdown(doc.body, ctx);

  // 4. DOM 解析 + 根节点包裹 + inject 注入
  const injectHead = template.manifest.inject?.articleHead
    ? replacePlaceholders(template.manifest.inject.articleHead, meta, template, imageMode)
    : "";
  const injectFoot = template.manifest.inject?.articleFoot
    ? replacePlaceholders(template.manifest.inject.articleFoot, meta, template, imageMode)
    : "";
  const fullHtml = `<section id="js_article">${injectHead}${bodyHtml}${injectFoot}</section>`;
  const $ = cheerio.load(fullHtml);

  // 5. 图片处理
  const imageResult = await processImages($, {
    template,
    imageMode,
    baseDir: deps.baseDir ?? process.cwd(),
    uploader: deps.uploader,
  });
  allLint.push(...imageResult.lint);

  // 6. 代码高亮
  const hl = highlightCodeBlocks($, template.manifest.highlight?.enable ?? true);
  allLint.push(...hl.lint);

  // 7. 排版增强
  applyTypography($, template.manifest.typography ?? {}, meta);

  // 8. CSS 内联化（返回值收集 MP044：值中残留未定义 var()）
  allLint.push(...inlineStyles($, parsedCss.rules, vars));

  // 结构类样式检查（清洗前执行，class 仍在 DOM 上）：MP045
  allLint.push(...lintContainerClasses($, parsedCss.rules));

  // 9. 白名单清洗（剥 class/id；根节点 id 保留到序列化后再剥）
  const cleanResult = cleanDom($, true);
  allLint.push(...cleanResult.lint);

  // DOM 层 lint（清洗后仍可查 img/a/style 残留）
  allLint.push(...lintDom($));

  // 10. 输出组装
  const articleHtml = serializeArticle($);
  const lint = dedupeIssues(allLint);
  const previewHtml = generatePreviewHtml({
    articleHtml,
    lint,
    meta,
    imageStats: imageResult.stats,
    variables: vars,
    presetName: opts.presetName,
    templateName: template.manifest.name,
    imageMode,
  });

  return { articleHtml, previewHtml, lint, meta, imageStats: imageResult.stats };
}
