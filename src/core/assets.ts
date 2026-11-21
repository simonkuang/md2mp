import type { CheerioAPI } from "cheerio";
import type { ImageMode, ImageStats, LintIssue, Template } from "../types";
import { Md2mpError } from "../cli/errors";

/** 图片管线上下文 */
export interface AssetContext {
  template: Template;
  imageMode: ImageMode;
  /** 文章 md 所在目录（解析本地相对路径） */
  baseDir: string;
  /** upload 模式：上传本地图片字节 → 返回微信图床 URL。由 publish 模块注入 */
  uploader?: (bytes: Uint8Array, filename: string) => Promise<string>;
}

export interface AssetResult {
  stats: ImageStats;
  lint: LintIssue[];
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
};

function extOf(path: string): string {
  const clean = path.split("?")[0]!.split("#")[0]!;
  const m = clean.match(/\.([a-z0-9]+)$/i);
  return m ? m[1]!.toLowerCase() : "";
}

function toDataUrl(bytes: Uint8Array, path: string): string {
  const ext = extOf(path);
  const mime = MIME[ext] ?? "application/octet-stream";
  // 使用 Buffer 做 base64（Bun/Node 兼容），纯 JS 无原生依赖
  const b64 = Buffer.from(bytes).toString("base64");
  return `data:${mime};base64,${b64}`;
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isData(url: string): boolean {
  return /^data:/i.test(url);
}

/**
 * 读取一个图片 src 的字节。返回 null 表示不是本地路径/无法读取。
 * 支持：asset://name、绝对路径、相对 baseDir 的路径。
 */
async function readLocal(src: string, ctx: AssetContext): Promise<{ bytes: Uint8Array; name: string } | null> {
  if (src.startsWith("asset://")) {
    const name = src.slice("asset://".length);
    const def = ctx.template.manifest.assets?.find((a) => a.name === name);
    if (!def) {
      throw new Md2mpError(
        `图片引用了未注册的资源 asset://${name}`,
        "manifest.assets 中没有名为该值的资源条目。",
        `请在 manifest.json 的 assets 中声明 { "name": "${name}", "file": "..." }。`,
      );
    }
    const bytes = ctx.template.assets.get(name);
    if (!bytes) {
      throw new Md2mpError(
        `资源 asset://${name} 在模板包中找不到文件 ${def.file}`,
        "manifest 声明的资源文件缺失于 ZIP。",
        `请检查模板包内是否存在 ${def.file}，并重新 template pack。`,
      );
    }
    return { bytes, name: def.file.split("/").pop() ?? name };
  }

  if (isHttp(src) || isData(src)) return null;

  // 本地路径
  let filePath = src;
  if (!filePath.startsWith("/")) {
    const path = await import("node:path");
    filePath = path.resolve(ctx.baseDir, filePath);
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Md2mpError(
      `找不到本地图片：${src}`,
      "Markdown 引用的图片文件不存在。",
      `请确认 ${filePath} 存在，或改用 link 模式保留外链。`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, name: filePath.split("/").pop() ?? "image" };
}

/**
 * 处理文章中所有 img[src]，按 image-mode 转换。
 */
export async function processImages($: CheerioAPI, ctx: AssetContext): Promise<AssetResult> {
  const stats: ImageStats = { total: 0, uploaded: 0, embedded: 0, linked: 0, failed: 0, degraded: 0 };
  const lint: LintIssue[] = [];
  const imgs = $("img").toArray();

  for (const el of imgs) {
    const $img = $(el);
    const src = $img.attr("src");
    if (!src) continue;
    stats.total++;

    // 已经是微信图床链接：保留
    if (/mmbiz\.qpic\.cn/i.test(src)) {
      stats.linked++;
      continue;
    }

    try {
      const local = await readLocal(src, ctx);

      if (ctx.imageMode === "upload") {
        if (!ctx.uploader) {
          // 无凭据：明确报错（PRD F7 / 技术设计 §7）
          throw new Md2mpError(
            `upload 模式需要公众号凭据，但当前未配置，无法上传图片：${src}`,
            "图片上传依赖 MP_APPID / MP_SECRET 获取 access_token。",
            "请 export MP_APPID=... 与 MP_SECRET=... 后重试，或改用 --image-mode data 内嵌图片（离线可用，但粘贴转存行为需实测）。",
          );
        }
        if (!local) {
          // upload 模式下外链图片：保留原链接并警告
          const https = isHttp(src) ? src.replace(/^http:\/\//i, "https://") : src;
          $img.attr("src", https);
          stats.linked++;
          lint.push({
            ruleId: "MP010",
            level: "warn",
            message: `外链图片在 upload 模式下未上传（仅本地图片上传）：${src}`,
            snippet: src,
          });
          continue;
        }
        const url = await ctx.uploader(local.bytes, local.name);
        $img.attr("src", url);
        stats.uploaded++;
        continue;
      }

      if (ctx.imageMode === "data") {
        if (local) {
          const dataUrl = toDataUrl(local.bytes, local.name);
          $img.attr("src", dataUrl);
          stats.embedded++;
          if (local.bytes.length > 1024 * 1024) {
            lint.push({
              ruleId: "MP011",
              level: "warn",
              message: `单图 data URL 超过 1MB，HTML 体积膨胀：${local.name}`,
              snippet: local.name,
            });
          }
          continue;
        }
        // data 模式下外链：保留（不下载）
        if (isHttp(src)) {
          stats.linked++;
          continue;
        }
        continue;
      }

      // link 模式：仅解析本地相对路径为 file 提示，保留原链接
      if (isHttp(src)) {
        const https = src.replace(/^http:\/\//i, "https://");
        $img.attr("src", https);
        stats.linked++;
        lint.push({
          ruleId: "MP010",
          level: "warn",
          message: `link 模式保留外链图片，公众号编辑器可能不显示：${src}`,
          snippet: src,
        });
      } else if (local) {
        // 本地图片在 link 模式无法引用：保留原 path 并警告
        stats.linked++;
        lint.push({
          ruleId: "MP010",
          level: "warn",
          message: `link 模式下本地图片未内嵌/上传，公众号无法访问：${src}`,
          snippet: src,
        });
      }
    } catch (err) {
      // 图片缺失/上传失败：报错（现象→原因→建议 已在错误中给出）
      stats.failed++;
      if (err instanceof Md2mpError) throw err;
      throw new Md2mpError(
        `图片处理失败：${src}`,
        err instanceof Error ? err.message : String(err),
        "请检查图片路径与格式，或改用 --image-mode data / link。",
      );
    }
  }

  return { stats, lint };
}
