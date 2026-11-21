import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import {
  registerTemplate, listTemplates, findTemplate, requireTemplate, getDefaultTemplate,
  updateTemplateMeta, replaceTemplateFile, removeTemplate, setDefaultTemplate,
  resolveTemplateRef, validateTemplateAlias, getTemplatesStorePath,
} from "../src/template/registry";
import { loadTemplate } from "../src/template/loader";

let home: string;
let zip: string;
let savedHome: string | undefined;

/** 生成一个最小合法模板包 */
function makeZip(path: string, id: string, name: string, version = "1.0.0"): void {
  const manifest = {
    schemaVersion: 1,
    id,
    name,
    version,
    entry: { css: "theme.css" },
  };
  writeFileSync(path, zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "theme.css": strToU8("#js_article p { color: #333; }"),
  }));
}

beforeEach(() => {
  savedHome = process.env.MD2MP_HOME;
  home = mkdtempSync(join(tmpdir(), "md2mp-tpl-registry-test-"));
  process.env.MD2MP_HOME = home;
  zip = join(home, "source.zip");
  makeZip(zip, "demo-theme", "演示主题");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MD2MP_HOME;
  else process.env.MD2MP_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function reg(alias: string, extra: Record<string, unknown> = {}) {
  return registerTemplate({
    alias,
    sourcePath: zip,
    name: `名称-${alias}`,
    templateId: "demo-theme",
    version: "1.0.0",
    ...extra,
  });
}

describe("模板注册中心 CRUD", () => {
  it("新增/查找/列出，且 ZIP 副本落在隔离目录", () => {
    reg("a");
    reg("b");
    expect(listTemplates().length).toBe(2);
    expect(findTemplate("A")?.name).toBe("名称-a"); // 大小写不敏感
    expect(requireTemplate("b").templateId).toBe("demo-theme");
    expect(existsSync(requireTemplate("a").zipPath)).toBe(true);
    expect(requireTemplate("a").zipPath.startsWith(home)).toBe(true);
  });

  it("别名重复时报错", () => {
    reg("same");
    expect(() => reg("SAME")).toThrow();
  });

  it("首个模板自动默认，可切换；删默认回退到第一个", () => {
    reg("first");
    reg("second");
    expect(getDefaultTemplate()?.alias).toBe("first");
    setDefaultTemplate("second");
    expect(getDefaultTemplate()?.alias).toBe("second");
    removeTemplate("second");
    expect(getDefaultTemplate()?.alias).toBe("first");
  });

  it("改别名同步重命名副本与默认指向", () => {
    reg("old", { setDefault: true });
    const oldPath = requireTemplate("old").zipPath;
    const updated = updateTemplateMeta("old", { alias: "new", name: "新名称" });
    expect(updated.alias).toBe("new");
    expect(updated.name).toBe("新名称");
    expect(updated.zipPath).toBe(join(home, "templates", "new.zip"));
    expect(existsSync(updated.zipPath)).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
    expect(getDefaultTemplate()?.alias).toBe("new");
  });

  it("替换包内容时更新版本与来源标签", () => {
    reg("t");
    makeZip(zip, "demo-theme", "演示主题", "2.1.0");
    const updated = replaceTemplateFile("t", {
      sourcePath: zip,
      name: "演示主题2",
      templateId: "demo-theme",
      version: "2.1.0",
      sourceLabel: "/原始/工程目录",
    });
    expect(updated.version).toBe("2.1.0");
    expect(updated.source).toBe("/原始/工程目录");
    expect(existsSync(updated.zipPath)).toBe(true);
  });

  it("删除模板同时移出注册表并清理副本", () => {
    reg("gone");
    const p = requireTemplate("gone").zipPath;
    removeTemplate("gone");
    expect(findTemplate("gone")).toBeUndefined();
    expect(existsSync(p)).toBe(false);
  });

  it("入库后原 ZIP 可删除：运行仍走副本，仅删除模板时清理副本", async () => {
    const entry = reg("copy-owner");
    const copyPath = entry.zipPath;
    expect(copyPath).not.toBe(zip);         // 副本不在导入位置
    expect(existsSync(copyPath)).toBe(true); // 注册即落盘副本

    // 用户删除导入位置的原文件
    rmSync(zip);
    expect(existsSync(zip)).toBe(false);

    // 别名解析仍指向配置目录副本，且能正常加载渲染
    const resolved = resolveTemplateRef("copy-owner");
    expect(resolved.builtin).toBe(false);
    expect(resolved.sourcePath).toBe(copyPath);
    const loaded = await loadTemplate("copy-owner");
    expect(loaded.template.manifest.name).toBe("演示主题");
    expect(existsSync(copyPath)).toBe(true); // 渲染不会删改副本

    // 只有显式删除模板时才清理副本
    removeTemplate("copy-owner");
    expect(existsSync(copyPath)).toBe(false);
  });

  it("别名保留字与非法字符被拒绝", () => {
    expect(() => validateTemplateAlias("builtin")).toThrow();
    expect(() => validateTemplateAlias("bad name!")).toThrow();
    expect(() => reg("builtin")).toThrow();
  });

  it("注册表损坏时明确报错", () => {
    writeFileSync(getTemplatesStorePath(), "{broken");
    expect(() => listTemplates()).toThrow();
  });
});

describe("模板引用解析优先级", () => {
  it("显式路径优先于别名", () => {
    reg("alias-a");
    const r = resolveTemplateRef(zip);
    expect(r.builtin).toBe(false);
    expect(r.sourcePath).toBe(zip);
    expect(r.label).toBe(zip);
  });

  it("别名解析到本地副本", () => {
    reg("alias-b");
    const r = resolveTemplateRef("ALIAS-B");
    expect(r.builtin).toBe(false);
    expect(r.alias).toBe("alias-b");
    expect(r.sourcePath).toBe(requireTemplate("alias-b").zipPath);
  });

  it("builtin 保留字强制内置；default 指向默认模板", () => {
    reg("d1");
    reg("d2", { setDefault: true });
    expect(resolveTemplateRef("builtin").builtin).toBe(true);
    const r = resolveTemplateRef("default");
    expect(r.alias).toBe("d2");
    expect(r.builtin).toBe(false);
  });

  it("未传引用时用默认模板；无注册模板时用内置", () => {
    expect(resolveTemplateRef().builtin).toBe(true);
    reg("only");
    const r = resolveTemplateRef();
    expect(r.alias).toBe("only");
  });

  it("未知别名报错并给出可用别名", () => {
    reg("known");
    expect(() => resolveTemplateRef("missing")).toThrow();
  });
});
