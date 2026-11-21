# md2mp 产品需求文档（PRD）

> 工作名 `md2mp`（Markdown → MP/公众号）。命名可替换，不影响本文档内容。

| 项目 | 内容 |
| --- | --- |
| 版本 | 0.2 |
| 日期 | 2026-11-21 |
| 状态 | 活跃开发（版本演进与踩坑见 [HISTORY.md](./HISTORY.md)） |
| 关联文档 | [TECH_DESIGN.md](./TECH_DESIGN.md) · [MANUAL_TESTING.md](./MANUAL_TESTING.md) |

---

## 1. 背景与问题

微信公众号图文编辑器**不原生支持 Markdown**，且对粘贴进来的富文本执行严格的白名单过滤：`<style>` 标签、`<script>` 标签、`class`/`id` 属性会被剥离，只有写在元素 `style` 属性上的**内联样式**能存活。这导致：

1. 直接把 Markdown 转 HTML 粘贴进去，排版全部丢失；
2. 主流解法（mdnice、doocs/md、壹伴等）均为**在线服务或浏览器插件**：
   - 主题定制受限于平台提供的编辑能力，无法表达任意 CSS；
   - 依赖第三方站点与网络，敏感草稿需上载到他人服务器，有隐私顾虑；
   - 无法进入脚本 / CI 流水线，无法版本化管理模板；
   - 模板分享依赖平台生态，不能以文件形式离线分发。

**需求**：一个本地运行、可单文件分发、模板以 ZIP 文件形态共享的 CLI 工具，一条命令把 Markdown 变成可直接发布到公众号的 HTML 文章。

## 2. 产品定位与目标

**一句话定位**：`md2mp` 是一个用 Bun 编写、编译为单文件可执行程序的 CLI，读取 Markdown 与模板包（ZIP：JSON 清单 + CSS + JS/PNG 等资源），产出公众号编辑器兼容的 HTML 文章，并可选直达公众号草稿箱。

### 2.1 产品目标

| 编号 | 目标 | 衡量方式 |
| --- | --- | --- |
| G1 | 输出 HTML 在公众号编辑器粘贴后排版与预览一致 | 每次发版的实测清单（见 §10.4） |
| G2 | 模板 = 一个 ZIP 文件，可离线分享、版本化管理 | 模板包通过 `template pack/lint` 校验 |
| G3 | 全流程本地化：转换不依赖任何在线服务（图片上传除外） | 断网状态下 build 可完成（data/link 模式） |
| G4 | 单文件分发，无需安装 Node/Bun 运行时 | 三大平台二进制可直接执行 |
| G5 | 自动化友好：CI 中一条命令完成「渲染 + 传图 + 写草稿箱」 | publish 命令可无交互运行 |

### 2.2 非目标（本期不做）

- 不做 GUI / 在线编辑器；
- 不做公众号后台管理（群发、粉丝、留言管理）；
- 不做除公众号外的其他平台适配（知乎/头条/小红书等，列为远期）；
- 不做 AI 写作/配图（可与外部工具链配合，本工具只负责「排版与发布」）。

## 3. 目标用户与场景

| 画像 | 描述 | 关键诉求 |
| --- | --- | --- |
| A. 个人创作者 | 会使用终端，长期写公众号 | 一条命令出稿、一键复制、模板好看可换 |
| B. 团队/矩阵运营 | 多人维护多个公众号，风格需统一 | 模板 ZIP 统一分发、变量微调不破坏基线 |
| C. 自动化流水线 | 内容平台/CI 定时生成文章 | 无交互运行、API 直达草稿箱、失败可重试 |

## 4. 用户故事

- **US-1** 我执行 `md2mp build article.md -t aurora.zip`，得到 `article.html`（内联样式）与 `preview.html`（预览页）。
- **US-2** 我在浏览器打开 preview.html，点「一键复制」，到公众号编辑器粘贴，标题、代码块、表格、图片的样式与预览一致。
- **US-3** 作为模板作者，我修改 `theme.css` 后执行 `md2mp template pack ./my-theme`，得到可分享的 `my-theme.zip`；分享前 `template lint` 告诉我哪些写法在公众号会失效。
- **US-4** 团队负责人把统一的 `team.zip` 发给成员；成员用 `-V primary=#ff0000` 微调主色，但整体风格不跑偏。
- **US-5** 我配置好 appid/secret 后执行 `md2mp publish article.md`，文章图片自动上传到素材库，正文写入公众号草稿箱，命令输出草稿 ID。
- **US-6** 发布前 `md2mp lint article.html` 列出兼容性风险（如外链图片、伪元素写法）。
- **US-7** 我在 `preview --watch` 下保存 Markdown，浏览器预览自动刷新。
- **US-8** Markdown 里的本地图片随文章自动处理（默认上传为微信图床链接，无凭据时可降级为内嵌 base64）。

## 5. 功能需求与优先级

> P0 = 首个可用版本必须；P1 = 第二迭代；P2 = 规划/远期。

### 5.1 P0

| 编号 | 功能 | 描述 | 验收要点 |
| --- | --- | --- | --- |
| F1 | Markdown 渲染核心 | CommonMark + GFM（表格、删除线、任务列表、围栏代码块）；YAML frontmatter（title/author/cover/digest/tags） | 精选样例文档快照测试通过；未知语法不崩溃 |
| F2 | 模板包加载 | 读取 ZIP：`manifest.json`（清单）+ `theme.css`（主题）+ 资源文件（png/jpg/svg/woff 等）；schema 校验，坏包给出可读错误 | 非法 ZIP/清单错误信息指向具体字段 |
| F3 | CSS 内联化引擎 | 将 `theme.css` 规则按级联与优先级计算为每个元素的内联 `style`；解析 CSS 变量（`var(--x)`）；输出前剥离 class/id | 渲染结果逐字节确定（同输入同输出） |
| F4 | 内置默认模板 | 不传 `-t` 时使用内置主题，开箱即用 | 新手零配置完成 US-1 |
| F5 | `build` 命令 | 输出 `article.html`（片段 + 可选完整 HTML 包装）与 `preview.html` | article.html 不含 `<script>`/`<style>` 标签/class/id |
| F6 | 预览页 + 一键复制 | preview.html 渲染真实文章 DOM，工具栏含「一键复制」与 lint 警告面板；复制内容与文章 DOM 一致 | Chrome/Edge/Safari/Firefox 复制后粘贴 mp 编辑器样式保留 |
| F7 | 图片管线 | 三种模式（默认 **upload**）：`upload`=素材接口上传为微信图床链接；`data`=内嵌 base64；`link`=保留原链接。凭据缺失时明确报错并提示降级 | 三种模式各自可用；无凭据时错误信息含解决方案 |
| F8 | 资产与元数据 | 模板资源以 `asset://name` 引用；`inject.articleHead/Foot` 支持页头页脚注入（支持 `{{title}}`/`{{author}}`/`{{asset:name}}` 占位符） | 注入内容同样被内联化处理 |

### 5.2 P1

| 编号 | 功能 | 描述 |
| --- | --- | --- |
| F9 | 模板工程命令 | `template init`（脚手架）/ `template pack`（校验+打包）/ `template lint`（兼容性检查）/ `template list`（本地模板缓存） |
| F10 | watch 预览 | `preview --watch` 启动本地服务 + 文件监听 + 热刷新（SSE） |
| F11 | 主题变量与配置 | `-V key=value` 覆盖模板变量；`.md2mprc.json` 项目级配置 |
| F12 | 代码高亮 | highlight.js，主题色同样走 CSS 内联化（`.hljs-*` 规则） |
| F13 | 排版增强 | 中英文之间自动加空格；代码块前导空格保护（转 `&nbsp;`，可关闭）；任务列表转 ☑/☐ 字形 |
| F14 | `publish` 命令 | 渲染 → 图片上传（uploadimg）→ 封面传素材库 → `draft/add` 写入草稿箱 → 输出草稿 ID 与后台链接 |
| F15 | 独立 lint 命令 | 对生成 HTML 执行公众号兼容性检查，支持 `--json` 输出 |
| F22 | shell 补全 | `completion [shell]` 生成 / `completion install` 安装，支持 bash/zsh/fish/powershell/nushell/elvish；上下文感知（模板别名/账号别名/预设/图片模式） |

### 5.3 P2（规划）

| 编号 | 功能 | 描述 |
| --- | --- | --- |
| F16 | 数学公式 | KaTeX → HTML+CSS 或预渲染图片 |
| F17 | Mermaid 图 | 预渲染为 PNG 后走图片管线 |
| F18 | 自定义预览页 | 模板可覆盖 preview.html 壳（`entry.previewHtml`） |
| F19 | 按模板固化独立程序 | `bundle` 子命令：把某套模板与转换器打包成专属单文件程序 |
| F20 | 渲染插件钩子 | 管线各步骤暴露 hook，支持按元素注入前缀/后缀 HTML 等深度定制 |
| F21 | 其他平台适配 | 知乎/掘金/头条等目标输出 |

## 6. 模板包规范（产品视角）

一个模板 = 一个 ZIP 文件，内部结构：

```
aurora.zip
├── manifest.json     # JSON 清单：元信息、变量定义、资源注册、注入配置（schema 见技术设计）
├── theme.css         # 主题样式：普通 CSS + CSS 变量书写，渲染时被内联化
├── preview.js        # （可选）预览页交互脚本，仅本地浏览器执行，不进入文章
└── assets/           # 页头/页脚图片、装饰图、二维码等
    ├── header.png
    └── qrcode.png
```

**模板作者能力边界**（受公众号编辑器白名单约束，完整事实表见 §9）：

- ✅ 任意元素选择器样式、CSS 变量、注入页头页脚图片与 HTML；
- ❌ `<script>` 进入正文（编辑器剥离，模板 JS 仅用于预览页）；
- ❌ `<style>` 标签进入正文（渲染时必须完成内联化）；
- ❌ 伪元素 `::before/::after`（编辑器不执行）、`position:fixed`、外部字体 `@font-face`（lint 给出警告）；
- ⚠️ 外链图片：公众号正文图片必须为微信图床链接，工具通过上传模式解决。

## 7. CLI 交互规范

### 7.1 命令总览

```
md2mp build    <article.md> [-t theme.zip] [-o dist/] [-V k=v ...] [--image-mode upload|data|link] [--json]
md2mp preview  <article.md> [-t theme.zip] [--watch] [--port 4173] [--open]
md2mp publish  <article.md> [-t theme.zip] [--cover auto|asset:xx|图片路径] [--dry-run]
md2mp lint     <article.html | article.md> [-t theme.zip] [--json]
md2mp template init|pack|lint|list ...
md2mp --version / --help
```

### 7.2 配置与凭据

- 配置优先级：**命令行参数 > 环境变量 > `.md2mprc.json` > manifest 默认值 > 内置默认**。
- 公众号凭据：优先环境变量 `MP_APPID` / `MP_SECRET`；`.md2mprc.json` 可存但启动时给出安全提示。`access_token` 本地缓存（`~/.md2mp/`），过期自动刷新。
- 退出码：`0` 成功；`1` 参数错误；`2` 输入文件不存在；`3` 模板包非法；`4` 渲染失败；`5` 网络/API 错误；`6` 凭据缺失或无效。

### 7.3 错误信息原则

- 中文为主；每条错误包含：发生了什么 → 为什么 → 下一步建议（如「未配置 MP_APPID/MP_SECRET。可用 `export MP_APPID=...` 或改用 `--image-mode data`」）。

## 8. 非功能需求

| 维度 | 要求 |
| --- | --- |
| 性能 | 1 万字 + 50 图文章，data 模式 build ≤ 3s；upload 模式并发上传（并发度 5，限频退避）；preview 服务启动 ≤ 500ms |
| 分发 | 单文件二进制：darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / windows-x64；另提供 npm 包（需 Bun 运行时）作为备选安装方式 |
| 兼容性 | 输出适配公众号网页版编辑器粘贴；复制按钮兼容 Chrome/Edge/Safari/Firefox 最新两个大版本 |
| 确定性 | 同一输入 + 同一模板 + 同一参数，输出逐字节一致（便于快照测试与 CI diff） |
| 安全 | ZIP 解压防路径穿越（zip-slip）；条目数/解压体积上限（防 zip 炸弹）；模板 JS 只进预览页、永不进正文；不采集任何数据；凭据不写入日志 |
| 离线 | build（data/link 模式）、preview、template 全套命令离线可用；upload/publish 需网络 |

## 9. 平台约束：公众号编辑器白名单事实表

> 这是整个产品「模板能力边界」的依据。编辑器行为随微信版本可能变化，**每次发版按 §10.4 清单实测校验**；标注 ⚠️ 的为需在开发期实测确认项。

| 能力 | 编辑器行为 | 对产品的约束 |
| --- | --- | --- |
| `<style>` 标签 | 剥离 | 渲染期必须完成 CSS 内联化（F3） |
| `<script>` 标签 | 剥离 | 模板 JS 仅用于预览页（F6），正文零 JS |
| `class` / `id` 属性 | 剥离 | 输出前剥离（不影响样式，因样式已内联） |
| 元素内联 `style` | **保留**（主力样式载体） | 级联计算结果写入 `style` 属性 |
| 伪元素 `::before/::after` | 不生效（依赖样式表） | lint 警告；模板改用真实元素/图片 |
| `position: fixed` | 不生效 | lint 警告 |
| SVG 内联 | 不稳定 ⚠️ | 装饰性图形建议用 PNG；lint 提示 |
| `img` 外链 | 正文仅微信图床（mmbiz.qpic.cn）可靠显示 ⚠️ | 图片管线 upload 模式为默认（F7） |
| `img` base64 data URL | 粘贴转存行为不稳定 ⚠️ | data 模式定位为降级/离线路径，预览页默认用 data 本地渲染 |
| `<a>` 外部链接 | 受账号权限限制，可能被过滤 ⚠️ | lint 警告；文字内容保留 |
| `<table>`/`<td>` | 支持内联样式 | 表格样式走内联化 |
| `h1-h6`、`p`、`span`、`section`、`blockquote`、`ul/ol/li`、`strong/em/del`、`hr` | 支持 | 语义标签 + 内联样式 |
| `<pre><code>` | 支持，但**前导空格易被折叠** ⚠️ | 排版增强：前导空格转 `&nbsp;`（可关闭） |
| 正文宽度 | 编辑器正文区域约 677px | 默认主题按此宽度设计 |

## 10. 里程碑与验收

### 10.1 M0 — 渲染核心闭环

F1、F2、F3、F4、F5。验收：US-1 完成；样例文档（覆盖全部 Markdown 元素）快照稳定；无凭据离线环境全流程可跑。

### 10.2 M1 — 预览复制与模板工程

F6、F7、F8、F9、F11、F12、F13、F15。验收：US-2/3/4/6/7 完成；三大平台二进制发布。

### 10.3 M2 — 发布通道

F14、F10。验收：US-5/8 完成；认证公众号实测 publish 全流程成功；失败重试与限频退避生效。

### 10.4 版本实测清单（每次发版执行）

1. 用最新 Chrome 在 mp.weixin.qq.com 编辑器粘贴 preview 复制内容，核对：标题/正文/引用/代码块/表格/图片/分割线样式；
2. 本地 PNG 与网络图在 upload / data / link 三种模式下的表现；
3. 复制按钮在 Chrome / Edge / Safari / Firefox 的行为；
4. 记录并更新 §9 事实表，标注新发现的编辑器行为变化。

## 11. 开放问题

| # | 问题 | 当前倾向 |
| --- | --- | --- |
| Q1 | data URL 粘贴后公众号编辑器是否稳定自动转存 | 需实测；实测前 data 模式仅作为降级路径并在 UI 提示 |
| Q2 | 未认证个人订阅号的素材/草稿 API 权限范围 | 以官方文档与实测为准；publish 命令前置检查权限并给出可读错误 |
| Q3 | SVG 资源（模板 assets 内）是否允许 | 允许但 lint 提示风险；转 PNG 由模板作者自行处理 |
| Q4 | 数学公式渲染形态（HTML+CSS vs 图片） | P2 再评估 |
| Q5 | CLI 语言（界面文案） | 默认中文，预留 `--lang en` |

## 12. 参考资料

- [doocs/md（微信 Markdown 编辑器）](https://github.com/doocs/md)
- [Markdown 排版方案与 base64 图片处理（知乎）](https://zhuanlan.zhihu.com/p/112056597)
- [huasheng.ai 公众号排版器（复制时自动转换图片）](https://editor.huasheng.ai)
- [wx-editor：粘贴图片自动转存实现参考](https://github.com/jitOffice/wx-editor)
- [微信开放文档中心（草稿箱/素材管理接口，以官方为准）](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html)
