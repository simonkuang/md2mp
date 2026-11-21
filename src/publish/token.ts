import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Md2mpError, Errors } from "../cli/errors";

const CACHE_FILE = join(homedir(), ".md2mp", "token-cache.json");
const TOKEN_API = "https://api.weixin.qq.com/cgi-bin/token";

interface TokenCache {
  [appId: string]: { access_token: string; expires_at: number };
}

export interface Credentials {
  appId: string;
  secret: string;
}

function readCache(): TokenCache {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8")) as TokenCache;
  } catch {
    return {};
  }
}

function writeCache(cache: TokenCache): void {
  mkdirSync(join(homedir(), ".md2mp"), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  // access_token 属敏感凭据，仅当前用户可读写（非 POSIX 平台忽略）
  try { chmodSync(CACHE_FILE, 0o600); } catch { /* ignore */ }
}

/** 校验凭据存在 */
export function requireCredentials(appId?: string, secret?: string): Credentials {
  if (!appId || !secret) {
    throw Errors.credential(
      "未配置公众号凭据（MP_APPID / MP_SECRET）",
      "upload/publish 模式需要凭据换取 access_token。",
      "请用 `md2mp account add <别名> --appid <id> --secret <secret>` 保存账号后用 --account 指定，或 export 环境变量，或改用 --image-mode data 离线渲染。",
    );
  }
  return { appId, secret };
}

/**
 * 获取 access_token（缓存优先，提前 5 分钟刷新）。
 */
export async function getAccessToken(cred: Credentials): Promise<string> {
  const cache = readCache();
  const entry = cache[cred.appId];
  const now = Date.now();
  if (entry && entry.expires_at > now + 5 * 60 * 1000) {
    return entry.access_token;
  }

  const url = `${TOKEN_API}?grant_type=client_credential&appid=${encodeURIComponent(cred.appId)}&secret=${encodeURIComponent(cred.secret)}`;
  let json: { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
  try {
    const resp = await fetch(url);
    json = await resp.json();
  } catch (err) {
    throw Errors.network(
      "获取 access_token 网络请求失败",
      err instanceof Error ? err.message : String(err),
      "请检查网络连接后重试。",
    );
  }

  if (json.errcode || !json.access_token) {
    throw mapWechatError(json.errcode, json.errmsg ?? "未知错误", "获取 access_token");
  }

  cache[cred.appId] = {
    access_token: json.access_token,
    expires_at: now + (json.expires_in ?? 7200) * 1000,
  };
  writeCache(cache);
  return json.access_token;
}

/** 微信错误码 → 可读错误 */
export function mapWechatError(errcode: number | undefined, errmsg: string, action: string): Md2mpError {
  switch (errcode) {
    case 40164:
      return Errors.network(
        `${action}失败：调用方 IP 未在公众号白名单（错误码 40164）`,
        errmsg,
        "请到公众号后台『基本配置 → IP 白名单』添加本机公网 IP 后重试。",
      );
    case 40001:
    case 40125:
    case 41001:
      return Errors.credential(
        `${action}失败：access_token 无效或凭据错误（错误码 ${errcode}）`,
        errmsg,
        "请检查 MP_APPID / MP_SECRET 是否正确，删除 ~/.md2mp/token-cache.json 后重试。",
      );
    case 45009:
      return Errors.network(
        `${action}失败：接口调用超过限额（错误码 45009）`,
        errmsg,
        "请稍后重试或检查公众号接口配额。",
      );
    case 48001:
      return Errors.credential(
        `${action}失败：公众号无此接口权限（错误码 48001）`,
        errmsg,
        "未认证订阅号通常无素材/草稿 API 权限；请改用认证服务号，或改用 --image-mode data 手动复制。",
      );
    default:
      return Errors.network(
        `${action}失败（错误码 ${errcode ?? "?"}）：${errmsg}`,
        errmsg,
        "请以微信官方文档错误码说明为准，检查参数后重试。",
      );
  }
}

/** 权限探测：GET draft/count */
export async function checkDraftPermission(token: string): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.weixin.qq.com/cgi-bin/draft/count?access_token=${encodeURIComponent(token)}`);
    const json = await resp.json();
    if (json.errcode === 48001) return false;
    if (json.errcode) throw mapWechatError(json.errcode, json.errmsg ?? "", "探测草稿箱权限");
    return true;
  } catch (err) {
    if (err instanceof Md2mpError) throw err;
    return false;
  }
}
