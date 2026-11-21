#!/usr/bin/env bash
# md2mp 一键发布：临时文件清理 → 版本自增 → 编译 → 安装 → 收尾清理
#
# 用法：
#   ./release.sh                        # 默认 patch 自增（0.2.1 → 0.2.2），安装到 ~/.bin
#   ./release.sh --bump=minor           # minor 自增
#   ./release.sh --no-bump              # 不改版本号（同版本重装）
#   ./release.sh --prefix=DIR           # 试验安装到指定目录（不碰现有环境）
#
# 卸载：rm "$(command -v md2mp)"
set -euo pipefail
cd "$(dirname "$0")"

# 解析版本参数，其余参数透传给 build.ts
BUMP="patch"
NO_BUMP=0
PASSTHROUGH=()
for a in "$@"; do
  case "$a" in
    --bump=*) BUMP="${a#--bump=}" ;;
    --no-bump) NO_BUMP=1 ;;
    *) PASSTHROUGH+=("$a") ;;
  esac
done

echo "==> [1/5] 环境检查"
if ! command -v bun > /dev/null 2>&1; then
  echo "✖ 未找到 bun，请先安装：https://bun.sh  (curl -fsSL https://bun.sh/install | bash)"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "    安装依赖……"
  bun install
fi

echo "==> [2/5] 清理临时文件"
# bun 编译残留的隐藏二进制（每次可达 87MB/个）
rm -f .*.bun-build 2>/dev/null || true
# dist 重建，保证产物干净
rm -rf dist
# 前序验收在 /tmp 留下的测试产物
cleaned=0
for d in /tmp/md2mp-* /tmp/mp-accept-*; do
  if [ -e "$d" ]; then
    rm -rf "$d"
    cleaned=$((cleaned + 1))
  fi
done
echo "    清理 /tmp 测试目录 ${cleaned} 个"

echo "==> [3/5] 版本号"
if [ "$NO_BUMP" -eq 1 ]; then
  echo "    --no-bump：保持 $(bun -e 'console.log(require("./package.json").version)')"
else
  bun run scripts/bump-version.ts "$BUMP"
fi

echo "==> [4/5] 编译 + 安装"
if [ "${#PASSTHROUGH[@]}" -gt 0 ]; then
  bun run build.ts --install "${PASSTHROUGH[@]}"
else
  bun run build.ts --install
fi

echo "==> [5/5] 收尾清理"
rm -f .*.bun-build 2>/dev/null || true

echo
echo "✓ 发布完成。卸载：rm \"\$(command -v md2mp)\""
