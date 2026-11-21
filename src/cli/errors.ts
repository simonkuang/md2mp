import { ExitCode } from "../types";

/**
 * md2mp 统一错误：现象 → 原因 → 建议 三段式。
 */
export class Md2mpError extends Error {
  readonly reason: string;
  readonly suggestion: string;
  readonly exitCode: ExitCode;

  constructor(
    message: string,
    reason: string,
    suggestion: string,
    exitCode: ExitCode = ExitCode.RENDER,
  ) {
    super(message);
    this.name = "Md2mpError";
    this.reason = reason;
    this.suggestion = suggestion;
    this.exitCode = exitCode;
  }

  /** 三段式格式化输出 */
  format(): string {
    const lines = [
      `✖ 错误：${this.message}`,
      `  原因：${this.reason}`,
      `  建议：${this.suggestion}`,
    ];
    return lines.join("\n");
  }
}

/** 便捷构造器 */
export const Errors = {
  args: (what: string, reason: string, suggestion: string) =>
    new Md2mpError(what, reason, suggestion, ExitCode.ARGS),
  inputMissing: (path: string) =>
    new Md2mpError(
      `输入文件不存在：${path}`,
      "文件路径错误或文件尚未创建。",
      "请检查路径拼写，必要时使用绝对路径。",
      ExitCode.INPUT_MISSING,
    ),
  template: (what: string, reason: string, suggestion: string) =>
    new Md2mpError(what, reason, suggestion, ExitCode.TEMPLATE_INVALID),
  network: (what: string, reason: string, suggestion: string) =>
    new Md2mpError(what, reason, suggestion, ExitCode.NETWORK),
  credential: (what: string, reason: string, suggestion: string) =>
    new Md2mpError(what, reason, suggestion, ExitCode.CREDENTIAL),
};
