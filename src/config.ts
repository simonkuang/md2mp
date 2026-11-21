import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ImageMode, Manifest } from "./types";
import { getDefaultAccount, requireAccount } from "./account/store";

export interface RcConfig {
  appId?: string;
  secret?: string;
  /** 模板 ZIP 路径或已注册别名（CLI --template 优先） */
  template?: string;
  imageMode?: ImageMode;
  variables?: Record<string, string>;
  preset?: string;
  [key: string]: unknown;
}

/** 从当前目录向上查找 .md2mprc.json */
export function findRcFile(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".md2mprc.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface LoadedRc {
  config: RcConfig;
  path?: string;
}

export function loadRc(startDir?: string): LoadedRc {
  const path = findRcFile(startDir);
  if (!path) return { config: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { config: raw as RcConfig, path };
  } catch (err) {
    console.warn(`⚠ .md2mprc.json 解析失败（${path}），已忽略：${err instanceof Error ? err.message : String(err)}`);
    return { config: {} };
  }
}

/** 凭据来源（用于提示与 dry-run 输出） */
export type CredentialSource = "account-flag" | "default-account" | "env" | "rc" | "none";

export interface ResolvedCredentials {
  appId?: string;
  secret?: string;
  /** 凭据来源 */
  source: CredentialSource;
  /** 若来自账号库，记录别名 */
  alias?: string;
  /** 兼容旧字段：是否来自 rc 明文配置 */
  fromRc: boolean;
}

/**
 * 凭据解析优先级：--account 指定账号 > 环境变量 > .md2mprc.json > 默认账号 > 无。
 * --account 显式指定时，账号不存在会直接报错（不静默降级）。
 */
export function resolveCredentials(rc: RcConfig, accountAlias?: string): ResolvedCredentials {
  if (accountAlias) {
    const acc = requireAccount(accountAlias);
    return { appId: acc.appId, secret: acc.secret, source: "account-flag", alias: acc.alias, fromRc: false };
  }

  const envId = process.env.MP_APPID;
  const envSecret = process.env.MP_SECRET;
  if (envId || envSecret) {
    return { appId: envId || undefined, secret: envSecret || undefined, source: "env", fromRc: false };
  }

  if (rc.appId || rc.secret) {
    return { appId: rc.appId || undefined, secret: rc.secret || undefined, source: "rc", fromRc: true };
  }

  const def = getDefaultAccount();
  if (def) {
    return { appId: def.appId, secret: def.secret, source: "default-account", alias: def.alias, fromRc: false };
  }

  return { source: "none", fromRc: false };
}

/**
 * 合并变量：theme.css :root < manifest default < preset < rc.variables < cli -V
 * 这里处理 manifest default / preset / rc / cli 四层（:root 在 pipeline 内）。
 */
export function mergeVariables(
  manifest: Manifest,
  cliVars: Record<string, string>,
  rcVars: Record<string, string>,
  presetName?: string,
): { variables: Record<string, string>; presetName?: string } {
  const out: Record<string, string> = {};

  for (const v of manifest.variables ?? []) {
    if (v.default !== undefined) out[v.key] = v.default;
  }

  let resolvedPreset = presetName;
  if (manifest.presets && manifest.presets.length > 0) {
    if (!resolvedPreset) resolvedPreset = manifest.presets[0]!.name;
    const preset = manifest.presets.find((p) => p.name === resolvedPreset);
    if (preset) {
      for (const [k, val] of Object.entries(preset.variables)) out[k] = val;
    }
  }

  for (const [k, val] of Object.entries(rcVars)) out[k] = val;
  for (const [k, val] of Object.entries(cliVars)) out[k] = val;

  return { variables: out, presetName: resolvedPreset };
}

/** 解析 -V key=value 数组 */
export function parseVariables(cliVarList: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of cliVarList) {
    const idx = item.indexOf("=");
    if (idx < 0) {
      throw new Error(`变量格式应为 key=value，收到：${item}`);
    }
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (!key) throw new Error(`变量 key 不能为空：${item}`);
    out[key] = value;
  }
  return out;
}
