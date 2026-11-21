import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import {
  getCandidates, prefetchCandidates, SHELLS, detectShell, installCompletion, completionScript,
} from "../src/cli/completion";
import { SCRIPT_ANCHORS } from "../src/cli/completion-scripts";
import { addAccount } from "../src/account/store";
import { registerTemplate } from "../src/template/registry";

let home: string;
const savedHome = process.env.MD2MP_HOME;
const savedShell = process.env.SHELL;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "md2mp-comp-"));
  process.env.MD2MP_HOME = home;
  delete process.env.SHELL;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.MD2MP_HOME;
  else process.env.MD2MP_HOME = savedHome;
  if (savedShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = savedShell;
});

function seed(): void {
  addAccount({ alias: "company-a", appId: "wx111", secret: "sec" });
  const manifest = {
    schemaVersion: 1,
    id: "songmo",
    name: "松墨",
    version: "1.0.0",
    entry: { css: "theme.css" },
    presets: [
      { name: "庄重", variables: { "--x": "1" } },
      { name: "典雅", variables: { "--x": "2" } },
      { name: "素净", variables: { "--x": "3" } },
    ],
    assets: [{ name: "header", file: "assets/h.png" }],
  };
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "theme.css": strToU8("#js_article p{color:red}"),
    "assets/h.png": strToU8("png"),
  });
  const zipPath = join(home, "songmo.zip");
  writeFileSync(zipPath, zip);
  registerTemplate({ alias: "songmo", sourcePath: zipPath, name: "松墨", templateId: "songmo", version: "1.0.0" });
}

describe("补全引擎 · 上下文分派", () => {
  it("根位置给出子命令列表", () => {
    const c = getCandidates([""]);
    for (const cmd of ["build", "preview", "publish", "lint", "template", "account", "rules", "completion"]) {
      expect(c).toContain(cmd);
    }
    // 防御：命令名被一并传入时剥离（zsh 1 基约定曾触发此路径）
    expect(getCandidates(["md2mp", ""])).toEqual(c);
  });

  it("位置参数为文件时返回空（shell 回退文件补全）", () => {
    expect(getCandidates(["build", ""])).toEqual([]);
    expect(getCandidates(["build", "article.md", ""])).toEqual([]);
  });

  it("flag 名候选（长名）", () => {
    const c = getCandidates(["build", "--"]);
    for (const f of ["--template", "--preset", "--image-mode", "--account", "--standalone", "--json"]) {
      expect(c).toContain(f);
    }
    expect(getCandidates(["account", "list", "--"])).toContain("--show-secret");
    expect(getCandidates(["account", "list", "--"])).not.toContain("--template");
  });

  it("--image-mode 值候选", () => {
    expect(getCandidates(["build", "--image-mode", ""])).toEqual(["upload", "data", "link"]);
    expect(getCandidates(["preview", "--image-mode", "da"])).toEqual(["upload", "data", "link"]);
  });

  it("-t/--template 候选含注册别名与保留字", () => {
    seed();
    const c = getCandidates(["build", "-t", ""]);
    for (const t of ["songmo", "builtin", "default"]) expect(c).toContain(t);
  });

  it("-p/--preset 候选来自 -t 指定模板（含 = 内联形式）", async () => {
    seed();
    const words = ["build", "--template", "songmo", "-p", ""];
    await prefetchCandidates(words);
    expect(getCandidates(words)).toEqual(["庄重", "典雅", "素净"]);

    const words2 = ["build", "--template=songmo", "-p", ""];
    await prefetchCandidates(words2);
    expect(getCandidates(words2)).toEqual(["庄重", "典雅", "素净"]);
  });

  it("无效模板引用时 preset 候选为空（不抛错）", async () => {
    seed();
    const words = ["build", "--template", "nope", "-p", ""];
    await prefetchCandidates(words);
    expect(getCandidates(words)).toEqual([]);
  });

  it("--account 候选来自账号库", () => {
    seed();
    expect(getCandidates(["publish", "--account", ""])).toEqual(["company-a"]);
  });

  it("--cover 候选 = auto + 模板资产", async () => {
    seed();
    const words = ["publish", "--cover", ""];
    await prefetchCandidates(words);
    expect(getCandidates(words)).toEqual(["auto", "asset:header"]);
  });

  it("容器命令给出子命令；completion 给出 install 与 shell 列表（合并候选）", () => {
    expect(getCandidates(["template", ""])).toContain("add");
    expect(getCandidates(["account", ""])).toContain("update");
    const c = getCandidates(["completion", ""]);
    expect(c).toContain("install");
    for (const s of SHELLS) expect(c).toContain(s);
    expect(getCandidates(["completion", "install", ""])).toEqual([...SHELLS]);
  });
});

describe("补全脚本生成", () => {
  it("六种 shell 各含挂载锚点", () => {
    for (const shell of SHELLS) {
      const script = completionScript(shell);
      expect(script.includes(SCRIPT_ANCHORS[shell])).toBe(true);
    }
  });

  it("脚本都调用 __complete 引擎", () => {
    for (const shell of SHELLS) {
      expect(completionScript(shell)).toContain("md2mp __complete");
    }
  });

  it("detectShell 按 $SHELL 识别", () => {
    process.env.SHELL = "/bin/zsh";
    expect(detectShell()).toBe("zsh");
    process.env.SHELL = "/usr/bin/fish";
    expect(detectShell()).toBe("fish");
  });
});

describe("completion install", () => {
  it("写入脚本到 MD2MP_HOME/completions（fish 无需 rc 挂载）", () => {
    process.env.SHELL = "/usr/bin/fish";
    const r = installCompletion("fish");
    expect(r.rcFile).toBeNull();
    const content = readFileSync(r.file, "utf8");
    expect(content).toContain(SCRIPT_ANCHORS.fish);
  });
});

describe("补全实机验证（bash）", () => {
  it("bash 补全函数返回候选并按前缀过滤", () => {
    seed();
    const file = join(home, "comp.bash");
    writeFileSync(file, completionScript("bash"));
    // PATH 注入 md2mp wrapper：转发到补全引擎（模拟已安装状态）
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    const wrapper = join(binDir, "md2mp");
    const cliAbs = join(new URL("..", import.meta.url).pathname, "src", "cli.ts");
    writeFileSync(wrapper, `#!/usr/bin/env bash\nexec bun run '${cliAbs}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, MD2MP_HOME: home };

    const run = (compWords: string[], cword: number): string => {
      const script = [
        `source '${file}'`,
        `COMP_WORDS=(${compWords.map((w) => `'${w}'`).join(" ")})`,
        `COMP_CWORD=${cword}`,
        `_md2mp_complete`,
        `printf '%s\\n' "\${COMPREPLY[@]}"`,
      ].join("\n");
      const p = Bun.spawnSync(["bash", "-c", script], { env });
      return p.stdout.toString().trim();
    };
    // 空当前词 → 全部模式
    expect(run(["md2mp", "build", "--image-mode", ""], 3)).toBe("upload\ndata\nlink");
    // 前缀过滤
    expect(run(["md2mp", "build", "--image-mode", "up"], 3)).toBe("upload");
    // 模板别名
    const t = run(["md2mp", "build", "-t", ""], 3).split("\n");
    expect(t).toContain("songmo");
    expect(t).toContain("builtin");
  });
});

describe("__complete CLI e2e", () => {
  it("子进程调用返回候选（凭据缺失/注册表损坏也不报错）", async () => {
    seed();
    await prefetchCandidates(["build", "--template", "songmo", "-p", ""]);
    const words = ["build", "--template", "songmo", "-p", ""];
    const p = Bun.spawnSync(
      ["bun", "run", "src/cli.ts", "__complete", ...words],
      { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, MD2MP_HOME: home } },
    );
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString().trim().split("\n");
    expect(out).toEqual(["庄重", "典雅", "素净"]);
  });
});
