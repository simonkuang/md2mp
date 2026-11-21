# 松墨排版 · md2mp 模板

中老年权威风微信公众号排版模板，移植自「松墨排版」设计规范（`交接单_01_设计规范.md`）与参考原型 `index.html` 的**文章样式部分**。

读者定位：中老年人群。所有排版决策以「中老年阅读舒适、显权威、显正式」为第一判据。

## 设计原则

1. **宋体正文**：正文与标题均为宋体系衬线体，呼应官方读物气质；
2. **大字号高行距**：默认 19px / 行距 1.95，另提供 17px、21px 两档；
3. **高对比深色文字**：正文深灰 `#3b3a36` 级而非纯黑；重点用深藏青/绛红，不用亮蓝亮橙；
4. **克制的装饰**：分割线为「细线—菱形—细线」，标题用左侧色条，无阴影渐变卡通元素。

## 快速使用

```bash
# 打包成可分发 ZIP（manifest.json / theme.css / README.md 位于 ZIP 根）
md2mp template pack ./songmo -o songmo-1.0.0.zip

# 交付前兼容性检查
md2mp template lint songmo-1.0.0.zip

# 渲染（默认：庄重预设 + 舒适字号）
md2mp build article.md -t songmo-1.0.0.zip

# 切换主题预设
md2mp build article.md -t songmo.zip -p 素净

# 预设之上微调单项变量（变量名以 -- 开头，注意 shell 引号）
md2mp build article.md -t songmo.zip -p 庄重 -V "--font-size=21px" -V "--line-height=2.1"

# 单篇关闭章节编号：在文章 frontmatter 中写 `numbering: false`
```

## 主题预设（presets）

`presets[0]` 为默认。三套色板与原型完全一致：

| 变量 | 庄重（默认） | 典雅 | 素净 |
| --- | --- | --- | --- |
| `--text` 正文 | `#3b3a36` | `#4a4038` | `#44403c` |
| `--heading` 标题 | `#1f3a5f` 深藏青 | `#4a3222` 深棕 | `#23403c` 墨青 |
| `--accent` 强调 | `#9e2b25` 绛红 | `#8c5b2f` 赭石 | `#2f6b5e` 墨绿 |
| `--muted` 弱化 | `#8a8578` | `#98907e` | `#8b8f88` |
| `--paper` 底色 | `#ffffff` | `#fffdf8` | `#ffffff` |
| `--soft` 引用底 | `#faf6ee` | `#faf5ea` | `#f3f6f3` |
| `--border` 边框 | `#e5dfd3` | `#e8dfcc` | `#e0e5e0` |
| `--zebra` 斑马纹 | `#f8f5ef` | `#faf6ec` | `#f5f8f5` |
| `--quote-text` 引用字 | `#5a5348` | `#6b5d49` | `#55605a` |
| `--code-bg` / `--code-text` | `#f4f0e8` / `#8a3a12` | `#f6f0e4` / `#8a5a1e` | `#eef3ef` / `#2f6b5e` |
| `--pre-bg` 代码块底 | `#faf8f3` | `#fbf7ee` | `#f7faf7` |
| `--thead` 表头底 | `#1f3a5f` | `#4a3222` | `#23403c` |
| `--task-box` / `--link` | `#9e2b25` | `#8c5b2f` | `#2f6b5e` |

## 字号档位（variables）

| 档位 | `--font-size` | `--line-height` | 说明 |
| --- | --- | --- | --- |
| 标准 | `17px` | `1.9` | 偏年轻读者 |
| **舒适（默认）** | **`19px`** | **`1.95`** | 中老年首选 |
| 关怀 | `21px` | `2.1` | 高龄/视力偏弱 |

## 排版特性（manifest.typography）

| 特性 | 值 | 说明 |
| --- | --- | --- |
| `headingNumbering` | `true` | h2 →「一、」、h3 →「（一）」、h4 →「1. 」，中文序号，编号为强调色；h1 不编号；frontmatter `numbering: false` 可单篇关闭 |
| `hr` | `"diamond"` | `<hr>` 转为「细线—菱形—细线」真实节点（规避伪元素） |
| `taskListGlyph` | `true` | `- [x]` / `- [ ]` → ☑ / ☐ 字形（规避 input 标签兼容问题） |
| `figureCaption` | `true` | 单图段落 → `figure.mp-photo`；紧随的「图：说明」段落 → 题注 |
| `tableZebra` | `true` | 表格偶数行加 `mp-alt` 类实现斑马纹（规避 `:nth-child`；多表格各自独立计数） |
| `codeIndentPreserve` | `true` | 代码块前导空格保护 |
| `autoSpacing` | `false` | 不自动加中英文空格（与原型一致） |
| `markdown.breaks` | `true` | 单换行转 `<br>`（中文写作习惯，与原型 marked `breaks:true` 一致） |
| 容器（`:::tip` 等） | 已配样式 | `tip/note/info/success` 与 `warning/danger` 均渲染为「浅底 + 强调色左条」，样式见 theme.css |

## 与参考原型的差异

| 原型能力 | 本模板 | 原因 |
| --- | --- | --- |
| 照片墙轮播（左右滑动） | 不包含，连续多图按独立 figure 呈现 | 轮播依赖脚本，公众号正文不执行 JS；原型的导出路径同样是降级网格 |
| KaTeX 公式 / Mermaid / PlantUML | 暂不启用 | 属 md2mp 核心 P2 能力（F16/F17）；实现后本模板无需修改即可使用 |
| 预览页（左右分栏编辑器、主题切换 UI） | 使用 md2mp 默认预览页 | 主题/字号在 CLI 侧用 `-p` / `-V` 控制 |

## 公众号兼容要点（继承原型交接单 §8.2）

- 模板 CSS 中的 `var(--x)` 只是书写形式，md2mp 内联引擎在导出前解析为**字面值**，产物不含 CSS 变量；
- 无伪元素、伪类依赖：斑马纹用真实类 `mp-alt`，分割线为真实节点，任务勾为字形；
- 产物不含 `class` / `id` / `<script>` / 内联 SVG，全部样式为元素 `style` 属性；
- 代码块 `white-space: pre` + 管线前导空格保护，防止公众号编辑器折叠缩进。

## 目录结构

```
songmo/
├── manifest.json   # 清单：预设、变量、排版特性（schema 见 docs/TECH_DESIGN.md §4）
├── theme.css       # 主题样式（含 hljs 高亮令牌色）
└── README.md       # 本文件（打包时一并进入 ZIP）
```
