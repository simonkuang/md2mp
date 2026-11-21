import { z } from "zod";
import type { Manifest, LintIssue } from "../types";
import { Md2mpError } from "../cli/errors";

const VariableSchema = z.object({
  key: z.string().regex(/^--[\w-]+$/, "变量 key 必须以 -- 开头"),
  label: z.string().optional(),
  type: z.enum(["color", "length", "text", "enum"]),
  default: z.string().optional(),
  options: z.array(z.string()).optional(),
}).refine(
  (v) => v.type !== "enum" || (v.options && v.options.length > 0),
  { message: "enum 类型变量必须提供 options" },
);

const AssetSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1),
});

const PresetSchema = z.object({
  name: z.string().min(1),
  variables: z.record(z.string()),
});

const EntrySchema = z.object({
  css: z.string().min(1),
  previewJs: z.string().optional(),
  previewHtml: z.string().optional(),
});

const InjectSchema = z.object({
  articleHead: z.string().optional(),
  articleFoot: z.string().optional(),
});

const TypographySchema = z.object({
  autoSpacing: z.boolean().optional(),
  codeIndentPreserve: z.boolean().optional(),
  taskListGlyph: z.boolean().optional(),
  headingNumbering: z.boolean().optional(),
  hr: z.enum(["plain", "diamond", "none"]).optional(),
  figureCaption: z.boolean().optional(),
  tableZebra: z.boolean().optional(),
});

const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "id 必须是 kebab-case"),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version 必须符合 semver"),
  author: z.string().optional(),
  description: z.string().optional(),
  license: z.string().optional(),
  compat: z.object({ cli: z.string().optional() }).optional(),
  entry: EntrySchema,
  variables: z.array(VariableSchema).optional(),
  presets: z.array(PresetSchema).optional(),
  assets: z.array(AssetSchema).optional(),
  inject: InjectSchema.optional(),
  typography: TypographySchema.optional(),
  markdown: z.object({ breaks: z.boolean().optional() }).optional(),
  highlight: z.object({ enable: z.boolean().optional() }).optional(),
  publish: z.object({ coverDefault: z.string().optional(), autoDigest: z.boolean().optional() }).optional(),
}).passthrough();

/** 已知顶层字段（未知字段 lint 警告，前向兼容） */
const KNOWN_TOP_KEYS = new Set([
  "schemaVersion", "id", "name", "version", "author", "description", "license", "compat",
  "entry", "variables", "presets", "assets", "inject", "typography", "markdown",
  "highlight", "publish",
]);

export interface ManifestParseResult {
  manifest: Manifest;
  lint: LintIssue[];
}

/** 校验 manifest JSON 对象，错误定位到具体字段 */
export function parseManifest(raw: unknown): ManifestParseResult {
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.join(".") || "(root)";
      return `${path}: ${i.message}`;
    });
    throw new Md2mpError(
      `manifest.json 校验失败：\n  - ${issues.join("\n  - ")}`,
      "清单字段缺失或类型不符合 schema（见 TECH_DESIGN §4.2）。",
      "请按上述字段路径修正 manifest.json 后重试。",
      3,
    );
  }

  const manifest = result.data as unknown as Manifest;
  const lint: LintIssue[] = [];

  // 未知顶层字段警告
  for (const key of Object.keys(raw as object)) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      lint.push({ ruleId: "MP003", level: "warn", message: `manifest 含未知顶层字段 "${key}"（前向兼容，忽略）` });
    }
  }

  // assets 名称唯一性 + 占位符合法性
  const names = new Set<string>();
  for (const a of manifest.assets ?? []) {
    if (names.has(a.name)) {
      throw new Md2mpError(
        `manifest.assets 中资源名重复：${a.name}`,
        "asset 名称必须包内唯一（asset://name 引用）。",
        "请为每个资源配置不同的 name。",
        3,
      );
    }
    names.add(a.name);
  }

  // inject 占位符校验
  const placeholderRe = /\{\{([^}]+)\}\}/g;
  const allowedPlaceholders = new Set(["title", "author", "digest"]);
  for (const field of ["articleHead", "articleFoot"] as const) {
    const html = manifest.inject?.[field];
    if (!html) continue;
    let m: RegExpExecArray | null;
    while ((m = placeholderRe.exec(html)) !== null) {
      const p = m[1]!.trim();
      if (p.startsWith("asset:")) {
        const name = p.slice("asset:".length);
        if (!names.has(name)) {
          throw new Md2mpError(
            `inject.${field} 引用了未注册的资源占位符 {{asset:${name}}}`,
            "manifest.assets 中没有名为该值的资源。",
            `请在 assets 中声明 name="${name}"，或修正占位符。`,
            3,
          );
        }
      } else if (!allowedPlaceholders.has(p)) {
        throw new Md2mpError(
          `inject.${field} 含未知占位符 {{${p}}}`,
          "仅支持 {{title}}/{{author}}/{{digest}}/{{asset:name}}。",
          "请修正占位符名称。",
          3,
        );
      }
    }
  }

  // inject 中 script/style 检测
  for (const field of ["articleHead", "articleFoot"] as const) {
    const html = manifest.inject?.[field] ?? "";
    if (/<script\b/i.test(html)) {
      lint.push({ ruleId: "MP001", level: "error", message: `inject.${field} 含 <script>，公众号将剥离` });
    }
    if (/<style\b/i.test(html)) {
      lint.push({ ruleId: "MP002", level: "error", message: `inject.${field} 含 <style>，公众号将剥离` });
    }
  }

  return { manifest, lint };
}
