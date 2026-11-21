import matter from "gray-matter";
import type { Doc, Frontmatter } from "../types";
import { Md2mpError } from "../cli/errors";

/** 将任意长度文本截取为摘要（按码点，去空白） */
export function makeDigest(text: string, max = 54): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length <= max ? clean : chars.slice(0, max).join("") + "…";
}

/** 从 markdown 正文中提取首个 h1 文本（简单正则，供 title 兜底） */
export function extractFirstHeading(body: string): string | undefined {
  const m = body.match(/^\s*#\s+(.+?)\s*#*\s*$/m);
  if (!m) return undefined;
  return m[1]!.replace(/[*_`\[\]()]/g, "").trim() || undefined;
}

/**
 * 解析 Markdown 文本为 Doc。YAML 语法错误给出行号。
 */
export function parseFrontmatter(raw: string, sourcePath?: string): Doc {
  try {
    const parsed = matter(raw, {
      // 保留 body 的原始行号不重要，只需要内容
    });
    const meta: Frontmatter = (parsed.data ?? {}) as Frontmatter;
    return { body: parsed.content, meta, sourcePath };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Md2mpError(
      `Markdown frontmatter 解析失败：${msg}`,
      "YAML 语法错误，通常因缩进、冒号后缺少空格或引号未闭合导致。",
      `请检查 ${sourcePath ?? "输入文件"} 顶部 --- 之间的 YAML；行号见上方错误详情。`,
    );
  }
}

/** 计算最终 title：frontmatter.title → 首个 h1 → '未命名文章' */
export function resolveTitle(meta: Frontmatter, body: string): string {
  if (typeof meta.title === "string" && meta.title.trim()) return meta.title.trim();
  const h = extractFirstHeading(body);
  if (h) return h;
  return "未命名文章";
}

/** 计算最终 digest：frontmatter.digest → 正文前 54 字 */
export function resolveDigest(meta: Frontmatter, body: string): string {
  if (typeof meta.digest === "string" && meta.digest.trim()) return meta.digest.trim();
  // 去掉标题行与 markdown 标记后的纯文本
  const plain = body
    .replace(/^\s*#\s+.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#|]/g, "")
    .trim();
  return makeDigest(plain, 54);
}
