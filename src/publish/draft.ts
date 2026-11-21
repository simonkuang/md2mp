import type { Frontmatter } from "../types";
import { Errors } from "../cli/errors";
import { mapWechatError } from "./token";

const DRAFT_ADD = "https://api.weixin.qq.com/cgi-bin/draft/add";

export interface DraftArticle {
  title: string;
  author?: string;
  digest?: string;
  content: string;
  thumb_media_id?: string;
  need_open_comment?: 0 | 1;
  only_fans_can_comment?: 0 | 1;
}

export interface DraftResult {
  draftId: string;
  mpUrl: string;
}

/** 写入草稿箱，返回 draft_id 与后台链接 */
export async function addDraft(token: string, article: DraftArticle): Promise<DraftResult> {
  // 长度裁剪（微信限制：标题 ≤64 字、摘要 ≤120 字）
  const title = Array.from(article.title).slice(0, 64).join("");
  const digest = article.digest ? Array.from(article.digest).slice(0, 120).join("") : undefined;

  const payload = {
    articles: [{
      title,
      author: article.author ?? "",
      digest: digest ?? "",
      content: article.content,
      thumb_media_id: article.thumb_media_id ?? "",
      need_open_comment: article.need_open_comment ?? 0,
      only_fans_can_comment: article.only_fans_can_comment ?? 0,
    }],
  };

  let json: { media_id?: string; errcode?: number; errmsg?: string };
  try {
    const resp = await fetch(`${DRAFT_ADD}?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    json = await resp.json();
  } catch (err) {
    throw Errors.network("写入草稿箱网络请求失败", err instanceof Error ? err.message : String(err), "请检查网络后重试。");
  }

  if (json.errcode || !json.media_id) {
    throw mapWechatError(json.errcode, json.errmsg ?? "未返回 media_id", "写入草稿箱");
  }

  return {
    draftId: json.media_id,
    mpUrl: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
  };
}

export function buildDraftArticle(
  meta: Frontmatter & { title: string; digest: string },
  content: string,
  thumbMediaId?: string,
): DraftArticle {
  return {
    title: meta.title,
    author: typeof meta.author === "string" ? meta.author : "",
    digest: meta.digest,
    content,
    thumb_media_id: thumbMediaId,
  };
}
