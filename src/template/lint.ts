import type { LintIssue, Manifest } from "../types";
import { parseThemeCss } from "../core/css/parse";
import { loadTemplate } from "./loader";
import { Md2mpError } from "../cli/errors";
import { formatLintText } from "../lint/engine";

/** 对 CSS 文本执行模板层 lint（复用 parseThemeCss 收集的命中） */
export function lintTemplateCss(cssText: string, manifest?: Manifest): LintIssue[] {
  const { lint } = parseThemeCss(cssText);
  // 去掉 CSS 注释后再做变量检查，避免注释中的示例 var(--x) 误报
  const cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  // CSS 变量引用检查：var(--x) 是否在 manifest.variables 或 :root 中声明
  const declared = new Set<string>((manifest?.variables ?? []).map((v) => v.key));
  // :root 声明已在 parseThemeCss.rootVars，这里再做一次简单正则补充
  for (const m of cleanCss.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]!);

  for (const m of cleanCss.matchAll(/var\(\s*(--[\w-]+)/g)) {
    const key = m[1]!;
    if (!declared.has(key)) {
      lint.push({
        ruleId: "MP044",
        level: "error",
        message: `CSS 使用未定义变量 ${key}`,
        snippet: key,
      });
    }
  }

  // position: fixed / sticky
  if (/(^|[;{]\s*)position\s*:\s*(fixed|sticky)/i.test(cssText)) {
    lint.push({ ruleId: "MP050", level: "error", message: "theme.css 含 position:fixed/sticky，公众号不生效" });
  }

  // 去重
  return dedupeIssues(lint);
}

export function dedupeIssues(issues: LintIssue[]): LintIssue[] {
  const seen = new Set<string>();
  const out: LintIssue[] = [];
  for (const i of issues) {
    const key = `${i.ruleId}|${i.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

/** 对模板包执行完整 lint */
export async function lintTemplatePackage(path: string, cliVersion?: string): Promise<LintIssue[]> {
  let result;
  try {
    result = await loadTemplate(path);
  } catch (err) {
    if (err instanceof Md2mpError) throw err;
    throw new Md2mpError(
      `无法加载模板包：${path}`,
      err instanceof Error ? err.message : String(err),
      "请确认文件是合法的 md2mp 模板 ZIP。",
      3,
    );
  }
  const issues = [...result.lint, ...lintTemplateCss(result.template.css, result.template.manifest)];

  // compat.cli 校验
  if (cliVersion && result.template.manifest.compat?.cli) {
    const range = result.template.manifest.compat.cli;
    if (!semverSatisfies(cliVersion, range)) {
      issues.push({
        ruleId: "MP003",
        level: "warn",
        message: `模板要求 CLI ${range}，当前为 ${cliVersion}，可能不兼容`,
      });
    }
  }

  return dedupeIssues(issues);
}

/** 极简 semver range 校验：支持 >=x.y.z / ^x.y.z / 精确 */
export function semverSatisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return true;
  const r = range.trim();
  const m = r.match(/^(>=|>|<=|<|\^|~)?\s*v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return true;
  const [, op, a, b, c] = m;
  const target = [Number(a), Number(b), Number(c)];
  const cmp = compareSemver(v, target as [number, number, number]);
  switch (op) {
    case ">=": return cmp >= 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case "<": return cmp < 0;
    case "^":
      // semver: ^0.x.y → >=0.x.y <0.(x+1).0；^a.b.c → >=a.b.c <(a+1).0.0
      if (target[0] === 0) return v[0] === 0 && v[1] === target[1] && cmp >= 0;
      return v[0] === target[0] && cmp >= 0;
    case "~": return v[0] === target[0] && v[1] === target[1] && cmp >= 0;
    default: return cmp === 0;
  }
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

/** 输出 lint 结果文本 */
export function reportLint(issues: LintIssue[]): void {
  console.log(formatLintText(issues));
}
