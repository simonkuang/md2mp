/**
 * 六种 shell 的补全脚本生成器。
 * 脚本职责极薄：收集当前词 → 调用 `md2mp __complete` → 按需回退文件补全。
 * 候选过滤由各 shell 自带机制完成（compgen -W / compadd / fish / PS / nu / elvish）。
 */

export type ShellName = "bash" | "zsh" | "fish" | "powershell" | "nushell" | "elvish";

const bash = (): string => `# md2mp bash 补全 —— 由 \`md2mp completion bash\` 生成，请勿手改
_md2mp_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local candidates
  candidates="$(md2mp __complete "\${COMP_WORDS[@]:1}" 2>/dev/null)" || candidates=""
  if [ -n "$candidates" ]; then
    COMPREPLY=($(compgen -W "$candidates" -- "$cur"))
  else
    COMPREPLY=($(compgen -f -- "$cur"))
  fi
}
complete -F _md2mp_complete md2mp
`;

const zsh = (): string => `#compdef md2mp
# md2mp zsh 补全 —— 由 \`md2mp completion zsh\` 生成，请勿手改（需在 compinit 之后 source）
_md2mp_complete() {
  # zsh：words[1] 是命令名；\${words[@]:1} 为 0 基切片（bash 兼容语义），恰好跳过命令名。
  # 尾随空格时 zsh 不一定给出空元素，按 CURRENT 与 $#words 比较后补一个空串作为当前词。
  local -a args
  args=("\${words[@]:1}")
  (( CURRENT > $#words )) && args+=("")
  # compinit 尚未运行时兜底初始化（幂等）
  if (( ! \${+functions[compdef]} )); then
    autoload -Uz compinit && compinit
  fi
  local out
  out="$(md2mp __complete "\${(@)args}" 2>/dev/null)" || out=""
  if [ -n "$out" ]; then
    local -a candidates
    candidates=("\${(f)out}")
    compadd -- "\${candidates[@]}"
  else
    _files
  fi
}
compdef _md2mp_complete md2mp
`;

const fish = (): string => `# md2mp fish 补全 —— 由 \`md2mp completion fish\` 生成
# 放入 ~/.config/fish/completions/ 后自动加载，无需 source；无候选时 fish 自动回退文件补全
function __md2mp_words
    set -l tokens (commandline -opc)
    set -l cur (commandline -ct)
    set tokens $tokens "$cur"
    if test (count $tokens) -ge 2
        md2mp __complete $tokens[2..-1] 2>/dev/null
    end
end
complete -c md2mp -a '(__md2mp_words)'
`;

const powershell = (): string => `# md2mp powershell 补全 —— 由 \`md2mp completion powershell\` 生成
# 安装：将本文件内容加入 $PROFILE（或运行 md2mp completion install powershell 自动添加）
Register-ArgumentCompleter -Native -CommandName md2mp -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $elements = @($commandAst.CommandElements | Select-Object -Skip 1)
    if ($elements.Count -gt 0 -and $elements[-1] -eq $wordToComplete) {
        $elements = $elements[0..($elements.Count - 2)]
    }
    $words = @($elements) + @($wordToComplete)
    $out = & md2mp __complete @words 2>$null
    $out | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;

const nushell = (): string => `# md2mp nushell 补全 —— 由 \`md2mp completion nushell\` 生成（需 nu >= 0.87）
# 安装：在 $nu.config-path 中添加 source '~/.md2mp/completions/md2mp.nu'
def "__md2mp complete" [context: string] {
    let parts = ($context | str trim | split row " ")
    let words = (if ($context | str ends-with " ") { $parts | skip 1 | append "" } else { $parts | skip 1 })
    if ($words | is-empty) { return }
    let last = ($words | last)
    md2mp __complete ...$words | where {|w| $w | str starts-with $last }
}
extern "md2mp" [
    --template(-t): string@"__md2mp complete"
    --out(-o): string@"__md2mp complete"
    --var(-V): string@"__md2mp complete"
    --preset(-p): string@"__md2mp complete"
    --image-mode: string@"__md2mp complete"
    --account: string@"__md2mp complete"
    --cover: string@"__md2mp complete"
    --port: string@"__md2mp complete"
    --standalone
    --json
    --watch
    --open
    --dry-run
    --version(-v)
    --help(-h)
    --quiet(-q)
    --no-color
    ...args: string@"__md2mp complete"
]
`;

const elvish = (): string => `# md2mp elvish 补全 —— 由 \`md2mp completion elvish\` 生成（需 elvish >= 0.18）
fn md2mp-completer {|@args|
    var cand = [(md2mp __complete $@args[1:] | from-lines)]
    if (== (count $cand) 0) {
        put $@(edit:complete-filename $@args)
    } else {
        put $@cand
    }
}
edit:completion:arg-completer[md2mp] = $md2mp-completer~
`;

const SHELL_SCRIPTS: Record<ShellName, () => string> = {
  bash, zsh, fish, powershell, nushell, elvish,
};

export function generateCompletionScript(shell: ShellName): string {
  return SHELL_SCRIPTS[shell]();
}

/** 各 shell 脚本的关键锚点（供测试断言） */
export const SCRIPT_ANCHORS: Record<ShellName, string> = {
  bash: "complete -F _md2mp_complete md2mp",
  zsh: "compdef _md2mp_complete md2mp",
  fish: "complete -c md2mp -a '(__md2mp_words)'",
  powershell: "Register-ArgumentCompleter -Native -CommandName md2mp",
  nushell: 'extern "md2mp"',
  elvish: "edit:completion:arg-completer[md2mp]",
};
