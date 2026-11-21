# HISTORY

版本演进与开发过程中的关键坑位记录。需求见 [PRD](./PRD.md)，设计见 [TECH_DESIGN](./TECH_DESIGN.md)。

## 0.2.1 · 2026-11-21

- **shell 补全（F22）**：`completion [shell]` / `completion install`，支持 bash / zsh / fish / powershell / nushell / elvish；候选上下文感知（模板别名、账号别名、预设、cover、图片模式）。
- **安装体系定型**：默认安装到 `~/.bin`；正式发布自动清理其他 PATH 目录的旧副本（防遮蔽）；`--prefix` 试验安装不碰现有环境。
- **版本单一来源**：`--version` 编译期取自 package.json；`release.sh` 默认 patch 自增（`--bump=minor/major`、`--no-bump` 可选）。

## 0.2.0 · 2026-11-21

- 发布工程化：`release.sh`（清理 → 版本自增 → 编译 → 安装 → 收尾）、`dist/md2mp.js`（npm bin 产物）、`tsc --noUnusedLocals/-Parameters` 零告警基线。
- 修复一批渲染与发布链路问题（见踩坑表 1–8）。

## 0.1.0 · 2026-11-20

首个可用版本：10 步渲染管线、mpcss 内联引擎、模板包系统（loader / pack / lint / scaffold）、预览页一键复制、图片三模式、模板注册中心、多公众号账号库、publish 草稿箱通道；内置默认模板与 songmo（松墨排版）模板。

## 踩坑记录

| # | 坑 | 结论 |
| --- | --- | --- |
| 1 | 斑马纹 `$("table tr")` 全局计数，多表格时错位 | 按表格独立计数，多表回归测试覆盖 |
| 2 | MP044 只检查变量定义内部的引用，规则值中的残留 `var()` 静默进入产物 | `inlineStyles` 返回 lint，展开后仍残留即报错 |
| 3 | inject 资源 data URL 的 MIME 按 asset name 推断（name 可能无扩展名） | 按 `def.file` 扩展名 + MIME 表 |
| 4 | class/id 残留误用 MP002；MP045 是占位死代码 | 拆出 MP004；MP045 落实为「结构类无样式」检查（清洗前执行） |
| 5 | token 缓存文件权限过宽 | 写入后 `chmod 0600`（与账号库一致） |
| 6 | `compat.cli` 仅在 template lint 校验，build 时无提示 | 加载后校验并警告 |
| 7 | 模板加载期 lint（manifest 层警告）在 build 时被丢弃 | 合并进渲染结果输出 |
| 8 | MP020 把 `https://mp.weixin.qq.com/...` 判为外链 | 主机边界正则 `(^|\/\/|\.)mp\.weixin\.qq\.com(\/|$)` |
| 9 | zsh `${words[@]:n}` 切片为 0 基（bash 兼容语义），且空词守卫误用 `${#args}`，尾随空格时产生双空元素导致候选为空 | 切片用 `:1` 跳过命令名；守卫改为 `CURRENT > $#words`；以 expect 驱动真实 ZLE 双 Tab 验证 |
| 10 | markdown-it-task-lists 生成随机 id，破坏确定性输出 | 弃用，自实现确定性 token 级插件 |
| 11 | 多安装副本互相遮蔽（`~/.local/bin` 与 `/usr/local/bin` 的 PATH 顺序） | 默认安装收敛到 `~/.bin`；正式发布清理旧副本（仅清理确认能输出版本号的 md2mp） |

## 待人工实测

- 公众号编辑器粘贴核对与浏览器复制矩阵：[MANUAL_TESTING.md](./MANUAL_TESTING.md)；
- publish 端到端（需认证号凭据 + IP 白名单）；
- data URL 粘贴转存行为（PRD 开放问题 Q1）。
