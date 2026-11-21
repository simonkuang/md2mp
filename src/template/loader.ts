import { unzipSync, strFromU8 } from "fflate";
import type { Template, LintIssue } from "../types";
import { Md2mpError } from "../cli/errors";
import { parseManifest } from "./manifest";
import { DEFAULT_THEME_B64 } from "./builtin";
import { resolveTemplateRef } from "./registry";

/** 安全上限 */
const MAX_ENTRIES = 500;
const MAX_UNCOMPRESSED = 20 * 1024 * 1024; // 20MB
const MAX_FILE = 5 * 1024 * 1024; // 5MB
const ALLOWED_EXT = new Set([
  "json", "css", "js", "html", "png", "jpg", "jpeg", "gif", "svg", "webp",
  "woff", "woff2", "ttf", "md", "txt",
]);

export interface LoadTemplateResult {
  template: Template;
  lint: LintIssue[];
}

/** base64 → Uint8Array */
function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** 规范化 ZIP 内路径，防 zip-slip */
function safePath(raw: string): string {
  // 反斜杠归一化为正斜杠
  let p = raw.replace(/\\/g, "/");
  // 去掉前导斜杠与盘符
  p = p.replace(/^\/+/, "").replace(/^[A-Za-z]:/, "");
  const segments: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0) segments.pop();
      // 归一后仍是 .. → 跃出根目录，交由调用方拒绝
      continue;
    }
    segments.push(seg);
  }
  return segments.join("/");
}

function extOf(path: string): string {
  const m = path.match(/\.([a-z0-9]+)$/i);
  return m ? m[1]!.toLowerCase() : "";
}

/** 从字节解包 ZIP（内存中，不落盘） */
function unzipSafe(bytes: Uint8Array, sourceLabel: string): Map<string, Uint8Array> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    throw new Md2mpError(
      `模板包不是合法的 ZIP：${sourceLabel}`,
      err instanceof Error ? err.message : String(err),
      "请用 `md2mp template pack` 生成模板包，或检查文件是否损坏。",
      3,
    );
  }

  const names = Object.keys(entries);
  if (names.length > MAX_ENTRIES) {
    throw new Md2mpError(
      `模板包条目数过多（${names.length} > ${MAX_ENTRIES}）：${sourceLabel}`,
      "疑似 zip 炸弹，已拒绝解包。",
      "请清理模板包中的无关文件后重新打包。",
      3,
    );
  }

  let total = 0;
  const files = new Map<string, Uint8Array>();
  for (const rawName of names) {
    const name = safePath(rawName);
    if (!name || name.endsWith("/")) continue; // 目录项

    // zip-slip：原始路径含 .. 视为攻击
    if (rawName.includes("..")) {
      throw new Md2mpError(
        `模板包含危险路径条目：${rawName}`,
        "检测到路径穿越（zip-slip）尝试，已拒绝解包。",
        "请检查模板来源，移除含 `..` 的路径后重新打包。",
        3,
      );
    }

    const data = entries[rawName]!;
    if (data.length > MAX_FILE) {
      throw new Md2mpError(
        `模板包内文件超过 5MB：${name}`,
        "单文件体积上限 5MB。",
        "请压缩或移除大文件后重新打包。",
        3,
      );
    }
    total += data.length;
    if (total > MAX_UNCOMPRESSED) {
      throw new Md2mpError(
        `模板包解压总大小超过 20MB`,
        "疑似 zip 炸弹，已拒绝解包。",
        "请减少模板资源体积。",
        3,
      );
    }

    const ext = extOf(name);
    if (ext && !ALLOWED_EXT.has(ext)) {
      throw new Md2mpError(
        `模板包含不允许的文件类型：${name}（.${ext}）`,
        "仅允许白名单扩展名的文件进入模板包（防可执行文件混入）。",
        `允许：${[...ALLOWED_EXT].join(", ")}。`,
        3,
      );
    }

    files.set(name, data);
  }

  return files;
}

/** 从字节加载模板 */
export function loadTemplateFromBytes(bytes: Uint8Array, sourcePath: string): LoadTemplateResult {
  const files = unzipSafe(bytes, sourcePath);

  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) {
    throw new Md2mpError(
      `模板包缺少 manifest.json：${sourcePath}`,
      "清单文件是模板包的必需入口。",
      "请用 `md2mp template init` 创建工程并放入 manifest.json。",
      3,
    );
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(strFromU8(manifestBytes));
  } catch (err) {
    throw new Md2mpError(
      `manifest.json 不是合法 JSON：${sourcePath}`,
      err instanceof Error ? err.message : String(err),
      "请用 JSON 校验工具检查语法。",
      3,
    );
  }

  const { manifest, lint } = parseManifest(rawManifest);

  // 读取 entry.css
  const cssPath = manifest.entry.css;
  const cssBytes = files.get(cssPath);
  if (!cssBytes) {
    throw new Md2mpError(
      `模板包缺少主题样式文件：${cssPath}`,
      `manifest.entry.css 指向 "${cssPath}"，但 ZIP 中没有该文件。`,
      "请检查 entry.css 路径，或将 CSS 文件打包进去。",
      3,
    );
  }
  const css = strFromU8(cssBytes);

  // 注册资源
  const assets = new Map<string, Uint8Array>();
  for (const a of manifest.assets ?? []) {
    const data = files.get(a.file);
    if (!data) {
      throw new Md2mpError(
        `模板资源文件缺失：${a.file}（资源名 ${a.name}）`,
        "manifest.assets 声明的文件不在 ZIP 中。",
        "请将资源文件放入模板工程并重新 pack。",
        3,
      );
    }
    assets.set(a.name, data);
  }

  return {
    template: { manifest, css, assets, files, sourcePath },
    lint,
  };
}

/**
 * 加载模板：显式路径 > 注册别名 > 保留字 > 默认注册模板 > 内置模板。
 * 注册模板使用本地 ZIP 副本，避免源文件被移动后失效。
 */
export async function loadTemplate(ref?: string): Promise<LoadTemplateResult> {
  const resolved = resolveTemplateRef(ref);
  if (resolved.builtin) {
    return loadTemplateFromBytes(b64ToBytes(DEFAULT_THEME_B64), "<builtin>");
  }
  const path = resolved.sourcePath!;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Md2mpError(
      `模板包不存在：${path}`,
      "模板副本丢失或路径错误。",
      "用 `md2mp template list` 查看注册状态；若副本丢失，请用 `md2mp template remove <别名>` 后重新 add。",
      3,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loaded = loadTemplateFromBytes(bytes, resolved.label);
  // sourcePath 保持纯文件系统路径（预览 watch 使用）
  loaded.template.sourcePath = path;
  return loaded;
}
