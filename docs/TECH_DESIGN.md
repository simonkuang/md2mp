# md2mp 技术设计文档（TECH DESIGN）

| 项目 | 内容 |
| --- | --- |
| 版本 | 0.2 |
| 日期 | 2026-11-21 |
| 状态 | 与 0.2.x 实现一致 |
| 关联文档 | [PRD.md](./PRD.md) · [HISTORY.md](./HISTORY.md) |

---

## 1. 设计原则

1. **白名单即边界**：公众号编辑器会剥离 `<style>`/`<script>`/`class`/`id`，所有样式能力必须在渲染期收敛为元素内联 `style`；模板作者写的是「普通 CSS」，产物永远是「内联样式 HTML」。
2. **确定性输出**：渲染管线无时间戳、无随机数、排序稳定，同输入逐字节同输出（快照测试与 CI diff 的前提）。
3. **纯 JS 依赖**：所有依赖必须是纯 JS（无原生模块、无 WASM），保证 `bun build --compile` 单文件编译的兼容性。
4. **最小惊讶**：凭据缺失、模板非法、网络失败等一切失败路径给出「现象 → 原因 → 建议」三段式错误；绝不静默降级。

## 2. 总体架构

```
                    ┌────────────────────────────────────────────────────┐
  article.md ─────► │                    md2mp CLI (bun)                 │
  theme.zip  ─────► │  ┌──────────┐     ┌─────────────────────────────┐  │
  .md2mprc   ─────► │  │ 命令层    │ ──► │          渲染管线 core       │  │ ──► article.html
  env: MP_APPID     │  │ commander │     │  frontmatter → markdown-it  │  │ ──► preview.html
                    │  └──────────┘     │  → cheerio DOM → 资源/高亮   │  │ ──► lint 报告
                    │        │          │  → mpcss 内联 → 白名单清洗    │  │
                    │        │          └─────────────────────────────┘  │
                    │        ▼                                          │
                    │  ┌──────────────────┐    ┌─────────────────────┐  │
                    │  │ 模板系统 template  │    │ 公众号通道 publish   │ ─┼─► 草稿箱
                    │  │ loader/schema/    │    │ token/uploadimg/    │  │
                    │  │ pack/lint/scaffold│    │ draft               │  │
                    │  └──────────────────┘    └─────────────────────┘  │
                    └────────────────────────────────────────────────────┘
```

模块分层：

- `cli/`：命令注册、参数解析、退出码、`--json` 输出；
- `core/`：渲染管线（无 IO 副作用的部分做成纯函数，便于测试）；
- `template/`：ZIP 解包、manifest 校验、打包、lint、脚手架、注册中心、内置主题；
- `preview/`：预览页生成、本地服务（`Bun.serve`）、热刷新、复制脚本；
- `publish/`：access_token 管理、素材上传、草稿写入；
- `account/`：多公众号账号库。

## 3. 技术选型

| 领域 | 选型 | 理由 |
| --- | --- | --- |
| 运行时/语言 | Bun ≥ 1.2 + TypeScript | 单工具链（运行、打包、测试）；`bun build --compile` 产出单文件二进制 |
| CLI 框架 | commander | 纯 JS、子命令成熟、体积小 |
| Markdown | markdown-it + markdown-it-footnote / task-lists / container | 插件生态完整，token 流可干预（排版增强需要在 token 层处理） |
| frontmatter | gray-matter | 纯 JS、事实标准 |
| CSS 解析 | postcss（默认 parser 即可，主题 CSS 由工具校验过） | 成熟、可遍历 AST、保留位置信息用于 lint 报错定位 |
| DOM | cheerio（htmlparser2 + css-select） | 纯 JS、选择器匹配/遍历/序列化一体，内联引擎的基础 |
| ZIP | fflate | 纯 JS、同步 API（`unzipSync`/`zipSync`）、无依赖 |
| schema 校验 | zod | manifest 校验 + 错误信息可读（`zod-error` 格式化） |
| 代码高亮 | highlight.js | 纯 JS（shiki 依赖 oniguruma WASM，违反原则 3，见 D3） |
| 本地服务 | `Bun.serve` | 原生、编译后可用、内建静态文件与 SSE |
| 发布通道 | 原生 `fetch` + `Bun.file` | multipart 上传无需额外依赖 |

### 3.1 关键决策

**D1：CSS 内联引擎自研（`mpcss`），而非直接用 juice。**

| | juice（邮件 HTML 内联库） | 自研 mpcss |
| --- | --- | --- |
| CSS 变量预解析 | 需自己在外面做 | 内建（管线第 5 步） |
| 输出确定性 | 依赖内部实现细节 | 完全可控、快照稳定 |
| mp 专用清洗（剥 class/id、伪元素降级、媒体查询丢弃） | 后处理补丁 | 一体化 |
| 代码块缩进、`data:` 图片等 mp 特例 | 不感知 | 一体化 |

选择：**自研约 500 行的核心引擎**（解析 + 匹配 + 合并 + 序列化），算法参考 juice 的级联实现；在 `core/css/` 对外暴露 `inlineStyles(dom, rules, vars)` 单一入口，未来若自研不满足可整层替换。风险由快照测试覆盖（§14）。

**D2：markdown-it 而非 marked / rehype。** 需要插件生态（脚注、任务列表、container）与 token 层干预能力；marked 插件少，rehype 链路（unified）灵活但复杂度与依赖面更大。

**D3：highlight.js 而非 shiki。** shiki 渲染保真度更高，但依赖 Oniguruma WASM；`bun build --compile` 嵌入 WASM 可行但增加跨平台与体积风险。v1 选 highlight.js，core 版本按固定顺序注册 16 种常用语言（含别名），未支持语言保留纯文本；高亮主题色由模板 CSS 的 `.hljs-*` 规则提供并随内联引擎写入 span，保证「代码高亮色 = 模板的一部分」。

**D4：fflate 而非 jszip。** 同步 API 更贴合 CLI 流程，体积约为 jszip 的 1/10。

## 4. 模板包规范 v1

### 4.1 目录结构（打包前的工程目录 = ZIP 内容）

```
my-theme/
├── manifest.json        # 必需
├── theme.css            # 必需（entry.css 指向）
├── preview.js           # 可选（entry.previewJs）
├── preview.html         # 可选（entry.previewHtml，P2/F18 生效）
├── assets/              # 任意子目录
│   ├── header.png
│   └── qrcode.png
└── README.md            # 可选，纯展示
```

约束：单文件 ≤ 5 MB；解压总大小 ≤ 20 MB；条目数 ≤ 500；仅接受扩展名 `json/css/js/html/png/jpg/jpeg/gif/svg/webp/woff/woff2/ttf/md/txt`（白名单校验，防可执行文件混入）。

### 4.2 manifest.json schema（zod 定义，v1）

```jsonc
{
  "schemaVersion": 1,
  "id": "aurora",                        // kebab-case，全局唯一
  "name": "Aurora 主题",
  "version": "1.2.0",                    // semver
  "author": "xxx",
  "description": "蓝紫渐变、适合技术文章",
  "license": "MIT",
  "compat": { "cli": ">=0.3.0" },        // semver range，loader 校验
  "entry": {
    "css": "theme.css",                  // 必需
    "previewJs": "preview.js",           // 可选
    "previewHtml": "preview.html"        // 可选
  },
  "variables": [                         // 暴露给使用者的「主题旋钮」
    { "key": "--primary",  "label": "主色",   "type": "color", "default": "#576b95" },
    { "key": "--font-size", "label": "正文字号", "type": "length", "default": "15px" }
  ],
  "presets": [                           // 变量预设包（主题变体），presets[0] 为默认
    { "name": "庄重", "variables": { "--primary": "#1f3a5f" } },
    { "name": "素净", "variables": { "--primary": "#2f6b5e" } }
  ],
  "assets": [                            // 注册资源，获得 asset://name 引用资格
    { "name": "header",  "file": "assets/header.png" },
    { "name": "qrcode",  "file": "assets/qrcode.png" }
  ],
  "inject": {                            // 页头/页脚注入，支持占位符
    "articleHead": "<img src=\"{{asset:header}}\" style=\"width:100%\"/>",
    "articleFoot": "<p style=\"text-align:center\"><img src=\"{{asset:qrcode}}\" width=\"120\"/></p>"
  },
  "typography": {
    "autoSpacing": true,                 // 中英文之间加空格
    "codeIndentPreserve": true,          // pre 前导空格转 &nbsp;
    "taskListGlyph": true,               // 任务列表转 ☑/☐
    "headingNumbering": true,            // h2→「一、」h3→「（一）」h4→「1. 」，编号写入 .mp-h-num
    "hr": "diamond",                     // 分割线形态：plain | diamond（线—菱形—线真实节点）| none
    "figureCaption": true,               // 单图段落 → figure.mp-photo；「图：」段落 → figcaption
    "tableZebra": true                   // 表格偶数行加 mp-alt 类（规避 :nth-child）
  },
  "markdown": { "breaks": true },        // 单换行转 <br>（中文写作习惯）
  "highlight": { "enable": true },
  "publish": { "coverDefault": "header", "autoDigest": true }
}
```

字段规则：

- `variables[].key` 必须以 `--` 开头（CSS 自定义属性语义）；`type ∈ color|length|text|enum`，`enum` 需带 `options`；
- `presets[].name` 在包内唯一；preset 变量覆盖 manifest 默认值，用户 `-V` 再覆盖单项；
- `typography.hr` / `figureCaption` / `tableZebra` / `headingNumbering` 生成的 DOM 变换（编号 span、分割线节点等）在管线第 4 步（DOM 后处理）完成，均在 CSS 内联之前，同样被内联化；
- `assets[].name` 在包内唯一；`file` 必须存在且扩展名在白名单内；
- 占位符：`{{asset:name}}`（渲染为 data URL 或上传后 URL）、`{{title}}`/`{{author}}`/`{{digest}}`（frontmatter）；
- 未声明的占位符 → pack/lint 报错；未知顶层字段 → lint 警告（前向兼容）。

### 4.3 theme.css 约定

- 选择器一律挂在 `#js_article`（渲染根节点固定 id，输出前剥除）下，如 `#js_article p`、`#js_article blockquote code`；
- 允许：任意元素/类选择器（markdown-it 输出的语义标签与插件类名）、`:first-child`/`:nth-child(n)`/`:not()` 等结构伪类；
- 禁止（lint 拦截）：`::before/::after`（MP040）、`@media`（MP041，仅移动端单列场景）、`@font-face`（MP042）、`position:fixed`（MP050）、`<script>`/`<style>` 出现在 inject HTML（MP001/MP002）；
- `:root { --x: ... }` 允许，作为变量的低优先级来源（优先级见 §5.5）。

## 5. 渲染管线

`core/pipeline.ts` 编排，10 步：

| # | 步骤 | 输入 → 输出 | 失败行为 |
| --- | --- | --- | --- |
| 1 | 读取与 frontmatter | md 文本 → `Doc{body, meta}` | YAML 语法错误：报错并给出行号 |
| 2 | 模板解包 | zip bytes → `Template{manifest, css, assets[]}`（内存中，不落盘） | 校验失败：退出码 3，zod 错误定位到字段 |
| 3 | Markdown 渲染 | body → HTML 字符串（markdown-it + 插件） | — |
| 4 | DOM 解析 | HTML → cheerio `$`，根节点包裹 `<section id="js_article">`，注入 inject.articleHead/Foot（占位符替换） | — |
| 5 | 资源解析 | 遍历 `img[src]` 与 inject 产物：本地相对路径/`asset://name` → 按 image-mode 转换（见 §7） | 图片缺失/上传失败：报错，文件与行号可定位 |
| 6 | 代码高亮 | `pre>code` → hljs 渲染为带类名的 span 树 | 高亮失败降级为纯文本并警告 |
| 7 | 排版增强 | 文本节点级处理：autoSpacing / codeIndentPreserve / taskListGlyph | — |
| 8 | **CSS 内联（mpcss）** | 解析 theme.css → 变量解析 → 规则匹配与级联 → 每节点写内联 `style` | 规则解析失败：报错并给 CSS 行号 |
| 9 | 白名单清洗 | 剥 `class`/`id`（保留根节点 `id=js_article` 到此步为止）、注释节点、空属性；校验结果无 `<script>/<style>` | 理论不可达，触达即内部错误 |
| 10 | 输出组装 | article 片段 → `article.html`（`--standalone` 加 doctype 包装）；片段 + 工具栏 + lint 结果 → `preview.html` | — |

lint（§9）在 8、9 之间收集规则命中，随 `preview.html` 面板与 `--json` 输出。

### 5.5 变量解析

变量来源优先级（高 → 低）：`-V k=v` > `.md2mprc.json` 的 `variables` > preset（`presets` 命中项）> manifest `variables[].default` > theme.css `:root` 声明。解析发生在规则匹配**之前**：先把全部规则中的 `var(--x[, fallback])` 递归展开（含 fallback；循环检测上限 32 层），无法解析的 `var()` 报 MP044 错误（变量未定义）。

### 5.6 mpcss 内联算法

```
inlineStyles($, rules, vars):
  for rule in rules:                     // 已丢弃 @media/@keyframes/伪元素规则
    rule.specificity = calcSpecificity(rule.selector)   // (a,b,c)，css-select 解析
  for node in $(root).find('*'):
    matched = rules.filter(r => cssSelect.matches(node, r.selector))
    decls = matched.sort(by specificity, then source order)   // 稳定排序
                 .flatMap(r => r.declarations)
    decls = dedupeKeepLast(decls)                             // 后者覆盖前者
    node.attr('style', serialize(decls))                      // 原有 style 视为最低优先级参与合并
```

- `calcSpecificity`：基于 css-select 的选择器 AST 计数 id/class/伪类、元素/伪元素，约 40 行；
- 伪类 `:hover/:focus` 等交互伪类：公众号场景无意义，直接丢弃并 lint 提示（MP043）；
- 序列化顺序：按 CSS 源码声明顺序，保证快照稳定。

## 6. Markdown 扩展

- frontmatter（gray-matter）：`title`（缺失时取首个 h1）、`author`、`cover`（图片路径或 `asset:name`）、`digest`（缺失时正文前 54 字）、`tags`；
- 任务列表：自实现确定性 token 级插件（markdown-it-task-lists 生成随机 id，破坏确定性输出，故弃用），输出 `<input data-checked>`，排版阶段转 `☑` / `☐` 字形（`input` 标签在编辑器不可靠）；
- 删除线：统一渲染为 `<del>`（markdown-it 默认 `<s>`），与模板 CSS 选择器约定一致；
- container（`:::tip` / `:::warning` 等）：渲染为 `<section class="mp-tip">`，样式由模板 CSS 的类选择器提供，manifest 未声明的 container 类名 → lint 警告 MP045；
- 脚注：markdown-it-footnote，样式走模板 CSS；
- 数学/mermaid：P2（F16/F17），入口预留 token 后处理 hook。

## 7. 图片管线

三种 `--image-mode`，**默认 `upload`**（需求确认）：

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `upload` | 调公众号 `media/uploadimg` 上传，替换为返回的微信图床 URL | 有凭据的正式出稿；粘贴最可靠 |
| `data` | 本地图片 → base64 data URL 内嵌 | 无凭据/离线；粘贴转存行为待实测（PRD Q1），UI 明确提示 |
| `link` | 仅解析相对路径，保留原 URL | 图片已在外部图床；lint 警告 MP010 |

处理规则：

1. **凭据**：`MP_APPID`/`MP_SECRET` 环境变量优先，其次 `.md2mprc.json`（读取时打印安全提示）；`upload` 模式无凭据 → 退出码 6，错误信息给出「配置凭据或改用 `--image-mode data`」两个出路；
2. **token 管理**：`~/.md2mp/token-cache.json` 缓存 access_token（含 expires_at），提前 5 分钟刷新；调用方机器 IP 必须加入公众号后台 IP 白名单，40164 错误码映射为「IP 未加白名单，请到后台『基本配置』添加 <本机IP>」；
3. **上传细节**：`POST /cgi-bin/media/uploadimg?access_token=`，multipart/form-data，支持 jpg/png，单图 ≤ 10MB（以官方文档为准）；并发度 5，42929 等限频错误码指数退避重试（≤3 次）；
4. **预览一致性**：preview.html 中 upload 成功的图直接用微信 URL（可本地渲染）；无凭据预览时降级 data URL 并在警告面板说明「与最终粘贴行为可能不一致」；
5. `link` 模式下 `http://` 自动升级为 `https://`。

## 8. 预览页与一键复制

### 8.1 preview.html 结构

```
┌─ 工具栏：[一键复制] [复制纯文本] 图片统计 · lint 摘要（3 警告）
├─ 文章区（真实文章 DOM，含注入的页头页脚，样式已内联）
│    <script type="application/json" id="__md2mp">…文章片段原文、lint 结果…</script>
└─ 警告面板：lint 规则、图片模式提示、模板变量当前值
```

- 文章 DOM 即最终粘贴物，预览即所得；
- 不做手机壳模拟（编辑器内宽度本就自适应），默认容器 677px 居中。

### 8.2 复制策略

| 优先级 | 方案 | 说明 |
| --- | --- | --- |
| 1 | `Selection` + `document.execCommand('copy')` | 对文章 DOM 建立选区后复制，天然携带渲染后的富文本与图片（data URL 与微信 URL 均可），兼容性最好（mdnice 经典方案）；Safari 需在用户手势内同步执行 |
| 2 | `ClipboardItem` 写入 `text/html` | Chrome/Edge 现代路径，作为首选路径失败时的兜底（浏览器探测顺序按实测调整） |

preview.js 来源：模板 `entry.previewJs`（若有）与内置脚本**叠加**，内置脚本负责复制与面板交互；模板 JS 仅用于附加交互（如深色预览切换），**永远不会进入 article.html**。

### 8.3 本地服务（`preview --watch`）

`Bun.serve`：静态输出 + `GET /__events` SSE；文件监听（md/theme.zip/图片）触发重新渲染，SSE 推送 `reload`；重新渲染读取缓存中的模板解包结果（模板文件变更才重解包）。

## 9. lint 规则表

| ID | 级别 | 规则 |
| --- | --- | --- |
| MP001 | error | inject/正文出现 `<script>` |
| MP002 | error | inject/正文出现 `<style>` 标签 |
| MP003 | error | manifest 缺失必需字段 / schema 校验失败 |
| MP004 | warn | class/id 属性残留（清洗兜底检查） |
| MP010 | warn | 外链图片（upload 模式未上传的外链 / link 模式保留的外链与本地路径） |
| MP011 | warn | data URL 单图 > 1MB（HTML 体积膨胀） |
| MP012 | warn | SVG 资源/内联 SVG（编辑器渲染不稳定） |
| MP020 | warn | 非 mp.weixin.qq.com 的 `<a href>` 外链 |
| MP030 | warn | 图片尺寸过大（宽 > 1080px） |
| MP040 | error | CSS 伪元素 `::before/::after` |
| MP041 | error | `@media` 查询 |
| MP042 | error | `@font-face` 外部字体 |
| MP043 | warn | 交互伪类 `:hover/:focus` |
| MP044 | error | `var()` 引用了未定义变量（变量定义内部与规则声明值展开后残留均报告） |
| MP045 | warn | 结构类 `mp-*` 被使用但主题 CSS 无对应样式规则（清洗前检查） |
| MP046 | warn | 代码高亮失败，已降级为纯文本 |
| MP050 | error | `position:fixed` / `position:sticky` |
| MP060 | warn | 表格无边框声明（编辑器中不可读） |

`lint` 命令与 build/preview 面板共用同一规则引擎，`--json` 输出 `{ruleId, level, message, file, line, snippet}[]`。

## 10. 发布通道（F14）

```
publish article.md
  ├─ 渲染管线（image-mode 强制 upload）
  ├─ 封面：frontmatter cover / asset:name / publish.coverDefault
  │        → material/add_material(type=image) → thumb_media_id（uploadimg 只返回 url，不返回 media_id，封面必须走素材接口）
  ├─ POST /cgi-bin/draft/add  articles[{title≤64字, author, digest≤120字, content, thumb_media_id, need_open_comment…}]
  └─ 输出：draft_id + mp 后台草稿箱链接
```

- `--dry-run`：只渲染与上传图片，不写草稿箱，输出将要提交的 JSON；
- 错误码映射表：40007（封面格式）、40125/41001（token 失效 → 刷新重试一次）、40164（IP 白名单）、45009（限频）；
- 未认证账号无素材/草稿 API 权限（PRD Q2）：前置调用 `GET /cgi-bin/draft/count` 探测权限，失败时输出可读解释。

## 11. CLI 实现细节

- commander 子命令树；全局 flag：`--json`（结构化输出，供 CI 消费）、`--quiet`、`--no-color`；
- 退出码（§7.2 PRD）映射为 `process.exit`；所有错误经 `cli/errors.ts` 统一格式化（现象 → 原因 → 建议）；
- 配置加载顺序：CLI > env > `.md2mprc.json`（当前目录向上查找）> manifest 默认 > 内置默认；rc 文件 zod 校验，非法字段警告；
- shell 补全：`__complete` 内部命令（绕过 commander 解析）承载全部补全逻辑——命令树模型 + 值-flag 提供方（模板别名/账号别名/预设/cover/图片模式）；六种 shell 脚本仅收集当前词调用引擎；`completion [shell]` 输出脚本、`completion install [shell]` 幂等挂载（脚本生成器见 `cli/completion-scripts.ts`）。

### 11.1 模板注册中心

- 索引 `~/.md2mp/templates.json`（0600）+ ZIP **副本** `~/.md2mp/templates/<alias>.zip`：注册（`template add/import`，支持 ZIP 或模板工程目录）后运行只依赖副本，源文件可删除；
- 引用优先级：显式路径 > 别名 > `builtin`/`default` 保留字 > 默认注册模板 > 内置模板；
- `template update --file` 替换副本，`template remove` 清理副本，别名大小写不敏感且唯一（`builtin` 为保留字）。

### 11.2 多公众号账号库

- `~/.md2mp/accounts.json`（0600），AppSecret 在输出中默认脱敏；
- 凭据优先级：`--account` > env（`MP_APPID`/`MP_SECRET`）> rc > 默认账号 > 报错；显式 `--account` 不存在直接报错，不静默降级；
- access_token 按 appid 独立缓存于 `~/.md2mp/token-cache.json`（0600），提前 5 分钟刷新。

## 12. 内置默认模板

`themes/default/` 源码随仓库维护；构建脚本将其 zip 后转 base64 生成 `src/template/builtin.ts`（`export const DEFAULT_THEME_ZIP = "<base64>"`）。选 base64 模块而非 Bun 的文件嵌入特性（`with {type:'file'}`），规避 compile 资产加载的版本兼容风险。运行期 loader 对内置模板与 zip 输入走完全相同路径。

## 13. 打包与分发

构建入口 `./release.sh`（一键：清理 → 版本 patch 自增 → 编译 → 安装 → 收尾清理；`--bump=minor/major`、`--no-bump`、`--prefix=<dir>` 可选），内部执行 `build.ts`（`bun run build.ts`，四步）：

```
1. scripts/gen-builtin.ts → themes/default/ 打包为 base64 写入 src/template/builtin.ts
2. bun build --target=bun --minify src/cli.ts → dist/md2mp.js（package.json bin 指向，npm 分发，需 Bun 运行时）
3. bun build --compile --minify --target=<目标> → dist/md2mp-<platform>
4. --install：安装到 ~/.bin（mkdir 自动创建；--prefix 可试验安装到其他目录），安装后自检 --version，
   正式发布自动清理其他 PATH 目录的旧副本（仅清理确认能输出版本号的 md2mp）
```

```
bun build --compile --minify \
  --target bun-darwin-arm64 src/cli.ts --outfile dist/md2mp-darwin-arm64
  # 目标矩阵：darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / windows-x64
```

- GitHub Actions：PR → test/typecheck（三平台矩阵）；tag `v*` → 矩阵交叉编译 → checksums → GitHub Release；
- 二进制预期体积约 85MB（Bun 运行时），Release 说明中注明；`--bytecode` 作为体积优化实验项；
- npm 备选：`dist/md2mp.js` 由 bin 字段指向（要求 Bun 运行时）；主推二进制安装（`./release.sh`）。

## 14. 测试策略

| 层 | 内容 |
| --- | --- |
| 单元测试（bun test） | mpcss（specificity/var/合并/序列化）、frontmatter、占位符替换、zip 校验（zip-slip、超限、白名单） |
| 快照测试 | 精选样例文档（覆盖全部 Markdown 元素 + 插件 + 注入 + 三种 image-mode）× 默认模板，输出逐字节比对 |
| 集成测试 | template pack → loader 往返；preview 服务 SSE；lint 各规则命中 |
| 发布通道 | mock 服务器的错误码映射；凭据缺失路径 |
| 人工清单 | PRD §10.4 发版实测清单（mp 编辑器粘贴、四浏览器复制） |

## 15. 仓库结构

```
md2mp/
├── src/
│   ├── cli/              # cli.ts 入口、common.ts、completion.ts/-scripts.ts、templateRegistry.ts、account.ts、errors.ts
│   ├── core/             # pipeline.ts、markdown.ts、frontmatter.ts、typography.ts、highlight.ts、clean.ts、assets.ts
│   │   └── css/          # parse.ts、vars.ts、cascade.ts、inline.ts（mpcss 内联引擎）
│   ├── template/         # loader.ts、manifest.ts、pack.ts、lint.ts、registry.ts、scaffold.ts、builtin.ts
│   ├── preview/          # page.ts、server.ts、copy.ts
│   ├── publish/          # token.ts、media.ts、draft.ts
│   ├── account/          # store.ts
│   ├── config.ts / types.ts / shims.d.ts
├── themes/default/       # 内置默认模板源（构建期打包进二进制）
├── templates/songmo/     # songmo 模板工程（template pack 打包为 ZIP 分发）
├── test/                 # *.test.ts、fixtures/、snapshots/
├── scripts/              # gen-builtin.ts、bump-version.ts
├── docs/                 # PRD、TECH_DESIGN、MANUAL_TESTING、HISTORY
├── build.ts              # 构建编排：内置主题 → JS 产物 → 平台二进制 → 安装
├── release.sh            # 一键发布：清理 → 版本自增 → 编译 → 安装 → 收尾
└── .github/workflows/    # ci.yml、release.yml
```

## 16. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 公众号编辑器白名单变更 | 输出突然失效 | §10.4 实测清单 + lint 规则可热更新（规则表独立于引擎） |
| data URL 粘贴转存不确定 | data 模式粘贴丢图 | 默认 upload 模式规避；data 模式 UI 明确提示；PRD Q1 实测结论回填文档 |
| 未认证号无 API 权限 | publish 不可用 | 权限前置探测 + 可读错误；data 模式 + 手动粘贴作为替代路径 |
| bun compile 平台差异（尤其 windows 目标） | 发布失败 | CI 矩阵对每个平台产物跑冒烟测试（`--version` + 最小渲染用例） |
| 依赖混入原生/WASM 包 | 编译失败 | 依赖审查规则 + CI 中 `bun build --compile` 冒烟 |
| zip 炸弹 / zip-slip | 本地安全 | 条目数/体积上限 + 路径规范化校验 + 文件类型白名单 |

## 17. 里程碑 ↔ 模块映射

| 里程碑 | 交付模块 | PRD 功能 |
| --- | --- | --- |
| M0 渲染核心闭环 | core（pipeline/markdown/css/dom/clean/assets）、template（loader/manifest/builtin）、cli/build | F1–F5 |
| M1 预览与模板工程 | preview/*、template pack/lint/scaffold、css 高亮、typography、cli/preview、cli/lint、发布二进制 | F6–F9、F11–F13、F15 |
| M2 发布通道 | publish/*、cli/publish、watch 服务 | F10、F14 |

## 18. 参考资料

- [doocs/md](https://github.com/doocs/md) · [mdnice 类方案背景（知乎）](https://zhuanlan.zhihu.com/p/112056597) · [huasheng.ai](https://editor.huasheng.ai) · [wx-editor](https://github.com/jitOffice/wx-editor)
- [Bun 官方文档（build --compile / Bun.serve / test）](https://bun.sh/docs)
- [微信开放文档中心（素材管理、草稿箱接口，以官方为准）](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html)
- juice（CSS 内联算法参考）：https://github.com/Automattic/juice
