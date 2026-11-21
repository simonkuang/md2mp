import { zipSync } from "fflate";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import type { LintIssue } from "../types";
import { Errors } from "../cli/errors";
import { parseManifest } from "./manifest";
import { loadTemplateFromBytes } from "./loader";
import { lintTemplateCss } from "./lint";
import { DEFAULT_THEME_B64 } from "./builtin";

const ALLOWED_EXT = new Set([
  "json", "css", "js", "html", "png", "jpg", "jpeg", "gif", "svg", "webp",
  "woff", "woff2", "ttf", "md", "txt",
]);

function collect(dir: string, prefix = ""): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) {
      Object.assign(out, collect(full, rel));
    } else {
      const ext = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
      if (ext && !ALLOWED_EXT.has(ext)) {
        throw Errors.template(
          `模板工程含不允许的文件类型：${rel}`,
          "仅白名单扩展名可进入模板包。",
          `允许：${[...ALLOWED_EXT].join(", ")}。`,
        );
      }
      out[rel] = new Uint8Array(readFileSync(full));
    }
  }
  return out;
}

/** 打包模板工程目录为 ZIP 文件 */
export function packTemplate(inputDir: string, output?: string): { outputPath: string; lint: LintIssue[] } {
  const abs = resolve(inputDir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw Errors.inputMissing(abs);
  }

  const manifestPath = join(abs, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw Errors.template(
      `模板工程缺少 manifest.json：${abs}`,
      "manifest.json 是模板工程的必需文件。",
      "请运行 `md2mp template init <dir>` 生成脚手架。",
    );
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw Errors.template(
      `manifest.json 不是合法 JSON：${manifestPath}`,
      err instanceof Error ? err.message : String(err),
      "请检查 JSON 语法。",
    );
  }
  const { manifest, lint: manifestLint } = parseManifest(rawManifest);

  // 校验 entry.css 存在
  if (!existsSync(join(abs, manifest.entry.css))) {
    throw Errors.template(
      `manifest.entry.css 指向的文件不存在：${manifest.entry.css}`,
      "指定的主题样式文件不在模板工程中。",
      "请创建该文件，或修改 entry.css。",
    );
  }
  // 校验 assets 存在
  for (const a of manifest.assets ?? []) {
    if (!existsSync(join(abs, a.file))) {
      throw Errors.template(
        `资源文件不存在：${a.file}（资源 ${a.name}）`,
        "manifest.assets 声明的路径找不到文件。",
        "请将资源放到对应路径，或从 manifest 中移除该条目。",
      );
    }
  }

  // CSS 兼容性 lint
  const cssText = readFileSync(join(abs, manifest.entry.css), "utf8");
  const cssLint = lintTemplateCss(cssText, manifest);

  // 打包
  const files = collect(abs);
  const zipped = zipSync(files, { level: 6 });

  const outPath = output
    ? resolve(output)
    : resolve(`${basename(abs)}-${manifest.version}.zip`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, zipped);

  return { outputPath: outPath, lint: [...manifestLint, ...cssLint] };
}

/** 内置模板 lint（用于验证 loader 往返） */
export function validateBuiltin(): boolean {
  try {
    const bytes = new Uint8Array(Buffer.from(DEFAULT_THEME_B64, "base64"));
    loadTemplateFromBytes(bytes, "<builtin>");
    return true;
  } catch {
    return false;
  }
}
