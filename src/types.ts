/** 全局共享类型定义 */

/** frontmatter 元数据 */
export interface Frontmatter {
  title?: string;
  author?: string;
  cover?: string;
  digest?: string;
  tags?: string[];
  /** 单篇关闭章节编号 */
  numbering?: boolean;
  [key: string]: unknown;
}

/** 解析后的文档 */
export interface Doc {
  body: string;
  meta: Frontmatter;
  /** 源文件绝对路径（用于 lint 错误定位） */
  sourcePath?: string;
}

/** manifest 变量定义 */
export interface VariableDef {
  key: string;
  label?: string;
  type: "color" | "length" | "text" | "enum";
  default?: string;
  options?: string[];
}

/** manifest 资源定义 */
export interface AssetDef {
  name: string;
  file: string;
}

/** manifest 预设 */
export interface Preset {
  name: string;
  variables: Record<string, string>;
}

/** 页头/页脚注入配置 */
export interface InjectConfig {
  articleHead?: string;
  articleFoot?: string;
}

export interface TypographyConfig {
  autoSpacing?: boolean;
  codeIndentPreserve?: boolean;
  taskListGlyph?: boolean;
  headingNumbering?: boolean;
  hr?: "plain" | "diamond" | "none";
  figureCaption?: boolean;
  tableZebra?: boolean;
}

export interface HighlightConfig {
  enable?: boolean;
}

export interface PublishConfig {
  coverDefault?: string;
  autoDigest?: boolean;
}

export interface MarkdownConfig {
  breaks?: boolean;
}

/** 模板清单（校验后） */
export interface Manifest {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  license?: string;
  compat?: { cli?: string };
  entry: { css: string; previewJs?: string; previewHtml?: string };
  variables?: VariableDef[];
  presets?: Preset[];
  assets?: AssetDef[];
  inject?: InjectConfig;
  typography?: TypographyConfig;
  markdown?: MarkdownConfig;
  highlight?: HighlightConfig;
  publish?: PublishConfig;
  [key: string]: unknown;
}

/** 解包后的模板（内存中） */
export interface Template {
  manifest: Manifest;
  /** entry.css 的文本内容 */
  css: string;
  /** 注册资源 name -> bytes */
  assets: Map<string, Uint8Array>;
  /** 全部文件路径 -> bytes（相对 ZIP 根） */
  files: Map<string, Uint8Array>;
  /** 模板来源路径（内置模板为 '<builtin>'） */
  sourcePath: string;
}

/** 图片处理模式 */
export type ImageMode = "upload" | "data" | "link";

/** lint 级别 */
export type LintLevel = "error" | "warn";

/** lint 命中项 */
export interface LintIssue {
  ruleId: string;
  level: LintLevel;
  message: string;
  file?: string;
  line?: number;
  snippet?: string;
}

/** 图片管线统计 */
export interface ImageStats {
  total: number;
  uploaded: number;
  embedded: number;
  linked: number;
  failed: number;
  /** upload 模式凭据缺失而降级为 data 的张数 */
  degraded: number;
}

/** 渲染输入选项 */
export interface RenderOptions {
  template: Template;
  imageMode: ImageMode;
  /** 最终生效的变量表（已按优先级合并） */
  variables: Record<string, string>;
  /** 当前 preset 名称（用于注入元信息提示） */
  presetName?: string;
  /** CLI 版本（compat 校验用） */
  cliVersion?: string;
}

/** 渲染输出 */
export interface RenderResult {
  /** 带内联样式的文章片段（根节点 section#js_article，剥除 class/id） */
  articleHtml: string;
  /** 预览页完整 HTML 字符串 */
  previewHtml: string;
  /** lint 命中项 */
  lint: LintIssue[];
  /** 解析后的元数据（title/digest 已回填默认值） */
  meta: Frontmatter & { title: string; digest: string };
  /** 图片统计 */
  imageStats: ImageStats;
}

/** 已保存的公众号账号 */
export interface MpAccount {
  /** 用户自定义的短别名，用于 --account 指定 */
  alias: string;
  /** 公众号名称（备注，可选） */
  name?: string;
  appId: string;
  secret: string;
  createdAt: string;
  updatedAt: string;
}

/** 账号库文件结构（~/.md2mp/accounts.json） */
export interface AccountStoreData {
  version: 1;
  defaultAlias?: string;
  accounts: MpAccount[];
}

/** 已注册的模板（~/.md2mp/templates.json） */
export interface RegisteredTemplate {
  alias: string;
  /** 展示名（来自 manifest.name，可被用户覆盖） */
  name: string;
  /** manifest.id */
  templateId: string;
  version: string;
  /** 导入时的源路径（仅作记录，运行时使用本地副本） */
  source: string;
  /** 本地副本绝对路径（~/.md2mp/templates/<alias>.zip） */
  zipPath: string;
  /** 副本字节数 */
  bytes: number;
  addedAt: string;
  updatedAt: string;
}

/** 模板注册表文件结构 */
export interface TemplateStoreData {
  version: 1;
  defaultAlias?: string;
  templates: RegisteredTemplate[];
}

/** 退出码 */
export enum ExitCode {
  OK = 0,
  ARGS = 1,
  INPUT_MISSING = 2,
  TEMPLATE_INVALID = 3,
  RENDER = 4,
  NETWORK = 5,
  CREDENTIAL = 6,
}
