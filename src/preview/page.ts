import type { Frontmatter, ImageStats, ImageMode, LintIssue } from "../types";
import { COPY_SCRIPT } from "./copy";

export interface PreviewPageOptions {
  articleHtml: string;
  lint: LintIssue[];
  meta: Frontmatter & { title: string; digest: string };
  imageStats: ImageStats;
  variables: Record<string, string>;
  presetName?: string;
  templateName?: string;
  imageMode: ImageMode;
  /** watch 模式注入 SSE 重载脚本 */
  watch?: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 生成预览页 HTML（工具栏 + 真实文章 DOM + 警告面板） */
export function generatePreviewHtml(opts: PreviewPageOptions): string {
  const errors = opts.lint.filter((i) => i.level === "error").length;
  const warns = opts.lint.filter((i) => i.level === "warn").length;

  const lintRows = opts.lint.length === 0
    ? '<div class="ok">✓ 未发现兼容性问题</div>'
    : opts.lint.map((i) => `
      <div class="lint-row ${i.level}">
        <span class="badge">${i.ruleId}</span>
        <span class="lvl">${i.level === "error" ? "错误" : "警告"}</span>
        <span class="msg">${escapeHtml(i.message)}</span>
      </div>`).join("");

  const varRows = Object.entries(opts.variables).map(([k, v]) =>
    `<div class="var-row"><code>${escapeHtml(k)}</code><span>${escapeHtml(v)}</span></div>`).join("");

  const watchScript = opts.watch
    ? `<script>(function(){var s=new EventSource('/__events');s.addEventListener('reload',function(){location.reload();});})();</script>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>预览 · ${escapeHtml(opts.meta.title)}</title>
<style>
  body{margin:0;background:#eef0f3;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#222;}
  .toolbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;padding:12px 20px;background:#fff;border-bottom:1px solid #e3e5e8;box-shadow:0 1px 4px rgba(0,0,0,.04);flex-wrap:wrap;}
  .toolbar h1{font-size:15px;margin:0 8px 0 0;font-weight:600;color:#333;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  button{cursor:pointer;border:0;border-radius:5px;padding:8px 16px;font-size:13px;font-weight:600;}
  .primary{background:#576b95;color:#fff;} .primary:hover{background:#45567a;}
  .ghost{background:#f0f2f5;color:#444;} .ghost:hover{background:#e4e7eb;}
  .meta{font-size:12px;color:#888;}
  .badge-count{font-size:12px;padding:3px 9px;border-radius:10px;background:#f0f2f5;color:#555;}
  .badge-count.err{background:#fdeaea;color:#c0392b;} .badge-count.warn{background:#fff5e0;color:#b8860b;}
  .layout{display:flex;gap:20px;max-width:1180px;margin:20px auto;padding:0 16px;align-items:flex-start;flex-wrap:wrap;}
  .paper{flex:1 1 560px;min-width:320px;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.06);padding:28px 30px;}
  .side{flex:0 1 320px;background:#fff;border-radius:6px;box-shadow:0 1px 6px rgba(0,0,0,.06);padding:18px 20px;font-size:13px;}
  .side h2{font-size:14px;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid #eee;color:#333;}
  .side h2 button{padding:2px 8px;font-size:11px;}
  .lint-row{padding:8px 0;border-bottom:1px dashed #eee;line-height:1.5;}
  .lint-row .badge{display:inline-block;font-size:11px;background:#eee;border-radius:3px;padding:1px 5px;margin-right:6px;color:#555;}
  .lint-row .lvl{font-size:11px;margin-right:6px;} .lint-row.error .lvl{color:#c0392b;} .lint-row.warn .lvl{color:#b8860b;}
  .lint-row .msg{color:#555;}
  .ok{color:#2e8b57;padding:8px 0;}
  .var-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #eee;}
  .var-row code{font-size:12px;color:#576b95;} .var-row span{color:#666;font-size:12px;}
  .section{margin-top:18px;} .collapsed{display:none;}
  #__md2mp_article img{max-width:100%;}
  #__md2mp_toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%) translateY(20px);background:#333;color:#fff;padding:10px 22px;border-radius:6px;opacity:0;transition:.25s;pointer-events:none;font-size:13px;z-index:99;}
  #__md2mp_toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
  @media(max-width:820px){.side{order:-1;flex:1 1 100%;}}
</style>
</head>
<body>
<div class="toolbar">
  <h1>${escapeHtml(opts.meta.title)}</h1>
  <button class="primary" id="__md2mp_copy">一键复制</button>
  <button class="ghost" id="__md2mp_copy_text">复制纯文本</button>
  <span class="meta">${escapeHtml(opts.templateName ?? "模板")} · ${opts.imageMode} 模式 · 图片 ${opts.imageStats.total} 张</span>
  <span class="badge-count ${errors ? "err" : warns ? "warn" : ""}" id="__md2mp_lint_toggle">${errors ? errors + " 错误" : ""}${errors && warns ? " / " : ""}${warns ? warns + " 警告" : ""}${!errors && !warns ? "无问题" : ""}</span>
</div>
<div class="layout">
  <div class="paper"><div id="__md2mp_article">${opts.articleHtml}</div></div>
  <div class="side">
    <h2>兼容性检查 <button class="ghost" id="__md2mp_lint_toggle2">折叠</button></h2>
    <div id="__md2mp_warnings">${lintRows}</div>
    <div class="section">
      <h2>模板变量${opts.presetName ? " · 预设：" + escapeHtml(opts.presetName) : ""}</h2>
      ${varRows || '<div class="meta">无</div>'}
    </div>
    <div class="section">
      <h2>图片统计</h2>
      <div class="meta">上传 ${opts.imageStats.uploaded} · 内嵌 ${opts.imageStats.embedded} · 外链 ${opts.imageStats.linked}${opts.imageStats.degraded ? " · 降级 " + opts.imageStats.degraded : ""}${opts.imageStats.failed ? " · 失败 " + opts.imageStats.failed : ""}</div>
    </div>
  </div>
</div>
<div id="__md2mp_toast"></div>
<script>${COPY_SCRIPT}</script>
<script>(function(){var a=byId('__md2mp_lint_toggle2');if(a)a.addEventListener('click',function(){var p=byId('__md2mp_warnings');if(p)p.classList.toggle('collapsed');});function byId(id){return document.getElementById(id);}})();</script>
${watchScript}
</body>
</html>`;
}
