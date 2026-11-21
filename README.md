# md2mp

**Markdown → 微信公众号 HTML**，本地运行、单文件分发、模板 ZIP 共享的 CLI 工具。

一条命令把 Markdown 转成可直接粘贴进公众号编辑器的 HTML：所有样式写进元素内联 `style`（公众号编辑器只保留内联样式，会剥离 `<style>` / `<script>` / `class` / `id`）。

## 安装

方式一（推荐，源码目录内一键发布）：

```bash
bun install                 # 首次
./release.sh                # 清理 → 版本 patch 自增 → 编译 → 安装 → 收尾清理
md2mp --version             # 安装后自检；卸载：rm "$(command -v md2mp)"
```

- 版本号：默认每次发布 **patch 自增**（单一来源 = package.json，`--version` 自动跟随）；`./release.sh --bump=minor` / `--bump=major` 升大版本，`--no-bump` 同版本重装。
- 安装目录：默认 **`~/.bin`**（首次安装会提示把 `~/.bin` 加入 PATH）；`--prefix=DIR` 试验安装到其他目录（不碰现有环境）；正式发布时自动清理其他 PATH 目录里的旧 md2mp 副本（防遮蔽）。
- 全平台交叉编译（不出安装、不升版本）：`bun run build.ts --all`。

方式二：从 [GitHub Releases](https://github.com/simonkuang/md2mp/releases) 下载预编译单文件二进制（无需 Node/Bun 运行时），放到 PATH 即可：

```bash
mv md2mp-darwin-arm64 ~/.bin/md2mp && chmod +x ~/.bin/md2mp
md2mp --version
```

方式三：源码直接运行（需 Bun ≥ 1.2）：

```bash
bun install
bun run src/cli.ts --version
```

## 快速开始

```bash
# 1. 渲染（内置默认模板，data 模式内嵌图片，离线可用）
md2mp build article.md --image-mode data

# 输出：article.html（可粘贴的片段）+ preview.html（预览页，含一键复制）

# 2. 打开 preview.html，点「一键复制」，到公众号编辑器粘贴即可
open article.html 的兄弟文件 preview.html
```

`build` 默认图片模式为 `upload`（需公众号凭据）。无凭据时用 `--image-mode data` 或 `link`。

## 命令

```
md2mp build    <article.md> [-t theme.zip] [-o dist/] [-V k=v ...] [-p preset] [--image-mode upload|data|link] [--account 别名] [--standalone] [--json]
md2mp preview  <article.md> [-t theme.zip] [--watch] [--port 4173] [--open]
md2mp publish  <article.md> [-t theme.zip] [--cover auto|asset:xx|路径] [--account 别名] [--dry-run]
md2mp lint     <article.html | article.md> [-t theme.zip] [--json]
md2mp account  add|import|list|show|update|remove|default ...
md2mp template init|pack|lint|add|import|list|show|update|remove|default ...
md2mp completion [shell] | install [shell]
md2mp rules
md2mp --version / --help
```

### build 关键选项

| 选项 | 说明 |
| --- | --- |
| `-t, --template <zip\|别名>` | 模板 ZIP 路径或已注册别名；也可用 `builtin`/`default`，不传用默认注册模板（无则内置模板） |
| `-o, --out <dir>` | 输出目录（默认输入文件所在目录） |
| `-V, --var <k=v>` | 覆盖模板变量，可多次，如 `-V "--font-size=21px"` |
| `-p, --preset <name>` | 选择模板预设（如 songmo 的 庄重 / 典雅 / 素净） |
| `--image-mode` | `upload`（默认，需凭据）/ `data`（内嵌 base64）/ `link`（保留外链） |
| `--account <别名>` | 指定公众号（图片上传到该号图床；需先 `md2mp account add`） |
| `--standalone` | article.html 输出完整 HTML 文档而非片段 |
| `--json` | 结构化 JSON 输出，供 CI 消费 |

### 图片三种模式

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `upload` | 调公众号 `media/uploadimg` 上传为微信图床链接（默认，粘贴最可靠） | 有凭据的正式出稿 |
| `data` | 本地图片内嵌为 base64 | 离线/无凭据；粘贴转存行为需在公众号实测 |
| `link` | 保留原链接（`http` 自动升级 `https`） | 图片已在外部图床 |

## 模板

模板 = 一个 ZIP 文件：`manifest.json`（清单）+ `theme.css`（主题）+ 可选 `assets/` 资源。

```bash
# 创建脚手架
md2mp template init ./my-theme

# 编辑 ./my-theme/theme.css 后校验并打包
md2mp template pack ./my-theme -o my-theme.zip

# 交付前兼容性检查
md2mp template lint my-theme.zip

# 使用
md2mp build article.md -t my-theme.zip --image-mode data
```

`theme.css` 的选择器挂在 `#js_article` 下，颜色用 `var(--x)` 书写；导出的 HTML 中变量会被解析为字面值、class/id 被剥离。详见 [docs/TECH_DESIGN.md](./docs/TECH_DESIGN.md) §4 与已有模板 `templates/songmo/`。

### 模板管理（CRUD）

把常用模板注册到本地，之后用短别名引用，不必每次记 ZIP 路径。导入时会校验 manifest 与 CSS 兼容性，并把 ZIP **复制**一份到配置目录 `~/.md2mp/templates/<别名>.zip`。运行时只使用这份副本：**注册成功后可放心删除或移动导入位置的原 ZIP/目录，不影响渲染**；副本只在执行 `template remove` 时被清理（`template update --file` 时会被新内容替换）。`template show` 中的「来源」仅是原始导入位置记录，不是运行时依赖。

```bash
# 注册：ZIP 或模板工程目录均可（第一个注册的自动成为默认）
md2mp template add songmo ./templates/songmo --name "松墨主题"
md2mp template add work ./my-theme -d          # -d 设为默认

# 批量注册：JSON 数组或 { "templates": [...] }，字段 alias/source/name?/default?
md2mp template import templates.json

# 查看（全部 / 单个详情：manifest、预设、变量、资源、兼容性）
md2mp template list
md2mp template show songmo

# 修改（改别名/展示名/替换模板包）
md2mp template update songmo --alias songmo-v2 --name "松墨 V2"
md2mp template update songmo-v2 --file ./songmo-new.zip

# 删除（同时删除本地副本）、设置默认
md2mp template remove songmo-v2
md2mp template default songmo

# 渲染时指定
md2mp build article.md --template songmo --image-mode data
md2mp publish article.md --template songmo --account company-a
```

- 注册表：`~/.md2mp/templates.json`（权限 0600）；`list`/`show`/`add`/`import`/`update`/`remove`/`default` 均支持 `--json`。
- **模板引用优先级**：`--template` 显式路径 > 注册别名 > 保留字 `builtin`（强制内置）/ `default`（默认注册模板） > 默认注册模板 > 内置模板。也可在 `.md2mprc.json` 里写 `"template": "别名"`。
- 别名规则与公众号一致：字母/数字开头，仅字母、数字、`-`、`_`，1–64 位，大小写不敏感；`builtin` 是保留字。

## 多公众号管理

可以保存多个公众号的 appid/appsecret，推送时用 `--account` 指定发到哪个号，无需反复改环境变量。

```bash
# 添加（别名用于 --account；第一个添加的自动成为默认）
md2mp account add company-a --appid wxXXXX --secret xxxxxx --name "公司A公众号"
md2mp account add company-b --appid wxYYYY --secret yyyyyy --name "公司B公众号"

# 查看（AppSecret 默认脱敏；--show-secret 显示完整）
md2mp account list
md2mp account show company-a --show-secret

# 修改（改别名/名称/appid/appsecret）
md2mp account update company-a --secret 新密钥
md2mp account update company-a --alias 新别名 --name "新名称"

# 删除（同时清理该号的 access_token 缓存）
md2mp account remove company-a

# 设置默认公众号（不指定 --account 时使用）
md2mp account default company-b

# 批量导入：JSON 数组或 { "accounts": [...] }，字段支持 appid/appId、secret/appsecret
md2mp account import accounts.json
```

账号保存在 `~/.md2mp/accounts.json`（文件权限 0600，仅当前用户可读写；AppSecret 在 `list`/`show` 输出中默认脱敏）。`list`/`show`/`add`/`import` 等命令均支持 `--json` 供脚本消费。

```bash
# 推送时指定公众号
md2mp publish article.md --account company-a
md2mp publish article.md --account company-b --cover asset:header

# build 的 upload 模式同样可指定（图片上传到对应公众号图床）
md2mp build article.md --image-mode upload --account company-a
```

**凭据优先级**：`--account` 指定账号 > 环境变量 `MP_APPID`/`MP_SECRET` > `.md2mprc.json` > 默认账号 > 报错。显式 `--account` 找不到时会直接报错，不会静默降级。每个公众号的 `access_token` 按 appid 独立缓存、自动刷新。

## 配置与凭据

配置优先级：**命令行 > 环境变量 > `.md2mprc.json` > manifest 默认值 > 内置默认**。

```bash
# 也可只用环境变量（单账号临时场景）
export MP_APPID=你的appid
export MP_SECRET=你的secret
```

- 调用方 IP 需加入公众号后台「基本配置 → IP 白名单」。
- 退出码：0 成功 / 1 参数错误 / 2 输入不存在 / 3 模板非法 / 4 渲染失败 / 5 网络错误 / 6 凭据缺失。

## 发布到草稿箱

```bash
md2mp publish article.md --cover asset:header      # 渲染 + 传图 + 写草稿箱，输出草稿 ID
md2mp publish article.md --dry-run                 # 只渲染与上传，输出将提交的 JSON
```

未认证订阅号通常无草稿箱 API 权限，命令会给出可读提示；此时用 `--image-mode data` + preview 手动复制粘贴。

## shell 补全

支持 **bash / zsh / fish / powershell / nushell / elvish** 六种 shell。补全上下文感知：`-t/--template` 补全注册模板别名与 `builtin`/`default`，`--account` 补全账号别名，`-p/--preset` 补全当前模板的预设名（庄重/典雅/素净…），`--cover` 补全 `auto` 与 `asset:名称`，`--image-mode` 补全三种模式。

```bash
md2mp completion bash        # 打印补全脚本（缺省 shell 自动检测）
md2mp completion install     # 写入 ~/.md2mp/completions/ 并挂载到 shell 配置（幂等）
```

挂载位置：bash → `~/.bashrc`、zsh → `~/.zshrc`（需在 compinit 之后）、fish → `~/.config/fish/completions/`（自动加载）、powershell → `$PROFILE`、nushell → `$nu.config-path`（需 nu ≥ 0.87）、elvish → `~/.config/elvish/rc.elv`（需 ≥ 0.18）。

## lint 规则

`md2mp rules` 列出全部规则。常见：MP001/002（script/style）、MP004（class/id 残留兜底）、MP010（外链图片）、MP040-043（CSS 伪元素/@media/@font-face/交互伪类）、MP044（未定义变量）、MP045（结构类缺样式）、MP050（position:fixed）、MP060（表格无边框）。

## 开发

```bash
bun install
bun test                 # 单元测试 + 快照测试（确定性验证），57 用例
bunx tsc --noEmit        # 类型检查
bun run build.ts         # 生成内置主题 + JS 产物 + 当前平台二进制
bun run build.ts --all   # 全平台交叉编译
bun run release          # 一键：编译 + 安装（等价 build.ts --install）
bun run build.ts --install --prefix=~/.bin   # 安装到指定目录
```

脚本速查：`dev` 源码运行 / `test` 测试 / `typecheck` 类型检查 / `build` 构建产物 / `release` 编译安装。

## 文档

- [PRD.md](./docs/PRD.md) — 产品需求与功能范围
- [TECH_DESIGN.md](./docs/TECH_DESIGN.md) — 技术设计（架构、管线、模板规范、lint 规则）
- [MANUAL_TESTING.md](./docs/MANUAL_TESTING.md) — 公众号编辑器粘贴实测 SOP
- [HISTORY.md](./docs/HISTORY.md) — 版本演进与踩坑记录
