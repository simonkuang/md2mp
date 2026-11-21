/**
 * 版本号自增：bun run scripts/bump-version.ts [patch|minor|major]
 * 只改 package.json 的 version（CLI --version 的单一来源），不建 tag 不发 npm。
 */
import { readFileSync, writeFileSync } from "node:fs";

const pkgPath = new URL("../package.json", import.meta.url).pathname;
const level = (process.argv[2] ?? "patch").toLowerCase();
if (!["patch", "minor", "major"].includes(level)) {
  console.error(`✖ 未知版本级别：${level}（仅支持 patch / minor / major）`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
const m = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)/);
if (!m) {
  console.error(`✖ package.json 当前版本号不是 semver：${pkg.version}`);
  process.exit(1);
}
const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
const next = level === "major" ? [maj + 1, 0, 0]
  : level === "minor" ? [maj, min + 1, 0]
    : [maj, min, pat + 1];

pkg.version = next.join(".");
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log(`✓ 版本号：${[maj, min, pat].join(".")} → ${pkg.version}（${level}）`);
