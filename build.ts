/**
 * 构建与发布脚本：
 * 1. 从 themes/default/ 生成内置主题 base64（src/template/builtin.ts）
 * 2. 生成 JS 产物 dist/md2mp.js（package.json bin 指向，npm 分发用，需 Bun 运行时）
 * 3. bun build --compile 单文件二进制（当前平台，--all 全平台矩阵）
 * 4. --install：编译当前平台并安装到 bin 目录（一键发布）
 *
 * 用法：
 *   bun run build.ts                 # 生成内置主题 + JS 产物 + 当前平台二进制
 *   bun run build.ts --all           # 全平台交叉编译
 *   bun run build.ts --gen-only      # 仅生成内置主题
 *   bun run release                  # 等价于 build.ts --install
 *   bun run build.ts --install       # 编译当前平台并安装
 *   bun run build.ts --install --prefix=~/.local/bin   # 指定安装目录
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const args = process.argv.slice(2);
const all = args.includes("--all");
const genOnly = args.includes("--gen-only");
const install = args.includes("--install");
const prefixArg = args.find((a) => a.startsWith("--prefix="));
const prefix = prefixArg ? prefixArg.slice("--prefix=".length) : undefined;

function run(cmd: string, cmdArgs: string[]): void {
  console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1. 生成内置主题
console.log("▶ 生成内置默认主题");
run("bun", ["run", resolve(ROOT, "scripts/gen-builtin.ts")]);

if (genOnly) {
  console.log("✓ 完成（仅生成主题）");
  process.exit(0);
}

mkdirSync(resolve(ROOT, "dist"), { recursive: true });

// 2. JS 产物（package.json bin 指向 dist/md2mp.js；需 Bun 运行时）
console.log("▶ 生成 JS 产物 dist/md2mp.js");
run("bun", [
  "build", resolve(ROOT, "src/cli.ts"),
  "--target=bun",
  "--minify",
  "--outfile", resolve(ROOT, "dist/md2mp.js"),
]);

// 3. 平台目标
const targets = all
  ? ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64", "bun-windows-x64"]
  : ["bun-darwin-arm64"];

const built: Array<{ platform: string; path: string }> = [];
for (const target of targets) {
  const platform = target.replace(/^bun-/, "");
  const ext = platform.startsWith("windows") ? ".exe" : "";
  const out = resolve(ROOT, "dist", `md2mp-${platform}${ext}`);
  console.log(`▶ 编译 ${platform}`);
  run("bun", [
    "build", resolve(ROOT, "src/cli.ts"),
    "--compile",
    "--minify",
    `--target=${target}`,
    "--outfile", out,
  ]);
  console.log(`✓ ${out}`);
  built.push({ platform, path: out });
}

// 4. --install：安装当前平台二进制
if (install) {
  const current = process.platform === "darwin"
    ? `darwin-${process.arch}`
    : process.platform === "win32"
      ? "windows-x64"
      : `linux-${process.arch}`;
  const artifact = built.find((b) => b.platform === current)!.path;

  // 安装目录选择：
  // 1) 显式 --prefix（试验安装，不碰现有环境）；
  // 2) 默认 ~/.bin（用户固定选择的个人 bin 目录，mkdir 自动创建；不在 PATH 时给出提示）
  const existingDirs = pathDirsWithMd2mp();
  let binDir: string;
  if (prefix) {
    binDir = prefix.startsWith("~") ? join(homedir(), prefix.slice(1)) : resolve(prefix);
  } else {
    binDir = join(homedir(), ".bin");
  }
  mkdirSync(binDir, { recursive: true });

  const dest = join(binDir, "md2mp");
  copyFileSync(artifact, dest);
  chmodSync(dest, 0o755);

  // 清理其他 PATH 目录中的旧副本（防止旧版本遮蔽新安装；仅清理确认能输出版本号的 md2mp）。
  // 仅正式发布路径执行——显式 --prefix 属试验安装，绝不改动现有环境。
  if (!prefix) {
    for (const d of existingDirs) {
      const p = join(d, "md2mp");
      if (resolve(p) === resolve(dest)) continue;
      const probe = spawnSync(p, ["--version"], { encoding: "utf8" });
      if (probe.status === 0 && /^\d+\.\d+\.\d+$/.test(probe.stdout.trim())) {
        rmSync(p);
        console.log(`  已清理旧副本：${p}（${probe.stdout.trim()}）`);
      } else {
        console.log(`  ⚠ ${p} 存在但未输出 md2mp 版本号，未清理，请手动确认`);
      }
    }
  }

  // 冒烟：安装后能执行
  const probe = spawnSync(dest, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.error(`✖ 安装后自检失败：${dest} --version 退出码 ${probe.status}`);
    process.exit(1);
  }

  const sizeMb = (statSync(dest).size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ 已安装 md2mp ${probe.stdout.trim()} → ${dest}（${sizeMb} MB）`);
  if (!inPath(binDir)) {
    console.log(`⚠ ${binDir} 不在 PATH 中，请加入后生效：`);
    console.log(`  echo 'export PATH="${binDir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`);
  } else {
    console.log("  现在可直接运行：md2mp --help");
  }
  console.log("  卸载：rm " + dest);
}

/** 扫描 PATH 中已存在 md2mp 可执行文件的目录 */
function pathDirsWithMd2mp(): string[] {
  const out: string[] = [];
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d) continue;
    try {
      const p = join(d, "md2mp");
      if (existsSync(p) && statSync(p).isFile()) out.push(d);
    } catch {
      // 忽略不可读目录
    }
  }
  return out;
}

function inPath(dir: string): boolean {
  const path = process.env.PATH ?? "";
  return path.split(":").some((p) => resolve(p || ".") === resolve(dir));
}

console.log("\n✓ 构建完成");
