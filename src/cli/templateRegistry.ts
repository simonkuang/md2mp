import type { Command } from "commander";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RegisteredTemplate } from "../types";
import { Errors } from "./errors";
import { handleError } from "./common";
import { packTemplate } from "../template/pack";
import { loadTemplateFromBytes } from "../template/loader";
import {
  registerTemplate, replaceTemplateFile, updateTemplateMeta, removeTemplate, setDefaultTemplate,
  requireTemplate, readTemplateStore, getTemplatesDir, getTemplatesStorePath,
} from "../template/registry";

/** 展示给用户的模板条目（不含内部字段） */
function present(t: RegisteredTemplate) {
  return {
    alias: t.alias,
    name: t.name,
    id: t.templateId,
    version: t.version,
    isDefault: false,
    source: t.source,
    zipPath: t.zipPath,
    bytes: t.bytes,
    addedAt: t.addedAt,
    updatedAt: t.updatedAt,
  };
}

function fillDefault(rows: Array<{ alias: string; isDefault: boolean }>, defaultAlias?: string): void {
  for (const row of rows) row.isDefault = row.alias.toLowerCase() === (defaultAlias ?? "").toLowerCase();
}

/**
 * 准备用于注册的 ZIP：目录先 pack 到临时文件，ZIP 直接使用。
 * 调用方负责在 finally 中 cleanup。
 */
function prepareZip(source: string): { zipPath: string; sourceLabel: string; cleanup: () => void } {
  const abs = resolve(source);
  if (!existsSync(abs)) throw Errors.inputMissing(abs);
  if (!statSync(abs).isDirectory()) return { zipPath: abs, sourceLabel: abs, cleanup: () => {} };

  const tmp = join(tmpdir(), `md2mp-tpl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`);
  const { outputPath, lint } = packTemplate(abs, tmp);
  const errors = lint.filter((i) => i.level === "error");
  if (errors.length > 0) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw Errors.template(
      `模板工程存在 ${errors.length} 个兼容性错误，未注册`,
      errors.map((i) => `${i.ruleId}: ${i.message}`).join("；"),
      "请修复后重新执行 template add。",
    );
  }
  return { zipPath: outputPath, sourceLabel: abs, cleanup: () => { try { unlinkSync(tmp); } catch { /* ignore */ } } };
}

/** 校验 ZIP 并提取 manifest 元信息 */
function inspectZip(zipPath: string, label: string) {
  const bytes = new Uint8Array(readFileSync(zipPath));
  const { template, lint } = loadTemplateFromBytes(bytes, label);
  const errors = lint.filter((i) => i.level === "error");
  if (errors.length > 0) {
    throw Errors.template(
      `模板包存在 ${errors.length} 个兼容性错误，未注册`,
      errors.map((i) => `${i.ruleId}: ${i.message}`).join("；"),
      "请修复模板后重新执行 template add。",
    );
  }
  return { manifest: template.manifest, lint };
}

/** 注册模板命令到 template 子命令树 */
export function registerTemplateManagement(templateCmd: Command): void {
  /** add：注册模板（ZIP 或工程目录） */
  templateCmd.command("add")
    .description("注册模板：从 ZIP 或模板工程目录导入，之后可用 --template <别名> 引用")
    .argument("<alias>", "模板别名，如 songmo")
    .argument("<source>", "模板 ZIP 路径或模板工程目录")
    .option("-n, --name <name>", "展示名（默认取 manifest.name）")
    .option("-d, --default", "设为默认模板")
    .option("--json", "结构化输出")
    .action((alias: string, source: string, opts: Record<string, unknown>) => {
      const prepared = prepareZip(source);
      try {
        const { manifest, lint } = inspectZip(prepared.zipPath, alias);
        const entry = registerTemplate({
          alias,
          sourcePath: prepared.zipPath,
          name: (opts.name as string | undefined) || manifest.name,
          templateId: manifest.id,
          version: manifest.version,
          setDefault: opts.default as boolean | undefined,
          sourceLabel: prepared.sourceLabel,
        });
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, template: present(entry), warnings: lint.filter((i) => i.level === "warn") }, null, 2));
        } else {
          console.log(`✓ 模板已注册：${entry.alias}（${entry.name} v${entry.version}）`);
          console.log(`  模板 ID：${entry.templateId}`);
          console.log(`  使用：md2mp build article.md --template ${entry.alias}`);
          if (lint.length > 0) console.log(`  兼容性提示：${lint.length} 条（用 md2mp template show ${entry.alias} 查看）`);
        }
      } catch (err) { handleError(err); }
      finally { prepared.cleanup(); }
    });

  /** import：批量注册 */
  templateCmd.command("import")
    .description("批量注册模板（JSON 数组或 { templates: [...] }）")
    .argument("<file.json>", "条目格式：{ alias, source, name?, default? }")
    .option("--json", "结构化输出")
    .action((file: string, opts: Record<string, unknown>) => {
      try {
        const abs = resolve(file);
        if (!existsSync(abs)) throw Errors.inputMissing(abs);
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(abs, "utf8"));
        } catch (err) {
          throw Errors.args(`导入文件不是合法 JSON：${abs}`, err instanceof Error ? err.message : String(err), "请检查 JSON 语法。");
        }
        const obj = raw as { templates?: unknown[] };
        const items = (Array.isArray(raw) ? raw : Array.isArray(obj.templates) ? obj.templates : null) as
          | Array<{ alias: string; source: string; name?: string; default?: boolean }> | null;
        if (!items) {
          throw Errors.args("导入文件格式错误", "期望顶层为数组或 { templates: [...] }。", '示例：[{"alias":"songmo","source":"./songmo.zip"}]。');
        }
        const added = [] as ReturnType<typeof present>[];
        const skipped: Array<{ alias: string; reason: string }> = [];
        for (const item of items) {
          let prepared: ReturnType<typeof prepareZip> | undefined;
          try {
            prepared = prepareZip(String(item.source ?? ""));
            const { manifest } = inspectZip(prepared.zipPath, String(item.alias ?? ""));
            const entry = registerTemplate({
              alias: String(item.alias ?? ""),
              sourcePath: prepared.zipPath,
              name: item.name || manifest.name,
              templateId: manifest.id,
              version: manifest.version,
              setDefault: item.default,
              sourceLabel: prepared.sourceLabel,
            });
            added.push(present(entry));
          } catch (err) {
            skipped.push({ alias: String(item.alias ?? ""), reason: err instanceof Error ? err.message.split("\n")[0]! : String(err) });
          } finally {
            prepared?.cleanup();
          }
        }
        fillDefault(added, readTemplateStore().defaultAlias);
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, added, skipped }, null, 2));
        } else {
          console.log(`✓ 导入完成：新增 ${added.length}，跳过 ${skipped.length}`);
          for (const a of added) console.log(`  + ${a.alias}（${a.name} v${a.version}）`);
          for (const s of skipped) console.log(`  ! 跳过 ${s.alias || "(无别名)"}：${s.reason}`);
        }
      } catch (err) { handleError(err); }
    });

  /** list：列出注册表 */
  templateCmd.command("list")
    .description("列出已注册的模板（-t/--template 可直接用别名）")
    .option("--json", "结构化输出")
    .action((opts: Record<string, unknown>) => {
      try {
        const store = readTemplateStore();
        const rows = store.templates.map(present);
        fillDefault(rows, store.defaultAlias);
        if (opts.json) {
          console.log(JSON.stringify({
            ok: true,
            templates: rows,
            defaultAlias: store.defaultAlias ?? null,
            builtinAvailable: true,
            storePath: getTemplatesStorePath(),
          }, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log("暂无已注册的模板。用 `md2mp template add <别名> <zip|目录>` 注册。");
          console.log("未注册时 --template 不传参使用内置默认模板，也可用 --template builtin 显式指定。");
          return;
        }
        console.log(`已注册 ${rows.length} 个模板（默认：${store.defaultAlias ?? "未设置"}）：`);
        for (const r of rows) {
          console.log(`  ${r.isDefault ? "*" : " "} ${r.alias}  ${r.name}  v${r.version}`);
          console.log(`      id: ${r.id}  ${(r.bytes / 1024).toFixed(1)}KB`);
        }
        console.log(`\n  注册表：${getTemplatesStorePath()}`);
        console.log(`  模板副本：${getTemplatesDir()}`);
        console.log("  内置模板：--template builtin");
      } catch (err) { handleError(err); }
    });

  /** show：查看详情 */
  templateCmd.command("show")
    .description("查看单个模板详情（manifest / 变量 / 预设 / 兼容性）")
    .argument("<alias>", "模板别名")
    .option("--json", "结构化输出")
    .action((alias: string, opts: Record<string, unknown>) => {
      try {
        const t = requireTemplate(alias);
        const bytes = new Uint8Array(readFileSync(t.zipPath));
        const { template, lint } = loadTemplateFromBytes(bytes, t.alias);
        const m = template.manifest;
        const row = present(t);
        fillDefault([row], readTemplateStore().defaultAlias);
        const detail = {
          ...row,
          author: m.author ?? "",
          description: m.description ?? "",
          license: m.license ?? "",
          presetNames: (m.presets ?? []).map((p) => p.name),
          variables: (m.variables ?? []).map((v) => ({ key: v.key, label: v.label ?? "", type: v.type, default: v.default ?? "" })),
          assetNames: (m.assets ?? []).map((a) => a.name),
          lint,
        };
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, template: detail }, null, 2));
          return;
        }
        console.log(`别名：${row.alias}${row.isDefault ? "（默认）" : ""}`);
        console.log(`名称：${row.name}   版本：${row.version}   ID：${row.id}`);
        if (m.description) console.log(`说明：${m.description}`);
        console.log(`来源：${row.source}（原始导入位置，仅作记录）`);
        console.log(`副本：${row.zipPath}（${(row.bytes / 1024).toFixed(1)}KB，运行时使用此副本）`);
        console.log(`预设：${detail.presetNames.join(", ") || "(无)"}`);
        console.log(`变量：${detail.variables.map((v) => v.key).join(", ") || "(无)"}`);
        console.log(`资源：${detail.assetNames.join(", ") || "(无)"}`);
        console.log(`兼容性：${lint.length === 0 ? "无提示" : lint.map((i) => `[${i.ruleId}] ${i.message}`).join("\n        ")}`);
        console.log(`\n使用：md2mp build article.md --template ${row.alias}`);
      } catch (err) { handleError(err); }
    });

  /** update：改别名/名称/替换模板包 */
  templateCmd.command("update")
    .description("修改模板（改别名/展示名/替换 ZIP 或工程目录）")
    .argument("<alias>", "原别名")
    .option("--alias <new>", "新别名")
    .option("-n, --name <name>", "新展示名")
    .option("-f, --file <zip|dir>", "替换模板文件（ZIP 或工程目录）")
    .option("--json", "结构化输出")
    .action((alias: string, opts: Record<string, unknown>) => {
      let prepared: ReturnType<typeof prepareZip> | undefined;
      try {
        const hasMeta = opts.alias !== undefined || opts.name !== undefined;
        if (!hasMeta && !opts.file) {
          throw Errors.args("未指定要修改的字段", "update 需要至少一个修改项。", "例如：md2mp template update songmo --file ./songmo-v2.zip。");
        }
        if (opts.file) {
          prepared = prepareZip(opts.file as string);
          const { manifest, lint } = inspectZip(prepared.zipPath, alias);
          const errors = lint.filter((i) => i.level === "error");
          if (errors.length > 0) {
            throw Errors.template("模板包存在兼容性错误，未替换", errors.map((i) => i.message).join("；"), "请修复后重试。");
          }
          replaceTemplateFile(alias, {
            sourcePath: prepared.zipPath,
            name: (opts.name as string | undefined) || manifest.name,
            templateId: manifest.id,
            version: manifest.version,
            sourceLabel: prepared.sourceLabel,
          });
        }
        let updated = requireTemplate(alias);
        if (hasMeta) {
          updated = updateTemplateMeta(alias, {
            alias: opts.alias as string | undefined,
            name: opts.name as string | undefined,
          });
        }
        const row = present(updated);
        fillDefault([row], readTemplateStore().defaultAlias);
        if (opts.json) console.log(JSON.stringify({ ok: true, template: row }, null, 2));
        else console.log(`✓ 模板已更新：${row.alias}（${row.name} v${row.version}）`);
      } catch (err) { handleError(err); }
      finally { prepared?.cleanup(); }
    });

  /** remove：删除模板及副本 */
  templateCmd.command("remove")
    .description("删除已注册的模板（同时删除本地 ZIP 副本）")
    .alias("delete")
    .argument("<alias>", "模板别名")
    .option("--json", "结构化输出")
    .action((alias: string, opts: Record<string, unknown>) => {
      try {
        const t = removeTemplate(alias);
        if (opts.json) console.log(JSON.stringify({ ok: true, removed: { alias: t.alias, zipPath: t.zipPath } }, null, 2));
        else console.log(`✓ 模板已删除：${t.alias}（${t.name}），本地副本已清理。`);
      } catch (err) { handleError(err); }
    });

  /** default：设置默认模板 */
  templateCmd.command("default")
    .description("设置默认模板（未指定 --template 时优先使用）")
    .argument("<alias>", "模板别名")
    .option("--json", "结构化输出")
    .action((alias: string, opts: Record<string, unknown>) => {
      try {
        const t = setDefaultTemplate(alias);
        if (opts.json) console.log(JSON.stringify({ ok: true, defaultAlias: t.alias }, null, 2));
        else console.log(`✓ 默认模板已设为：${t.alias}（${t.name}）`);
      } catch (err) { handleError(err); }
    });
}
