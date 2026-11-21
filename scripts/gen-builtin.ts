import { zipSync, strToU8 } from "fflate";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const themeDir = join(ROOT, "themes", "default");

/** 递归收集目录下所有文件 */
function collect(dir: string, prefix = ""): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      Object.assign(out, collect(full, rel));
    } else {
      out[rel] = strToU8(readFileSync(full, "utf8"));
    }
  }
  return out;
}

const files = collect(themeDir);
const zipped = zipSync(files, { level: 6 });
const b64 = Buffer.from(zipped).toString("base64");

const builtinPath = join(ROOT, "src", "template", "builtin.ts");
let src = readFileSync(builtinPath, "utf8");
src = src.replace(
  /(\/\/ @generated:start\n)export const DEFAULT_THEME_B64 = "[^"]*";(\n\/\/ @generated:end)/,
  `$1export const DEFAULT_THEME_B64 = "${b64}";$2`,
);
writeFileSync(builtinPath, src, "utf8");
console.log(`✓ 内置默认模板已生成：${b64.length} base64 字符（${Object.keys(files).length} 个文件）`);
