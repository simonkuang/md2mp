import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pkgJson from "../../package.json";
import type { Doc, LintIssue, RenderOptions, RenderResult, Template } from "../types";
import { Md2mpError, Errors } from "./errors";
import { parseFrontmatter } from "../core/frontmatter";
import { loadTemplate } from "../template/loader";
import { loadRc, resolveCredentials, mergeVariables, parseVariables, type CredentialSource } from "../config";
import { render, type PipelineDeps } from "../core/pipeline";
import { semverSatisfies, dedupeIssues } from "../template/lint";
import { requireCredentials, getAccessToken, checkDraftPermission, type Credentials } from "../publish/token";
import { uploadImage, uploadCover } from "../publish/media";

/** CLI 版本：单一来源 = package.json（编译期打包进二进制，升版本只改 package.json） */
export const CLI_VERSION: string = pkgJson.version;

export interface CommonBuildOptions {
  template?: string;
  preset?: string;
  variables?: string[];
  imageMode?: "upload" | "data" | "link";
  baseDir?: string;
  /** 指定公众号账号别名（多账号管理） */
  account?: string;
}

/** 加载文档（校验文件存在） */
export async function loadDoc(path: string): Promise<Doc> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw Errors.inputMissing(abs);
  const raw = await Bun.file(abs).text();
  return parseFrontmatter(raw, abs);
}

/** 准备渲染选项（模板加载 + 变量合并 + 凭据） */
export async function prepareRender(opts: CommonBuildOptions): Promise<{
  docOptions: Omit<RenderOptions, "template" | "imageMode" | "variables">;
  template: Template;
  imageMode: "upload" | "data" | "link";
  variables: Record<string, string>;
  creds?: Credentials;
  rcFromRc: boolean;
  credentialSource: CredentialSource;
  accountAlias?: string;
  /** 实际采用的模板引用（别名/路径/内置） */
  templateRef: string;
  /** 模板加载期 lint（manifest 层警告，随渲染结果合并输出） */
  templateLint: LintIssue[];
}> {
  const rc = loadRc();
  const templateRef = opts.template ?? rc.config.template;
  const { template: loaded, lint: templateLint } = await loadTemplate(templateRef);
  // compat.cli 校验（仅警告，不阻断渲染；template lint 中为正式检查项）
  const compat = loaded.manifest.compat?.cli;
  if (compat && !semverSatisfies(CLI_VERSION, compat)) {
    console.warn(`⚠ 模板要求 CLI ${compat}，当前为 ${CLI_VERSION}，渲染行为可能不符合模板预期。`);
  }
  const cliVars = parseVariables(opts.variables ?? []);
  const { variables, presetName } = mergeVariables(loaded.manifest, cliVars, rc.config.variables ?? {}, opts.preset);

  const imageMode = opts.imageMode ?? rc.config.imageMode ?? "upload";
  const credsRaw = resolveCredentials(rc.config, opts.account);
  if (credsRaw.fromRc) {
    console.warn("⚠ 安全提示：凭据来自 .md2mprc.json（明文存储），建议改用 `md2mp account add` 保存账号。");
  }

  let creds: Credentials | undefined;
  if (imageMode === "upload") {
    creds = requireCredentials(credsRaw.appId, credsRaw.secret);
  }

  return {
    docOptions: { presetName, cliVersion: CLI_VERSION },
    template: loaded,
    imageMode,
    variables,
    creds,
    rcFromRc: credsRaw.fromRc,
    credentialSource: credsRaw.source,
    accountAlias: credsRaw.alias,
    templateRef: templateRef ?? (loaded.manifest.name ? `默认：${loaded.manifest.name}` : "内置默认"),
    templateLint,
  };
}

/** 构建 uploader 闭包（绑定 token） */
export async function makeUploader(creds: Credentials): Promise<(bytes: Uint8Array, filename: string) => Promise<string>> {
  const token = await getAccessToken(creds);
  return (bytes, filename) => uploadImage(token, bytes, filename);
}

/** 执行渲染（含 upload 凭据准备） */
export async function doRender(
  docPath: string,
  opts: CommonBuildOptions,
): Promise<{ result: RenderResult; prepared: Awaited<ReturnType<typeof prepareRender>>; doc: Doc }> {
  const doc = await loadDoc(docPath);
  const prepared = await prepareRender(opts);
  const deps: PipelineDeps = {};
  if (prepared.creds) {
    deps.uploader = await makeUploader(prepared.creds);
  }
  deps.baseDir = opts.baseDir ?? dirname(resolve(docPath));

  const result = await render(doc, {
    template: prepared.template,
    imageMode: prepared.imageMode,
    variables: prepared.variables,
    presetName: prepared.docOptions.presetName,
    cliVersion: CLI_VERSION,
  }, deps);

  // 模板加载期 lint（manifest 层警告）合并进渲染结果
  result.lint = dedupeIssues([...prepared.templateLint, ...result.lint]);

  return { result, prepared, doc };
}

/** 写文件（自动建目录） */
export function writeOut(path: string, content: string): void {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** 统一错误处理：设置退出码 */
export function handleError(err: unknown): never {
  if (err instanceof Md2mpError) {
    console.error(err.format());
    process.exit(err.exitCode);
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✖ 未预期的错误：${msg}`);
  process.exit(4);
}

/** 发布：获取 token 并校验权限 */
export async function preparePublish(creds: Credentials): Promise<string> {
  const token = await getAccessToken(creds);
  const ok = await checkDraftPermission(token);
  if (!ok) {
    throw Errors.credential(
      "当前公众号无草稿箱接口权限",
      "未认证订阅号通常无 draft/add 权限（错误码 48001）。",
      "请改用认证服务号，或使用 --image-mode data + preview 手动复制粘贴。",
    );
  }
  return token;
}

export { uploadCover };
