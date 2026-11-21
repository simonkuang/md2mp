#!/usr/bin/env bun
import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CLI_VERSION, doRender, writeOut, handleError, preparePublish } from "./cli/common";
import { Errors } from "./cli/errors";
import { startPreviewServer } from "./preview/server";
import { scaffoldTemplate } from "./template/scaffold";
import { packTemplate } from "./template/pack";
import { lintTemplatePackage } from "./template/lint";
import { lintDom, formatLintText, RULE_CATALOG } from "./lint/engine";
import * as cheerio from "cheerio";
import { buildDraftArticle, addDraft, type DraftArticle } from "./publish/draft";
import { uploadCover } from "./publish/media";
import { registerAccountCommand } from "./cli/account";
import { registerTemplateManagement } from "./cli/templateRegistry";
import { getCandidates, prefetchCandidates, SHELLS, detectShell, completionScript, installCompletion } from "./cli/completion";
import type { ImageMode } from "./types";

const program = new Command();

program
  .name("md2mp")
  .description("Markdown → 微信公众号 HTML：本地运行、模板 ZIP 分发、可选直达草稿箱")
  .version(CLI_VERSION, "-v, --version", "输出版本号");

program.option("--no-color", "禁用彩色输出（保留兼容）");
program.option("-q, --quiet", "静默模式");

/** build 命令 */
program.command("build")
  .description("渲染 Markdown 为公众号 HTML（article.html + preview.html）")
  .argument("<article.md>", "Markdown 输入文件")
  .option("-t, --template <zip|别名>", "模板 ZIP 或已注册别名（不传则用默认模板/内置模板）")
  .option("-o, --out <dir>", "输出目录（默认输入文件所在目录）", "")
  .option("-V, --var <k=v...>", "覆盖模板变量（可多次）", collect, [])
  .option("-p, --preset <name>", "主题预设")
  .option("--image-mode <mode>", "图片模式：upload|data|link", "upload")
  .option("--account <alias>", "指定公众号账号别名（多账号）")
  .option("--standalone", "article.html 输出完整 HTML 文档（默认仅片段）")
  .option("--json", "结构化 JSON 输出")
  .action(async (article: string, opts: Record<string, unknown>) => {
    try {
      const mode = opts.imageMode as ImageMode;
      if (!["upload", "data", "link"].includes(mode)) {
        throw Errors.args(`无效的图片模式：${mode}`, "仅支持 upload / data / link。", "请使用 --image-mode data。");
      }
      const { result, prepared } = await doRender(article, {
        template: opts.template as string | undefined,
        preset: opts.preset as string | undefined,
        variables: opts.var as string[],
        imageMode: mode,
        account: opts.account as string | undefined,
      });

      const outDir = opts.out ? resolve(opts.out as string) : resolve(article, "..");
      const articlePath = resolve(outDir, "article.html");
      const previewPath = resolve(outDir, "preview.html");

      let articleOut = result.articleHtml;
      if (opts.standalone) {
        articleOut = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(result.meta.title)}</title></head><body>${result.articleHtml}</body></html>`;
      }

      writeOut(articlePath, articleOut);
      writeOut(previewPath, result.previewHtml);

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          article: articlePath,
          preview: previewPath,
          title: result.meta.title,
          lint: result.lint,
          imageStats: result.imageStats,
          account: prepared.accountAlias ?? null,
          credentialSource: prepared.credentialSource,
          template: prepared.templateRef,
          templateName: prepared.template.manifest.name,
        }, null, 2));
      } else {
        console.log(`✓ 渲染完成`);
        console.log(`  文章：${articlePath}`);
        console.log(`  预览：${previewPath}`);
        console.log(`  标题：${result.meta.title}`);
        console.log(`  模板：${prepared.templateRef}（${prepared.template.manifest.name} v${prepared.template.manifest.version}）`);
        if (prepared.accountAlias) console.log(`  公众号：${prepared.accountAlias}（${prepared.credentialSource}）`);
        console.log(`  图片：上传 ${result.imageStats.uploaded} / 内嵌 ${result.imageStats.embedded} / 外链 ${result.imageStats.linked}`);
        if (result.lint.length > 0) {
          console.log(`\n${formatLintText(result.lint)}`);
        }
      }
    } catch (err) {
      handleError(err);
    }
  });

/** preview 命令 */
program.command("preview")
  .description("生成预览页并在浏览器查看（--watch 启动热刷新服务）")
  .argument("<article.md>", "Markdown 输入文件")
  .option("-t, --template <zip|别名>", "模板 ZIP 或已注册别名")
  .option("-V, --var <k=v...>", "覆盖模板变量", collect, [])
  .option("-p, --preset <name>", "主题预设")
  .option("--image-mode <mode>", "图片模式", "data")
  .option("--watch", "启动本地服务并监听文件变化热刷新")
  .option("--port <n>", "服务端口", "4173")
  .option("--open", "自动打开浏览器")
  .action(async (article: string, opts: Record<string, unknown>) => {
    try {
      if (!opts.watch) {
        const { result } = await doRender(article, {
          template: opts.template as string | undefined,
          variables: opts.var as string[],
          preset: opts.preset as string | undefined,
          imageMode: (opts.imageMode as ImageMode) ?? "data",
        });
        const out = resolve(article, "../preview.html");
        writeOut(out, result.previewHtml);
        console.log(`✓ 预览页已生成：${out}`);
        if (opts.open) openBrowser(`file://${out}`);
        return;
      }

      // watch 模式
      let currentHtml = "";
      let templatePath: string | undefined;
      const renderOnce = async () => {
        const { result, prepared } = await doRender(article, {
          template: opts.template as string | undefined,
          variables: opts.var as string[],
          preset: opts.preset as string | undefined,
          imageMode: (opts.imageMode as ImageMode) ?? "data",
        });
        currentHtml = result.previewHtml;
        templatePath = prepared.template.sourcePath === "<builtin>" ? undefined : prepared.template.sourcePath;
      };
      await renderOnce();
      const ws = startPreviewServer({
        port: Number(opts.port),
        getHtml: () => currentHtml,
        onFileChange: renderOnce,
        watchFiles: [resolve(article), ...(templatePath ? [templatePath] : [])],
      });
      console.log(`✓ 预览服务已启动：${ws.url}`);
      console.log("  按 Ctrl+C 停止");
      if (opts.open) openBrowser(ws.url);
      // 保持进程活跃
      await new Promise(() => {});
    } catch (err) {
      handleError(err);
    }
  });

/** publish 命令 */
program.command("publish")
  .description("渲染并写入公众号草稿箱")
  .argument("<article.md>", "Markdown 输入文件")
  .option("-t, --template <zip|别名>", "模板 ZIP 或已注册别名")
  .option("-V, --var <k=v...>", "覆盖模板变量", collect, [])
  .option("-p, --preset <name>", "主题预设")
  .option("--cover <spec>", "封面：auto|asset:name|图片路径")
  .option("--account <alias>", "指定推送到哪个公众号（先用 md2mp account add 添加）")
  .option("--dry-run", "仅渲染与上传图片，不写草稿箱")
  .option("--json", "结构化输出")
  .action(async (article: string, opts: Record<string, unknown>) => {
    try {
      const { result, prepared } = await doRender(article, {
        template: opts.template as string | undefined,
        variables: opts.var as string[],
        preset: opts.preset as string | undefined,
        imageMode: "upload",
        account: opts.account as string | undefined,
      });

      // dry-run：输出将要提交的文章 JSON
      const articlePayload = buildDraftArticle(result.meta, result.articleHtml);
      if (opts.dryRun) {
        console.log(JSON.stringify({
          dryRun: true,
          account: prepared.accountAlias ?? null,
          credentialSource: prepared.credentialSource,
          appId: prepared.creds?.appId ?? null,
          draftPayload: { articles: [articlePayload] },
          lint: result.lint,
          imageStats: result.imageStats,
        }, null, 2));
        return;
      }

      if (!prepared.creds) throw Errors.credential(
        "publish 需要凭据",
        "未找到可用的公众号账号或环境变量凭据。",
        "请用 `md2mp account add <别名> --appid <id> --secret <secret>` 添加，然后 --account <别名> 指定；或设置 MP_APPID/MP_SECRET。",
      );
      const token = await preparePublish(prepared.creds);

      // 封面处理
      let thumbMediaId: string | undefined;
      const coverSpec = (opts.cover as string | undefined) ?? prepared.template.manifest.publish?.coverDefault;
      if (coverSpec && coverSpec !== "auto") {
        let bytes: Uint8Array | undefined;
        let filename = "cover.png";
        if (coverSpec.startsWith("asset:")) {
          const name = coverSpec.slice(6);
          bytes = prepared.template.assets.get(name);
          const def = prepared.template.manifest.assets?.find((a) => a.name === name);
          if (def) filename = def.file.split("/").pop() ?? filename;
        } else {
          const p = resolve(article, "..", coverSpec);
          if (existsSync(p)) {
            bytes = new Uint8Array(await Bun.file(p).arrayBuffer());
            filename = p.split("/").pop() ?? filename;
          }
        }
        if (bytes) thumbMediaId = await uploadCover(token, bytes, filename);
      }

      const draftArticle: DraftArticle = { ...articlePayload, thumb_media_id: thumbMediaId };
      const draft = await addDraft(token, draftArticle);

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, account: prepared.accountAlias ?? null, template: prepared.templateRef, draftId: draft.draftId, mpUrl: draft.mpUrl }, null, 2));
      } else {
        console.log(`✓ 草稿已写入${prepared.accountAlias ? `（公众号：${prepared.accountAlias}）` : ""}`);
        console.log(`  草稿 ID：${draft.draftId}`);
        console.log(`  后台链接：${draft.mpUrl}`);
      }
    } catch (err) {
      handleError(err);
    }
  });

/** lint 命令 */
program.command("lint")
  .description("检查 HTML/Markdown 的公众号兼容性")
  .argument("<file>", "article.html 或 article.md")
  .option("-t, --template <zip>", "模板 ZIP（校验 md 时使用）")
  .option("--json", "结构化输出")
  .action(async (file: string, opts: Record<string, unknown>) => {
    try {
      const abs = resolve(file);
      if (!existsSync(abs)) throw Errors.inputMissing(abs);
      const html = await Bun.file(abs).text();
      let lint;
      if (file.endsWith(".md")) {
        const r = await doRender(file, { template: opts.template as string | undefined, imageMode: "data" });
        lint = r.result.lint;
      } else {
        const $ = cheerio.load(html);
        lint = lintDom($);
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: lint.filter((i) => i.level === "error").length === 0, issues: lint }, null, 2));
      } else {
        console.log(formatLintText(lint));
      }
      if (lint.some((i) => i.level === "error")) process.exit(4);
    } catch (err) {
      handleError(err);
    }
  });

/** template 子命令树 */
const templateCmd = program.command("template").description("模板工程与管理：init / pack / lint / add / list / show / update / remove / default");

templateCmd.command("init")
  .description("初始化模板工程脚手架")
  .argument("<dir>", "新目录")
  .action((dir: string) => {
    try {
      const r = scaffoldTemplate(dir);
      console.log(`✓ 模板脚手架已创建：${r.dir}`);
      console.log(`  文件：${r.files.join(", ")}`);
      console.log(`\n下一步：编辑 ${r.dir}/theme.css，然后 md2mp template pack ${r.dir}`);
    } catch (err) { handleError(err); }
  });

templateCmd.command("pack")
  .description("校验并打包模板工程为 ZIP")
  .argument("<dir>", "模板工程目录")
  .option("-o, --out <zip>", "输出 ZIP 路径")
  .action((dir: string, opts: Record<string, unknown>) => {
    try {
      const r = packTemplate(dir, opts.out as string | undefined);
      console.log(`✓ 模板包已生成：${r.outputPath}`);
      if (r.lint.length > 0) {
        console.log(`\n${formatLintText(r.lint)}`);
      }
    } catch (err) { handleError(err); }
  });

templateCmd.command("lint")
  .description("检查模板包兼容性")
  .argument("<zip>", "模板 ZIP")
  .option("--json", "结构化输出")
  .action(async (zip: string, opts: Record<string, unknown>) => {
    try {
      const issues = await lintTemplatePackage(zip, CLI_VERSION);
      if (opts.json) {
        console.log(JSON.stringify({ ok: issues.filter((i) => i.level === "error").length === 0, issues }, null, 2));
      } else {
        console.log(formatLintText(issues));
      }
      if (issues.some((i) => i.level === "error")) process.exit(3);
    } catch (err) { handleError(err); }
  });

/** 模板注册中心：add / import / list / show / update / remove / default */
registerTemplateManagement(templateCmd);

/** 多公众号账号管理 */
registerAccountCommand(program);

/** 规则目录命令（便于查阅） */
program.command("rules").description("列出全部 lint 规则")
  .action(() => {
    console.log("lint 规则表：");
    for (const [id, r] of Object.entries(RULE_CATALOG)) {
      console.log(`  ${id}  [${r.level}]  ${r.title}`);
    }
  });

/** completion 命令：生成/安装 shell 补全脚本 */
const completionCmd = program
  .command("completion")
  .description("生成 shell 补全脚本（bash/zsh/fish/powershell/nushell/elvish，缺省自动检测）");

completionCmd
  .argument("[shell]", "目标 shell")
  .action((shell?: string) => {
    try {
      const s = (shell ?? detectShell()) as (typeof SHELLS)[number] | undefined;
      if (!s || !SHELLS.includes(s)) {
        throw Errors.args(
          `不支持的 shell：${shell ?? "（未能自动检测）"}`,
          `当前支持：${SHELLS.join(" / ")}。`,
          "请显式指定，如 md2mp completion zsh；或直接运行 md2mp completion install。",
        );
      }
      console.log(completionScript(s));
      console.error(`提示：挂载方式见脚本头部注释，或直接运行 md2mp completion install ${s}`);
    } catch (err) {
      handleError(err);
    }
  });

completionCmd
  .command("install")
  .description("写入补全脚本到 ~/.md2mp/completions/ 并挂载到对应 shell 配置（幂等）")
  .argument("[shell]", "目标 shell")
  .action((shell?: string) => {
    try {
      const s = (shell ?? detectShell()) as (typeof SHELLS)[number] | undefined;
      if (!s || !SHELLS.includes(s)) {
        throw Errors.args(
          `不支持的 shell：${shell ?? "（未能自动检测）"}`,
          `当前支持：${SHELLS.join(" / ")}。`,
          "请显式指定，如 md2mp completion install zsh。",
        );
      }
      const r = installCompletion(s);
      console.log(`✓ 补全脚本已写入：${r.file}`);
      if (r.rcFile) {
        console.log(r.rcAlreadyHooked ? `  挂载已存在，跳过：${r.rcFile}` : `  已挂载到：${r.rcFile}`);
      } else if (r.manualHint) {
        console.log(`  ${r.manualHint}`);
      } else {
        console.log("  fish 会自动加载，无需挂载");
      }
      console.log("  新开终端（或重新 source 配置）后生效，试试：md2mp build <TAB>");
    } catch (err) {
      handleError(err);
    }
  });

function collect(value: string, prev: string[]): string[] { prev.push(value); return prev; }

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function openBrowser(url: string): Promise<void> {
  const { exec } = await import("node:child_process");
  const cmd = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/** 内部补全入口（供 shell 脚本调用；不经 commander 解析，容忍任意 token） */
if (process.argv[2] === "__complete") {
  const words = process.argv.slice(3);
  void (async () => {
    try {
      await prefetchCandidates(words);
      const out = getCandidates(words);
      if (out.length > 0) console.log(out.join("\n"));
    } catch {
      // 补全永不报错
    }
    process.exit(0);
  })();
} else {
  program.parseAsync(process.argv).catch((err) => handleError(err));
}
