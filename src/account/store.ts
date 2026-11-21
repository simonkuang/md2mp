import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountStoreData, MpAccount } from "../types";
import { Md2mpError, Errors } from "../cli/errors";

/**
 * 账号持久化目录：默认 ~/.md2mp，可用 MD2MP_HOME 覆盖（测试隔离用）。
 */
export function getMd2mpHome(): string {
  return process.env.MD2MP_HOME ? resolveHome(process.env.MD2MP_HOME) : join(homedir(), ".md2mp");
}

function resolveHome(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1).replace(/^[/\\]/, ""));
  return p;
}

export function getAccountsPath(): string {
  return join(getMd2mpHome(), "accounts.json");
}

/**
 * 读取账号库。文件不存在返回空库；损坏时给出可读错误（不静默丢失用户数据）。
 */
export function readStore(): AccountStoreData {
  const path = getAccountsPath();
  if (!existsSync(path)) return { version: 1, accounts: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Md2mpError(
      `账号库文件损坏：${path}`,
      err instanceof Error ? err.message : String(err),
      "请检查该文件的 JSON 语法；若无法修复，可备份后删除重建（会丢失已保存账号）。",
      6,
    );
  }
  const store = raw as AccountStoreData;
  if (!store || store.version !== 1 || !Array.isArray(store.accounts)) {
    throw new Md2mpError(
      `账号库格式不兼容：${path}`,
      "期望 version=1 且 accounts 为数组。",
      "请备份该文件后重建，或按正确格式修正。",
      6,
    );
  }
  return store;
}

/** 写入账号库（原子友好 + 0600 权限，仅当前用户可读写） */
export function writeStore(store: AccountStoreData): void {
  const dir = getMd2mpHome();
  mkdirSync(dir, { recursive: true });
  const path = getAccountsPath();
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // 非 POSIX 平台忽略
  }
}

/** 校验别名：字母数字短横线下划线，便于命令行输入 */
export function validateAlias(alias: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(alias)) {
    throw Errors.args(
      `公众号别名不合法：${alias}`,
      "别名需以字母或数字开头，仅含字母、数字、短横线、下划线，长度 1-64。",
      "例如：--account company-a 或 --account myblog。",
    );
  }
}

function validateCredentials(appId: string, secret: string): void {
  if (!appId.trim()) throw Errors.args("appid 不能为空", "appid 是公众号唯一标识。", "请提供有效的 appid。");
  if (!secret.trim()) throw Errors.args("appsecret 不能为空", "appsecret 用于换取 access_token。", "请提供有效的 appsecret。");
}

/** 按别名查找（大小写不敏感） */
export function findAccount(alias: string): MpAccount | undefined {
  const store = readStore();
  const lower = alias.toLowerCase();
  return store.accounts.find((a) => a.alias.toLowerCase() === lower);
}

/** 按别名查找，找不到则报错 */
export function requireAccount(alias: string): MpAccount {
  const acc = findAccount(alias);
  if (!acc) {
    const all = listAccounts();
    throw Errors.credential(
      `未找到公众号账号：${alias}`,
      "账号库中没有该别名。",
      all.length
        ? `可用别名：${all.map((a) => a.alias).join(", ")}。用 md2mp account list 查看。`
        : "账号库为空，请先用 md2mp account add <别名> --appid <id> --secret <secret> 添加。",
    );
  }
  return acc;
}

export interface AddAccountInput {
  alias: string;
  appId: string;
  secret: string;
  name?: string;
  setDefault?: boolean;
}

/** 新增账号；别名重复则报错 */
export function addAccount(input: AddAccountInput): MpAccount {
  validateAlias(input.alias);
  validateCredentials(input.appId, input.secret);
  const store = readStore();
  if (store.accounts.some((a) => a.alias.toLowerCase() === input.alias.toLowerCase())) {
    throw Errors.args(
      `公众号别名已存在：${input.alias}`,
      "别名必须唯一，--account 依据别名定位账号。",
      "请换一个别名，或用 md2mp account update <别名> 修改现有账号。",
    );
  }
  const now = new Date().toISOString();
  const account: MpAccount = {
    alias: input.alias,
    appId: input.appId.trim(),
    secret: input.secret.trim(),
    ...(input.name ? { name: input.name.trim() } : {}),
    createdAt: now,
    updatedAt: now,
  };
  store.accounts.push(account);
  if (input.setDefault || !store.defaultAlias) store.defaultAlias = account.alias;
  writeStore(store);
  return account;
}

/** 列出全部账号 */
export function listAccounts(): MpAccount[] {
  return readStore().accounts;
}

/** 获取默认账号 */
export function getDefaultAccount(): MpAccount | undefined {
  const store = readStore();
  if (store.defaultAlias) {
    const acc = store.accounts.find((a) => a.alias.toLowerCase() === store.defaultAlias!.toLowerCase());
    if (acc) return acc;
  }
  return store.accounts[0];
}

export interface UpdateAccountPatch {
  alias?: string;
  appId?: string;
  secret?: string;
  name?: string | null;
}

/** 修改账号（含改名）；返回更新后的账号 */
export function updateAccount(alias: string, patch: UpdateAccountPatch): MpAccount {
  const store = readStore();
  const idx = store.accounts.findIndex((a) => a.alias.toLowerCase() === alias.toLowerCase());
  if (idx < 0) throw requireAccount(alias); // 抛出「未找到」错误
  const current = store.accounts[idx]!;

  if (patch.appId !== undefined) validateCredentials(patch.appId, patch.secret ?? current.secret);
  if (patch.secret !== undefined) validateCredentials(patch.appId ?? current.appId, patch.secret);

  if (patch.alias && patch.alias !== current.alias) {
    validateAlias(patch.alias);
    if (store.accounts.some((a, i) => i !== idx && a.alias.toLowerCase() === patch.alias!.toLowerCase())) {
      throw Errors.args(`公众号别名已存在：${patch.alias}`, "别名必须唯一。", "请换一个别名。");
    }
  }

  const updated: MpAccount = {
    ...current,
    ...(patch.alias ? { alias: patch.alias } : {}),
    ...(patch.appId !== undefined ? { appId: patch.appId.trim() } : {}),
    ...(patch.secret !== undefined ? { secret: patch.secret.trim() } : {}),
    ...(patch.name !== undefined ? (patch.name === null ? { name: undefined } : { name: patch.name.trim() }) : {}),
    updatedAt: new Date().toISOString(),
  };
  if (patch.alias && store.defaultAlias?.toLowerCase() === current.alias.toLowerCase()) {
    store.defaultAlias = updated.alias;
  }
  store.accounts[idx] = updated;
  writeStore(store);
  return updated;
}

/** 删除账号（若删的是默认账号，自动改指第一个或清空） */
export function removeAccount(alias: string): MpAccount {
  const store = readStore();
  const acc = requireAccount(alias);
  store.accounts = store.accounts.filter((a) => a.alias.toLowerCase() !== acc.alias.toLowerCase());
  if (store.defaultAlias?.toLowerCase() === acc.alias.toLowerCase()) {
    store.defaultAlias = store.accounts[0]?.alias;
  }
  writeStore(store);
  return acc;
}

/** 设置默认账号 */
export function setDefaultAccount(alias: string): MpAccount {
  const acc = requireAccount(alias);
  const store = readStore();
  store.defaultAlias = acc.alias;
  writeStore(store);
  return acc;
}

/** secret 脱敏显示：保留前 4 后 4，中间以 * 代替 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(Math.min(secret.length - 8, 8))}${secret.slice(-4)}`;
}

/** 批量导入条目（宽松字段名，兼容 appid/appId/secret/appsecret） */
export interface ImportAccountItem {
  alias: string;
  appId?: string;
  appid?: string;
  secret?: string;
  appsecret?: string;
  name?: string;
}

/**
 * 批量导入：别名重复时跳过（不覆盖），返回新增数与跳过项。
 */
export function importAccounts(items: ImportAccountItem[]): { added: MpAccount[]; skipped: Array<{ alias: string; reason: string }> } {
  const added: MpAccount[] = [];
  const skipped: Array<{ alias: string; reason: string }> = [];
  for (const item of items) {
    const alias = item.alias;
    const appId = item.appId ?? item.appid ?? "";
    const secret = item.secret ?? item.appsecret ?? "";
    try {
      added.push(addAccount({ alias, appId, secret, name: item.name }));
    } catch (err) {
      skipped.push({ alias: String(alias ?? ""), reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { added, skipped };
}

/** 删除账号在 token 缓存中的对应条目 */
export function removeTokenCacheFor(appId: string): void {
  const path = join(getMd2mpHome(), "token-cache.json");
  if (!existsSync(path)) return;
  try {
    const cache = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!(appId in cache)) return;
    delete cache[appId];
    writeFileSync(path, JSON.stringify(cache, null, 2) + "\n", "utf8");
    try { chmodSync(path, 0o600); } catch { /* ignore */ }
  } catch {
    // 缓存损坏时忽略，不影响账号删除
  }
}

/** 账号库文件路径（供提示展示） */
export function accountStorePath(): string {
  return getAccountsPath();
}

/** 仅用于测试的清理入口 */
export function clearStoreForTest(): void {
  const path = getAccountsPath();
  if (existsSync(path)) unlinkSync(path);
}
