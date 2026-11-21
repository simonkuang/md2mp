import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { Md2mpError } from "../cli/errors";

const DEFAULT_CSS = `/* 主题样式：选择器挂在 #js_article 下，颜色用 var(--x) */
:root {
  --primary: #576b95;
  --text: #3f3f3f;
  --font-size: 16px;
}

#js_article {
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: var(--font-size);
  line-height: 1.75;
  color: var(--text);
}

#js_article h2 { font-size: 1.35em; color: var(--primary); font-weight: 700; }
#js_article p { margin: 0 0 1em; }
#js_article blockquote { border-left: 4px solid var(--primary); padding: 12px 16px; background: #f7f8fa; }
#js_article code { background: #f7f8fa; padding: 2px 6px; border-radius: 3px; }
#js_article pre { background: #282c34; color: #abb2bf; padding: 14px 16px; border-radius: 6px; overflow-x: auto; }
#js_article img { max-width: 100%; height: auto; }
`;

/**
 * 初始化模板工程脚手架。
 */
export function scaffoldTemplate(dir: string): { dir: string; files: string[] } {
  const abs = resolve(dir);
  if (existsSync(abs)) {
    throw new Md2mpError(
      `目标目录已存在：${abs}`,
      "template init 需要在一个新目录中创建脚手架。",
      "请换一个目录名，或先移除已存在的目录。",
    );
  }
  mkdirSync(abs, { recursive: true });
  mkdirSync(join(abs, "assets"), { recursive: true });

  const id = basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-theme";
  const manifest = {
    schemaVersion: 1,
    id,
    name: id,
    version: "1.0.0",
    author: "",
    description: "我的 md2mp 主题",
    compat: { cli: ">=0.1.0" },
    entry: { css: "theme.css" },
    variables: [
      { key: "--primary", label: "主题色", type: "color", default: "#576b95" },
      { key: "--text", label: "正文色", type: "color", default: "#3f3f3f" },
      { key: "--font-size", label: "正文字号", type: "length", default: "16px" },
    ],
    typography: { autoSpacing: true, codeIndentPreserve: true, taskListGlyph: true, hr: "plain" },
    highlight: { enable: true },
  };

  const files = ["manifest.json", "theme.css", "README.md"];
  writeFileSync(join(abs, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  writeFileSync(join(abs, "theme.css"), DEFAULT_CSS, "utf8");
  writeFileSync(join(abs, "README.md"), `# ${manifest.name}\n\nmd2mp 模板工程。编辑 theme.css 后运行：\n\n\`\`\`bash\nmd2mp template pack .\n\`\`\`\n`, "utf8");

  return { dir: abs, files };
}
