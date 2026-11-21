import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAccount, listAccounts, findAccount, requireAccount, updateAccount, removeAccount,
  setDefaultAccount, getDefaultAccount, maskSecret, importAccounts, readStore, clearStoreForTest,
} from "../src/account/store";
import { resolveCredentials } from "../src/config";

let home: string;
const savedAppId = process.env.MP_APPID;
const savedSecret = process.env.MP_SECRET;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "md2mp-account-test-"));
  process.env.MD2MP_HOME = home;
  delete process.env.MP_APPID;
  delete process.env.MP_SECRET;
});

afterEach(() => {
  clearStoreForTest();
  rmSync(home, { recursive: true, force: true });
  if (savedAppId === undefined) delete process.env.MP_APPID; else process.env.MP_APPID = savedAppId;
  if (savedSecret === undefined) delete process.env.MP_SECRET; else process.env.MP_SECRET = savedSecret;
});

describe("账号库 CRUD", () => {
  it("新增/查找/列出现有账号", () => {
    addAccount({ alias: "a", appId: "wxA", secret: "secretA1234", name: "公众号A" });
    addAccount({ alias: "b", appId: "wxB", secret: "secretB1234" });
    expect(listAccounts().length).toBe(2);
    expect(findAccount("A")?.appId).toBe("wxA"); // 大小写不敏感
    expect(requireAccount("b").secret).toBe("secretB1234");
  });

  it("首个账号自动成为默认，可切换", () => {
    addAccount({ alias: "a", appId: "wxA", secret: "secretA1234" });
    addAccount({ alias: "b", appId: "wxB", secret: "secretB1234" });
    expect(getDefaultAccount()?.alias).toBe("a");
    setDefaultAccount("b");
    expect(getDefaultAccount()?.alias).toBe("b");
  });

  it("别名重复时报错", () => {
    addAccount({ alias: "a", appId: "wxA", secret: "secretA1234" });
    expect(() => addAccount({ alias: "A", appId: "wxB", secret: "secretB1234" })).toThrow(/已存在/);
  });

  it("非法别名报错", () => {
    expect(() => addAccount({ alias: "bad alias!", appId: "wxA", secret: "s" })).toThrow(/不合法/);
  });

  it("修改别名会同步默认账号别名", () => {
    addAccount({ alias: "a", appId: "wxA", secret: "secretA1234" });
    const updated = updateAccount("a", { alias: "a2", secret: "newSecret1234" });
    expect(updated.alias).toBe("a2");
    expect(updated.secret).toBe("newSecret1234");
    expect(getDefaultAccount()?.alias).toBe("a2");
  });

  it("删除账号并在删默认时重指", () => {
    addAccount({ alias: "a", appId: "wxA", secret: "secretA1234" });
    addAccount({ alias: "b", appId: "wxB", secret: "secretB1234" });
    removeAccount("a");
    expect(listAccounts().length).toBe(1);
    expect(getDefaultAccount()?.alias).toBe("b");
    expect(() => requireAccount("a")).toThrow(/未找到/);
  });

  it("secret 脱敏", () => {
    expect(maskSecret("secret1234567890")).toBe("secr********7890");
    expect(maskSecret("short")).toBe("*****");
  });

  it("批量导入：宽松字段名 + 跳过重复", () => {
    addAccount({ alias: "exists", appId: "wxE", secret: "secretE1234" });
    const r = importAccounts([
      { alias: "x", appid: "wxX", secret: "secretX1234" },
      { alias: "y", appId: "wxY", appsecret: "secretY1234" },
      { alias: "exists", appid: "wxZ", secret: "secretZ1234" },
    ]);
    expect(r.added.length).toBe(2);
    expect(r.skipped.length).toBe(1);
    expect(findAccount("y")?.appId).toBe("wxY");
  });
});

describe("凭据解析优先级", () => {
  it("--account 指定账号 > 其他一切", () => {
    addAccount({ alias: "a", appId: "wxA", secret: "secretA1234" });
    process.env.MP_APPID = "wxENV";
    process.env.MP_SECRET = "envsec";
    const r = resolveCredentials({ appId: "wxRC", secret: "rcsec" }, "a");
    expect(r.source).toBe("account-flag");
    expect(r.appId).toBe("wxA");
    expect(r.alias).toBe("a");
  });

  it("--account 指定不存在的账号直接报错", () => {
    expect(() => resolveCredentials({}, "missing")).toThrow(/未找到公众号账号/);
  });

  it("环境变量 > rc > 默认账号", () => {
    addAccount({ alias: "a", appId: "wxA", secret: "secretA1234" });
    process.env.MP_APPID = "wxENV";
    process.env.MP_SECRET = "envsec";
    expect(resolveCredentials({ appId: "wxRC", secret: "rcsec" }).source).toBe("env");
    delete process.env.MP_APPID;
    delete process.env.MP_SECRET;
    expect(resolveCredentials({ appId: "wxRC", secret: "rcsec" }).source).toBe("rc");
    expect(resolveCredentials({}).source).toBe("default-account");
  });

  it("无任何配置返回 none", () => {
    expect(resolveCredentials({}).source).toBe("none");
  });

  it("账号库持久化到 accounts.json（version=1）", () => {
    addAccount({ alias: "a", appId: "wxA", secret: "secretA1234" });
    const store = readStore();
    expect(store.version).toBe(1);
    expect(store.accounts[0]!.alias).toBe("a");
  });
});
