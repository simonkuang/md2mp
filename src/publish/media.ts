import { Md2mpError, Errors } from "../cli/errors";
import { mapWechatError } from "./token";

const MEDIA_UPLOADIMG = "https://api.weixin.qq.com/cgi-bin/media/uploadimg";
const MATERIAL_ADD = "https://api.weixin.qq.com/cgi-bin/material/add_material";

/** 构造 multipart/form-data 请求体（纯 JS，无额外依赖） */
function multipart(fields: Record<string, string>, fileField: string, filename: string, bytes: Uint8Array): { body: Blob; contentType: string } {
  const boundary = `----md2mpboundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts: BlobPart[] = [];
  const enc = new TextEncoder();

  for (const [k, v] of Object.entries(fields)) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(bytes as BlobPart);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

  return { body: new Blob(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 限频/网络重试包装（指数退避，最多 3 次） */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 业务错误（凭据/权限）不重试
      if (err instanceof Md2mpError && [6, 5].includes(err.exitCode) && /权限|IP|凭据|40001|48001|40164/.test(err.message)) {
        throw err;
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

/**
 * 上传单张图片到微信图床（uploadimg），返回 URL。
 */
export async function uploadImage(token: string, bytes: Uint8Array, filename: string): Promise<string> {
  return withRetry(async () => {
    const { body, contentType } = multipart({ access_token: "" }, "media", filename, bytes);
    // access_token 走 query，避免放 form（部分实现要求 query）
    const url = `${MEDIA_UPLOADIMG}?access_token=${encodeURIComponent(token)}`;
    let json: { url?: string; errcode?: number; errmsg?: string };
    try {
      const resp = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body });
      json = await resp.json();
    } catch (err) {
      throw Errors.network("图片上传网络请求失败", err instanceof Error ? err.message : String(err), "请检查网络后重试。");
    }
    if (json.errcode || !json.url) {
      throw mapWechatError(json.errcode, json.errmsg ?? "未返回 url", "上传图片");
    }
    return json.url;
  });
}

/**
 * 并发上传图片（并发度 5），保持输入顺序。
 */
export async function uploadImages(
  token: string,
  items: Array<{ bytes: Uint8Array; filename: string }>,
  concurrency = 5,
): Promise<string[]> {
  const results: string[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await uploadImage(token, items[i]!.bytes, items[i]!.filename);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 上传封面到素材库（返回 thumb_media_id）。
 */
export async function uploadCover(token: string, bytes: Uint8Array, filename: string): Promise<string> {
  const { body, contentType } = multipart({ access_token: "" }, "media", filename, bytes);
  const url = `${MATERIAL_ADD}?access_token=${encodeURIComponent(token)}&type=image`;
  let json: { media_id?: string; errcode?: number; errmsg?: string };
  try {
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body });
    json = await resp.json();
  } catch (err) {
    throw Errors.network("封面上传网络请求失败", err instanceof Error ? err.message : String(err), "请检查网络后重试。");
  }
  if (json.errcode || !json.media_id) {
    throw mapWechatError(json.errcode, json.errmsg ?? "未返回 media_id", "上传封面素材");
  }
  return json.media_id;
}
