import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MpAccount } from "../types";
import {
  addAccount, listAccounts, requireAccount, updateAccount, removeAccount, setDefaultAccount,
  importAccounts, maskSecret, accountStorePath, removeTokenCacheFor, readStore,
  type ImportAccountItem,
} from "../account/store";
import { Errors } from "./errors";
import { handleError } from "./common";

/** 账号脱敏后的展示对象 */
function present(acc: MpAccount, showSecret = false) {
  return {
    alias: acc.alias,
    name: acc.name ?? "",
    appId: acc.appId,
    secret: showSecret ? acc.secret : maskSecret(acc.secret),
    isDefault: false, // 由调用方填充
  };
}

function fillDefault<T extends { alias: string; isDefault: boolean }>(rows: T[], defaultAlias?: string): void {
  for (const row of rows) row.isDefault = row.alias.toLowerCase() === (defaultAlias ?? "").toLowerCase();
}

/** 注册 account 子命令树 */
export function registerAccountCommand(program: Command): void {
  const account = program.command("account").description("管理多个公众号：导入/查看/修改/删除/指定默认");

  /** add：导入单个账号 */
  account.command("add")
    .description("添加一个公众号（appid + appsecret）")
    .argument("<alias>", "账号别名，如 company-a")
    .requiredOption("--appid <id>", "公众号 AppID")
    .requiredOption("--secret <secret>", "公众号 AppSecret")
    .option("-n, --name <name>", "公众号名称备注")
    .option("-d, --default", "设为默认公众号")
    .option("--json", "结构化输出")
    .action((alias: string, opts: Record<string, unknown>) => {
      try {
        const acc = addAccount({
          alias,
          appId: opts.appid as string,
          secret: opts.secret as string,
          name: opts.name as string | undefined,
          setDefault: opts.default as boolean | undefined,
        });
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, account: present(acc, true) }, null, 2));
        } else {
          console.log(`✓ 已添加公众号：${acc.alias}${acc.name ? `（${acc.name}）` : ""}`);
          console.log(`  AppID：${acc.appId}`);
          console.log(`  存储位置：${accountStorePath()}`);
          console.log(`  推送时指定：md2mp publish article.md --account ${acc.alias}`);
        }
      } catch (err) { handleError(err); }
    });

  /** import：批量导入 JSON 文件 */
  account.command("import")
    .description("从 JSON 文件批量导入公众号（已有别名跳过）")
    .argument("<file.json>", "JSON 文件，数组或 { accounts: [...] }")
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
        const obj = raw as { accounts?: unknown[] };
        const items = (Array.isArray(raw) ? raw : Array.isArray(obj.accounts) ? obj.accounts : null) as ImportAccountItem[] | null;
        if (!items) {
          throw Errors.args("导入文件格式错误", "期望顶层为数组或 { accounts: [...] }。", "示例：[{\"alias\":\"a\",\"appid\":\"wx...\",\"secret\":\"...\"}]。");
        }
        const { added, skipped } = importAccounts(items);
        if (opts.json) {
          console.log(JSON.stringify({
            ok: true,
            added: added.map((a) => present(a, true)),
            skipped,
          }, null, 2));
        } else {
          console.log(`✓ 导入完成：新增 ${added.length}，跳过 ${skipped.length}`);
          for (const a of added) console.log(`  + ${a.alias}（${a.appId}）`);
          for (const s of skipped) console.log(`  ! 跳过 ${s.alias || "(无别名)"}：${s.reason.split("\n")[0]}`);
        }
      } catch (err) { handleError(err); }
    });

  /** list：查看全部（secret 脱敏） */
  account.command("list")
    .description("列出全部公众号（AppSecret 默认脱敏）")
    .option("--show-secret", "显示完整 AppSecret（注意屏幕隐私）")
    .option("--json", "结构化输出")
    .action((opts: Record<string, unknown>) => {
      try {
        const accounts = listAccounts();
        const defaultAlias = readStore().defaultAlias;
        const rows = accounts.map((a) => present(a, opts.showSecret as boolean | undefined));
        fillDefault(rows, defaultAlias);
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, accounts: rows, defaultAlias: defaultAlias ?? null }, null, 2));
          return;
        }
        if (accounts.length === 0) {
          console.log("暂无已保存的公众号。用 `md2mp account add <别名> --appid <id> --secret <secret>` 添加。");
          return;
        }
        console.log(`已保存 ${accounts.length} 个公众号（默认：${defaultAlias ?? "未设置"}）：\n`);
        for (const r of rows) {
          console.log(`  ${r.isDefault ? "*" : " "} ${r.alias}${r.name ? `  ${r.name}` : ""}`);
          console.log(`      appid:  ${r.appId}`);
          console.log(`      secret: ${r.secret}`);
        }
        console.log(`\n  存储位置：${accountStorePath()}`);
      } catch (err) { handleError(err); }
    });

  /** show：查看单个 */
  account.command("show")
    .description("查看单个公众号详情")
    .argument("<alias>", "账号别名")
    .option("--show-secret", "显示完整 AppSecret")
    .option("--json", "结构化输出")
    .action((alias: string, opts: Record<string, unknown>) => {
      try {
        const acc = requireAccount(alias);
        const row = present(acc, opts.showSecret as boolean | undefined);
        fillDefault([row], readStore().defaultAlias);
        if (opts.json) console.log(JSON.stringify({ ok: true, account: row }, null, 2));
        else console.log(`别名：${row.alias}\n名称：${row.name || "(未设置)"}\nAppID：${row.appId}\nAppSecret：${row.secret}\n默认：${row.isDefault ? "是" : "否"}`);
      } catch (err) { handleError(err); }
    });

  /** update：修改 */
  account.command("update")
    .description("修改公众号（可改别名/名称/appid/appsecret）")
    .argument("<alias>", "原别名")
    .option("--alias <new>", "新别名")
    .option("-n, --name <name>", "新名称（传空字符串可清除）")
    .option("--appid <id>", "新 AppID")
    .option("--secret <secret>", "新 AppSecret")
    .option("--json", "结构化输出")
    .action((alias: string, opts: Record<string, unknown>) => {
      try {
        const hasPatch = ["alias", "name", "appid", "secret"].some((k) => opts[k] !== undefined);
        if (!hasPatch) throw Errors.args("未指定要修改的字段", "update 需要至少一个修改项。", "例如：md2mp account update a --secret 新密钥。");
        const updated = updateAccount(alias, {
          alias: opts.alias as string | undefined,
          name: opts.name as string | undefined,
          appId: opts.appid as string | undefined,
          secret: opts.secret as string | undefined,
        });
        if (opts.json) console.log(JSON.stringify({ ok: true, account: present(updated, true) }, null, 2));
        else console.log(`✓ 已更新公众号：${updated.alias}（${updated.appId}）`);
      } catch (err) { handleError(err); }
    });

  /** remove：删除（同时清理该 appid 的 token 缓存） */
  account.command("remove")
    .description("删除公众号（同时清理其 access_token 缓存）")
    .alias("delete")
    .argument("<alias>", "账号别名")
    .option("--json", "结构化输出")
    .action((alias: string, opts: Record<string, unknown>) => {
      try {
        const acc = requireAccount(alias);
        removeAccount(alias);
        removeTokenCacheFor(acc.appId);
        if (opts.json) console.log(JSON.stringify({ ok: true, removed: { alias: acc.alias, appId: acc.appId } }, null, 2));
        else console.log(`✓ 已删除公众号：${acc.alias}（${acc.appId}），其 token 缓存已清理。`);
      } catch (err) { handleError(err); }
    });

  /** default：设置默认公众号 */
  account.command("default")
    .description("设置默认公众号（未指定 --account 时使用）")
    .argument("<alias>", "账号别名")
    .option("--json", "结构化输出")
    .action((alias: string, opts: Record<string, unknown>) => {
      try {
        const acc = setDefaultAccount(alias);
        if (opts.json) console.log(JSON.stringify({ ok: true, defaultAlias: acc.alias }, null, 2));
        else console.log(`✓ 默认公众号已设为：${acc.alias}（${acc.appId}）`);
      } catch (err) { handleError(err); }
    });
}
