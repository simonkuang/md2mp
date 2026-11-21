import {
  existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync,
  copyFileSync, unlinkSync, statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { RegisteredTemplate, TemplateStoreData } from "../types";
import { Errors } from "../cli/errors";
import { getMd2mpHome } from "../account/store";

/**
 * 模板注册中心：
 *  - 索引 ~/.md2mp/templates.json
 *  - ZIP 副本 ~/.md2mp/templates/<alias>.zip
 * 复制副本而非引用原路径，避免源文件被移动/删除后模板失效。
 */

export function getTemplatesDir(): string {
  return join(getMd2mpHome(), "templates");
}

export function getTemplatesStorePath(): string {
  return join(getMd2mpHome(), "templates.json");
}

export function templateZipPath(alias: string): string {
  return join(getTemplatesDir(), `${alias}.zip`);
}

/** 读取注册表；文件不存在返回空表，损坏则明确报错 */
export function readTemplateStore(): TemplateStoreData {
  const path = getTemplatesStorePath();
  if (!existsSync(path)) return { version: 1, templates: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw Errors.template(
      `模板注册表损坏：${path}`,
      err instanceof Error ? err.message : String(err),
      "请检查 JSON 语法；若无法修复，可备份后删除重建（已注册模板需重新 add）。",
    );
  }
  const store = raw as TemplateStoreData;
  if (!store || store.version !== 1 || !Array.isArray(store.templates)) {
    throw Errors.template(
      `模板注册表格式不兼容：${path}`,
      "期望 version=1 且 templates 为数组。",
      "请备份后重建，或按正确格式修正。",
    );
  }
  return store;
}

export function writeTemplateStore(store: TemplateStoreData): void {
  mkdirSync(getMd2mpHome(), { recursive: true });
  const path = getTemplatesStorePath();
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
  try { chmodSync(path, 0o600); } catch { /* 非 POSIX 平台忽略 */ }
}

export function validateTemplateAlias(alias: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(alias)) {
    throw Errors.args(
      `模板别名不合法：${alias}`,
      "别名需以字母或数字开头，仅含字母、数字、短横线、下划线，长度 1-64。",
      "例如：--template songmo 或 --template my-theme。",
    );
  }
  if (alias.toLowerCase() === "builtin") {
    throw Errors.args("模板别名不能是 builtin", "builtin 是保留字，用于显式选择内置模板。", "请换一个别名。");
  }
}

export function findTemplate(alias: string): RegisteredTemplate | undefined {
  const lower = alias.toLowerCase();
  return readTemplateStore().templates.find((t) => t.alias.toLowerCase() === lower);
}

export function requireTemplate(alias: string): RegisteredTemplate {
  const t = findTemplate(alias);
  if (!t) {
    const all = listTemplates();
    throw Errors.template(
      `未找到已注册的模板：${alias}`,
      "注册表中没有该别名。",
      all.length
        ? `可用别名：${all.map((x) => x.alias).join(", ")}。用 md2mp template list 查看。`
        : "注册表为空，请先用 md2mp template add <别名> <zip|目录> 注册模板。",
    );
  }
  return t;
}

export function listTemplates(): RegisteredTemplate[] {
  return readTemplateStore().templates;
}

export function getDefaultTemplate(): RegisteredTemplate | undefined {
  const store = readTemplateStore();
  if (store.defaultAlias) {
    const found = store.templates.find((t) => t.alias.toLowerCase() === store.defaultAlias!.toLowerCase());
    if (found) return found;
  }
  return store.templates[0];
}

export interface RegisterTemplateInput {
  alias: string;
  /** 源 ZIP 路径（内容将被复制到注册表目录） */
  sourcePath: string;
  name: string;
  templateId: string;
  version: string;
  setDefault?: boolean;
  /** 展示用来源（目录导入时记录原始目录而非临时 ZIP） */
  sourceLabel?: string;
}

/** 复制 ZIP 副本并登记（别名重复则报错） */
export function registerTemplate(input: RegisterTemplateInput): RegisteredTemplate {
  validateTemplateAlias(input.alias);
  const store = readTemplateStore();
  if (store.templates.some((t) => t.alias.toLowerCase() === input.alias.toLowerCase())) {
    throw Errors.args(
      `模板别名已存在：${input.alias}`,
      "别名必须唯一，--template 依据别名定位模板。",
      "请换一个别名，或用 md2mp template update <别名> --file <zip> 替换内容。",
    );
  }
  const src = resolve(input.sourcePath);
  if (!existsSync(src)) throw Errors.inputMissing(src);

  const dest = templateZipPath(input.alias);
  mkdirSync(getTemplatesDir(), { recursive: true });
  copyFileSync(src, dest);
  try { chmodSync(dest, 0o644); } catch { /* ignore */ }

  const now = new Date().toISOString();
  const entry: RegisteredTemplate = {
    alias: input.alias,
    name: input.name,
    templateId: input.templateId,
    version: input.version,
    source: input.sourceLabel ?? src,
    zipPath: dest,
    bytes: statSync(dest).size,
    addedAt: now,
    updatedAt: now,
  };
  store.templates.push(entry);
  if (input.setDefault || !store.defaultAlias) store.defaultAlias = entry.alias;
  writeTemplateStore(store);
  return entry;
}

/** 替换已注册模板的 ZIP 副本与元信息 */
export function replaceTemplateFile(alias: string, input: {
  sourcePath: string;
  name: string;
  templateId: string;
  version: string;
  sourceLabel?: string;
}): RegisteredTemplate {
  const store = readTemplateStore();
  const idx = store.templates.findIndex((t) => t.alias.toLowerCase() === alias.toLowerCase());
  if (idx < 0) throw requireTemplate(alias);

  const src = resolve(input.sourcePath);
  if (!existsSync(src)) throw Errors.inputMissing(src);
  const dest = store.templates[idx]!.zipPath;
  if (resolve(src) !== resolve(dest)) {
    mkdirSync(getTemplatesDir(), { recursive: true });
    // 先删再写，避免某些文件系统上覆盖失败
    if (existsSync(dest)) unlinkSync(dest);
    copyFileSync(src, dest);
    try { chmodSync(dest, 0o644); } catch { /* ignore */ }
  }

  const updated: RegisteredTemplate = {
    ...store.templates[idx]!,
    name: input.name,
    templateId: input.templateId,
    version: input.version,
    source: input.sourceLabel ?? src,
    bytes: statSync(dest).size,
    updatedAt: new Date().toISOString(),
  };
  store.templates[idx] = updated;
  writeTemplateStore(store);
  return updated;
}

export interface UpdateTemplatePatch {
  alias?: string;
  name?: string;
}

/** 修改别名/展示名；别名变更时同步重命名 ZIP 副本与默认指向 */
export function updateTemplateMeta(alias: string, patch: UpdateTemplatePatch): RegisteredTemplate {
  const store = readTemplateStore();
  const idx = store.templates.findIndex((t) => t.alias.toLowerCase() === alias.toLowerCase());
  if (idx < 0) throw requireTemplate(alias);
  const current = store.templates[idx]!;

  if (patch.alias && patch.alias !== current.alias) {
    validateTemplateAlias(patch.alias);
    if (store.templates.some((t, i) => i !== idx && t.alias.toLowerCase() === patch.alias!.toLowerCase())) {
      throw Errors.args(`模板别名已存在：${patch.alias}`, "别名必须唯一。", "请换一个别名。");
    }
    const newZip = templateZipPath(patch.alias);
    const oldZip = current.zipPath;
    mkdirSync(getTemplatesDir(), { recursive: true });
    // 大小写不敏感文件系统上新旧路径可能相同：先读进内存再写，避免自删除
    const bytes = readFileSync(oldZip);
    const samePath = resolve(newZip) === resolve(oldZip);
    if (!samePath) {
      if (existsSync(newZip)) unlinkSync(newZip);
      writeFileSync(newZip, bytes);
      if (existsSync(oldZip)) unlinkSync(oldZip);
    }
    if (store.defaultAlias?.toLowerCase() === current.alias.toLowerCase()) {
      store.defaultAlias = patch.alias;
    }
    current.alias = patch.alias;
    current.zipPath = newZip;
  }
  if (patch.name !== undefined) current.name = patch.name;
  current.updatedAt = new Date().toISOString();
  store.templates[idx] = current;
  writeTemplateStore(store);
  return current;
}

/** 删除模板：移出注册表并删除 ZIP 副本；默认模板自动改指第一个 */
export function removeTemplate(alias: string): RegisteredTemplate {
  const store = readTemplateStore();
  const t = requireTemplate(alias);
  store.templates = store.templates.filter((x) => x.alias.toLowerCase() !== t.alias.toLowerCase());
  if (store.defaultAlias?.toLowerCase() === t.alias.toLowerCase()) {
    store.defaultAlias = store.templates[0]?.alias;
  }
  writeTemplateStore(store);
  try { if (existsSync(t.zipPath)) unlinkSync(t.zipPath); } catch { /* 副本清理失败不影响注册表 */ }
  return t;
}

export function setDefaultTemplate(alias: string): RegisteredTemplate {
  const t = requireTemplate(alias);
  const store = readTemplateStore();
  store.defaultAlias = t.alias;
  writeTemplateStore(store);
  return t;
}

/** 模板引用解析结果 */
export interface ResolvedTemplateRef {
  sourcePath?: string;
  alias?: string;
  builtin: boolean;
  /** 展示用来源描述 */
  label: string;
}

/**
 * 解析 --template / rc.template：
 *  显式路径 > 注册别名 > 保留字（builtin/default）> 默认注册模板 > 内置模板
 */
export function resolveTemplateRef(ref?: string): ResolvedTemplateRef {
  if (ref) {
    if (existsSync(ref)) {
      return { sourcePath: resolve(ref), builtin: false, label: resolve(ref) };
    }
    if (ref.toLowerCase() === "builtin") {
      return { builtin: true, label: "<builtin>" };
    }
    if (ref.toLowerCase() === "default") {
      const def = getDefaultTemplate();
      if (def) return { sourcePath: def.zipPath, alias: def.alias, builtin: false, label: `${def.alias} (默认)` };
      return { builtin: true, label: "<builtin>" };
    }
    const t = findTemplate(ref);
    if (t) return { sourcePath: t.zipPath, alias: t.alias, builtin: false, label: `${t.alias} (${t.name})` };
    throw Errors.template(
      `模板不存在：${ref}`,
      "该值既不是存在的 ZIP 路径，也不是已注册的模板别名。",
      "用 md2mp template list 查看可用别名，或用 md2mp template add <别名> <zip|目录> 注册。",
    );
  }
  const def = getDefaultTemplate();
  if (def) return { sourcePath: def.zipPath, alias: def.alias, builtin: false, label: `${def.alias} (默认)` };
  return { builtin: true, label: "<builtin>" };
}

/** 仅用于测试的清理入口 */
export function clearTemplateStoreForTest(): void {
  const p = getTemplatesStorePath();
  if (existsSync(p)) unlinkSync(p);
}
