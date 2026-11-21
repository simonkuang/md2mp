/**
 * shell 补全引擎：`md2mp __complete <words...>`（内部命令）输出候选词，每行一个。
 *
 * 设计：全部补全逻辑集中在 getCandidates() 一处（上下文感知：命令树、值-flag、
 * 模板/账号/预设/封面动态候选），六种 shell 脚本只负责收集当前词并调用它。
 * 补全永不抛错、永不写文件：任何读取失败（注册表损坏等）静默返回已有候选。
 */
import { listAccounts, getMd2mpHome } from "../account/store";
import { readTemplateStore, resolveTemplateRef } from "../template/registry";
import { loadTemplate } from "../template/loader";
import { generateCompletionScript, type ShellName } from "./completion-scripts";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const SHELLS: readonly ShellName[] = ["bash", "zsh", "fish", "powershell", "nushell", "elvish"];

/* ---------- 命令树模型 ---------- */

type ValueProvider = "template" | "account" | "image-mode" | "preset" | "cover";

interface FlagDef {
  /** 长名（以 -- 开头） */
  name: string;
  short?: string;
  /** 是否消费一个值；字符串 = 有动态候选提供方 */
  value?: ValueProvider | true;
}

type ArgKind = "file" | "shell" | "free";

interface CmdDef {
  name: string;
  flags: FlagDef[];
  children?: CmdDef[];
  /** 位置参数类型，按顺序；超出范围表示不再接受参数 */
  args?: ArgKind[];
}

const F = (name: string, short?: string, value?: FlagDef["value"]): FlagDef => ({ name, short, value });

const GLOBAL_FLAGS: FlagDef[] = [F("--version", "-v"), F("--help", "-h"), F("--quiet", "-q"), F("--no-color")];

const TREE: CmdDef = {
  name: "md2mp",
  flags: GLOBAL_FLAGS,
  children: [
    {
      name: "build",
      flags: [
        F("--template", "-t", "template"), F("--out", "-o", true), F("--var", "-V", true),
        F("--preset", "-p", "preset"), F("--image-mode", undefined, "image-mode"),
        F("--account", undefined, "account"), F("--standalone"), F("--json"),
      ],
      args: ["file"],
    },
    {
      name: "preview",
      flags: [
        F("--template", "-t", "template"), F("--var", "-V", true), F("--preset", "-p", "preset"),
        F("--image-mode", undefined, "image-mode"), F("--watch"), F("--port", undefined, true), F("--open"),
      ],
      args: ["file"],
    },
    {
      name: "publish",
      flags: [
        F("--template", "-t", "template"), F("--var", "-V", true), F("--preset", "-p", "preset"),
        F("--cover", undefined, "cover"), F("--account", undefined, "account"), F("--dry-run"), F("--json"),
      ],
      args: ["file"],
    },
    { name: "lint", flags: [F("--template", "-t", "template"), F("--json")], args: ["file"] },
    { name: "rules", flags: [] },
    {
      name: "completion",
      flags: [],
      args: ["shell"],
      children: [{ name: "install", flags: [], args: ["shell"] }],
    },
    {
      name: "account",
      flags: [],
      children: [
        { name: "add", flags: [F("--appid", undefined, true), F("--secret", undefined, true), F("--name", "-n", true), F("--default", "-d"), F("--json")], args: ["free"] },
        { name: "import", flags: [F("--json")], args: ["file"] },
        { name: "list", flags: [F("--show-secret"), F("--json")] },
        { name: "show", flags: [F("--show-secret"), F("--json")], args: ["free"] },
        { name: "update", flags: [F("--alias", undefined, true), F("--name", "-n", true), F("--appid", undefined, true), F("--secret", undefined, true), F("--json")], args: ["free"] },
        { name: "remove", flags: [F("--json")], args: ["free"] },
        { name: "default", flags: [F("--json")], args: ["free"] },
      ],
    },
    {
      name: "template",
      flags: [],
      children: [
        { name: "init", flags: [], args: ["file"] },
        { name: "pack", flags: [F("--out", "-o", true)], args: ["file"] },
        { name: "lint", flags: [F("--json")], args: ["file"] },
        { name: "add", flags: [F("--name", "-n", true), F("--default", "-d"), F("--json")], args: ["free", "file"] },
        { name: "import", flags: [F("--json")], args: ["file"] },
        { name: "list", flags: [F("--json")] },
        { name: "show", flags: [F("--json")], args: ["free"] },
        { name: "update", flags: [F("--alias", undefined, true), F("--name", "-n", true), F("--file", "-f", true), F("--json")], args: ["free"] },
        { name: "remove", flags: [F("--json")], args: ["free"] },
        { name: "default", flags: [F("--json")], args: ["free"] },
      ],
    },
  ],
};

/* ---------- 动态候选提供方 ---------- */

function templateRefs(): string[] {
  const out = ["builtin", "default"];
  try {
    for (const t of readTemplateStore().templates) out.push(t.alias);
  } catch {
    // 注册表不可用：保留保留字
  }
  return out;
}

function accountAliases(): string[] {
  try {
    return listAccounts().map((a) => a.alias);
  } catch {
    return [];
  }
}

interface TemplateInfo {
  presets: string[];
  assets: string[];
}

/** 模板清单信息缓存（__complete 入口先 prefetch 再走同步读取） */
const templateInfoCache = new Map<string, TemplateInfo | null>();

function templateInfoSync(ref?: string): TemplateInfo | null {
  const key = ref ?? "<default>";
  return templateInfoCache.get(key) ?? null;
}

/** 预热 words 中可能用到的模板信息（-t/--template 显式引用 + 默认模板） */
export async function prefetchCandidates(words: string[]): Promise<void> {
  const refs = new Set<string | undefined>([undefined]);
  for (let i = 0; i < words.length; i++) {
    const tok = words[i]!;
    if (tok === "-t" || tok === "--template") refs.add(words[i + 1] || undefined);
    else if (tok.startsWith("--template=")) refs.add(tok.slice("--template=".length) || undefined);
  }
  await Promise.all([...refs].map(async (ref) => {
    const key = ref ?? "<default>";
    let info: TemplateInfo | null = null;
    try {
      const resolved = resolveTemplateRef(ref || undefined);
      const { template } = await loadTemplate(resolved.builtin ? "builtin" : resolved.sourcePath!);
      info = {
        presets: (template.manifest.presets ?? []).map((p) => p.name),
        assets: (template.manifest.assets ?? []).map((a) => `asset:${a.name}`),
      };
    } catch {
      info = null;
    }
    templateInfoCache.set(key, info);
  }));
}

/* ---------- 候选引擎 ---------- */

export function getCandidates(words: string[]): string[] {
  // 防御：个别 shell 调用约定会把命令名一并传入，剥离（bash/zsh 测试均已按各自约定传入）
  if (words.length > 0 && words[0] === "md2mp") words = words.slice(1);
  const cur = words.length > 0 ? words[words.length - 1]! : "";
  const done = words.slice(0, -1);

  const valueFlagFor = (node: CmdDef, tok: string): FlagDef | undefined =>
    node.flags.find((f) => f.value !== undefined && (f.name === tok || f.short === tok));

  // 沿命令树走一遍已完成 token
  let node: CmdDef = TREE;
  let positionalIdx = 0;
  let pending: FlagDef | null = null;
  let templateRef: string | undefined;

  let i = 0;
  while (i < done.length) {
    const tok = done[i]!;
    if (tok.startsWith("-") && tok !== "-") {
      if (tok.includes("=")) {
        const name = tok.slice(0, tok.indexOf("="));
        const f = node.flags.find((fl) => fl.name === name);
        if (f?.value === "template") templateRef = tok.slice(tok.indexOf("=") + 1);
        i += 1;
        continue;
      }
      const f = valueFlagFor(node, tok);
      if (f) {
        if (i + 1 < done.length) {
          if (f.value === "template") templateRef = done[i + 1]!;
          i += 2;
          continue;
        }
        pending = f;
        break;
      }
      i += 1;
      continue;
    }
    // 位置 token：优先尝试下钻子命令
    if (node.children && positionalIdx === 0) {
      const child = node.children.find((c) => c.name === tok);
      if (child) {
        node = child;
        i += 1;
        continue;
      }
    }
    positionalIdx += 1;
    i += 1;
  }

  const providers = (kind: ValueProvider): string[] => {
    switch (kind) {
      case "template":
        return templateRefs();
      case "account":
        return accountAliases();
      case "image-mode":
        return ["upload", "data", "link"];
      case "preset":
        return templateInfoSync(templateRef)?.presets ?? [];
      case "cover":
        return ["auto", ...(templateInfoSync(templateRef)?.assets ?? [])];
    }
  };

  // 1) 前一个 token 是待取值 flag → 值候选
  if (pending?.value && pending.value !== true) {
    return providers(pending.value);
  }

  // 2) 正在输入 flag → flag 名候选（长名）
  if (cur.startsWith("-") && cur !== "-") {
    return node.flags.map((f) => f.name);
  }

  // 3) 子命令名；若该节点同时接受位置参数（如 completion 的 shell 名），合并候选
  if (node.children && positionalIdx === 0) {
    const children = node.children.map((c) => c.name);
    if (node.args?.[0] === "shell") return [...children, ...SHELLS];
    return children;
  }

  // 4) 位置参数按类型
  const kind = node.args?.[positionalIdx];
  if (kind === "shell") return [...SHELLS];
  // "file" / "free" / 超出参数范围 → 无候选（shell 回退到文件补全）
  return [];
}

/* ---------- shell 检测与 completion 命令支撑 ---------- */

export function detectShell(): ShellName | undefined {
  if (process.platform === "win32") return "powershell";
  const sh = (process.env.SHELL ?? "").split("/").pop() ?? "";
  if (!sh && process.env.PSModulePath) return "powershell";
  switch (sh) {
    case "zsh": return "zsh";
    case "bash": return "bash";
    case "fish": return "fish";
    case "nu": case "nushell": return "nushell";
    case "elvish": return "elvish";
    case "pwsh": case "powershell": return "powershell";
    default: return undefined;
  }
}

export function completionScript(shell: ShellName): string {
  return generateCompletionScript(shell);
}

/* ---------- completion install ---------- */

const MARKER = "# md2mp completion";

const completionsDir = (): string => join(getMd2mpHome(), "completions");

function rcHookTarget(shell: ShellName): { rcFile: string | null; line: string | null; manualHint?: string } {
  const home = homedir();
  switch (shell) {
    case "bash":
      return { rcFile: join(home, ".bashrc"), line: `source ~/.md2mp/completions/md2mp.bash   ${MARKER}` };
    case "zsh":
      return { rcFile: join(home, ".zshrc"), line: `source ~/.md2mp/completions/md2mp.zsh   ${MARKER}` };
    case "fish":
      // fish 自动加载 completions 目录，无需改 rc
      return { rcFile: null, line: null };
    case "powershell": {
      const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PROFILE"], { encoding: "utf8" });
      if (probe.status === 0 && probe.stdout.trim()) {
        return { rcFile: probe.stdout.trim(), line: `. $HOME/.md2mp/completions/md2mp.ps1  ${MARKER}` };
      }
      return { rcFile: null, line: null, manualHint: "未找到 pwsh：请在 $PROFILE 中添加 `. ~/.md2mp/completions/md2mp.ps1`" };
    }
    case "nushell": {
      const probe = spawnSync("nu", ["-c", "$nu.config-path"], { encoding: "utf8" });
      if (probe.status === 0 && probe.stdout.trim()) {
        const dest = join(completionsDir(), "md2mp.nu");
        return { rcFile: probe.stdout.trim(), line: `source '${dest}'  ${MARKER}` };
      }
      return { rcFile: null, line: null, manualHint: "未找到 nu：请在 $nu.config-path 中添加 `source '~/.md2mp/completions/md2mp.nu'`" };
    }
    case "elvish":
      return { rcFile: join(home, ".config", "elvish", "rc.elv"), line: `eval (md2mp completion elvish | slurp)  ${MARKER}` };
  }
}

export interface InstallResult {
  shell: ShellName;
  /** 写入的脚本文件路径 */
  file: string;
  /** 被追加挂载行的 rc 文件（fish / 无法定位 rc 时为 null） */
  rcFile: string | null;
  /** rc 本已挂载（幂等跳过追加） */
  rcAlreadyHooked: boolean;
  /** 无法自动定位 rc 时的手动安装指引 */
  manualHint?: string;
}

export function installCompletion(shell: ShellName): InstallResult {
  const dir = completionsDir();
  mkdirSync(dir, { recursive: true });
  const extMap: Record<ShellName, string> = {
    bash: "bash", zsh: "zsh", fish: "fish", powershell: "ps1", nushell: "nu", elvish: "elv",
  };
  const file = join(dir, `md2mp.${extMap[shell]}`);
  writeFileSync(file, completionScript(shell), "utf8");

  const hook = rcHookTarget(shell);
  let rcAlreadyHooked = false;
  if (hook.rcFile && hook.line) {
    const existing = existsSync(hook.rcFile) ? readFileSync(hook.rcFile, "utf8") : "";
    if (existing.includes(MARKER)) {
      rcAlreadyHooked = true;
    } else {
      appendFileSync(hook.rcFile, (existing.length > 0 && !existing.endsWith("\n") ? "\n" : "") + hook.line + "\n");
    }
  }
  return { shell, file, rcFile: hook.rcFile, rcAlreadyHooked, manualHint: hook.manualHint };
}
