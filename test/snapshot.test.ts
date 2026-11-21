import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "../src/core/frontmatter";
import { render } from "../src/core/pipeline";
import { loadTemplate } from "../src/template/loader";
import { packTemplate } from "../src/template/pack";

const ROOT = resolve(import.meta.dir, "..");
const fixture = readFileSync(resolve(ROOT, "test/fixtures/full.md"), "utf8");

/** songmo 模板 ZIP：测试内从工程目录现场打包（仓库不提交构建产物） */
let songmoZip = "";
beforeAll(() => {
  songmoZip = packTemplate(resolve(ROOT, "templates/songmo"), join(tmpdir(), "md2mp-snapshot-songmo.zip")).outputPath;
});
afterAll(() => rmSync(songmoZip, { force: true }));

/** 渲染样例文档，返回 article.html */
async function renderFixture(templatePath?: string): Promise<string> {
  const doc = parseFrontmatter(fixture, "full.md");
  const { template } = await loadTemplate(templatePath);
  const result = await render(doc, {
    template,
    imageMode: "data",
    variables: {},
  }, { baseDir: resolve(ROOT, "test/fixtures") });
  return result.articleHtml;
}

describe("快照 & 确定性", () => {
  it("内置模板：连续两次渲染逐字节一致", async () => {
    const a = await renderFixture();
    const b = await renderFixture();
    expect(a).toBe(b);
  });

  it("songmo 模板：连续两次渲染逐字节一致", async () => {
    const a = await renderFixture(songmoZip);
    const b = await renderFixture(songmoZip);
    expect(a).toBe(b);
  });

  it("快照基线：内置模板输出稳定（首次生成，之后比对）", async () => {
    const out = await renderFixture();
    const snapPath = resolve(ROOT, "test/snapshots/default-article.html");
    if (!existsSync(snapPath)) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(snapPath, out, "utf8");
      console.log("✓ 快照已生成");
    }
    const baseline = readFileSync(snapPath, "utf8");
    expect(out).toBe(baseline);
  });

  it("输出不含禁止元素（script/style/class/id）", async () => {
    const out = await renderFixture();
    expect(out).not.toMatch(/<script\b/);
    expect(out).not.toMatch(/<style\b/);
    expect(out).not.toMatch(/\sclass=/);
    expect(out).not.toMatch(/\sid=/);
  });

  it("内联样式生效：section 带 style", async () => {
    const out = await renderFixture();
    expect(out).toMatch(/^<section style="/);
    expect(out).toMatch(/<p style="/);
  });

  it("章节编号/任务字形/代码块/表格/图片均存在", async () => {
    const out = await renderFixture();
    expect(out).toContain("粗体");
    expect(out).toContain("☑");
    expect(out).toContain("☐");
    expect(out).toContain("<table");
    // 高亮 class 已被剥离，但令牌色以内联 style 写入（默认主题关键字色 #c678dd）
    expect(out).toMatch(/color:#c678dd/);
    expect(out).toContain("data:image");
  });
});
