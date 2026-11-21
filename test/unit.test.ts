import { describe, it, expect } from "bun:test";
import * as cheerio from "cheerio";
import { parseThemeCss, calcSpecificity } from "../src/core/css/parse";
import { resolveVariables, expandVarsInValue } from "../src/core/css/vars";
import { mergeDeclarations, parseInlineStyle, serializeStyle } from "../src/core/css/cascade";
import { inlineStyles } from "../src/core/css/inline";
import { applyTypography } from "../src/core/typography";
import { lintContainerClasses } from "../src/lint/engine";
import { loadTemplateFromBytes } from "../src/template/loader";
import { numberToChinese, autoChineseSpacing } from "../src/core/typography";
import { makeDigest } from "../src/core/frontmatter";
import { semverSatisfies } from "../src/template/lint";
import { parseManifest } from "../src/template/manifest";
import { zipSync, strToU8 } from "fflate";

describe("mpcss · specificity", () => {
  it("计算 id/class/tag 优先级", () => {
    expect(calcSpecificity("#js_article p")).toEqual([1, 0, 1]);
    expect(calcSpecificity("#js_article .hljs-keyword")).toEqual([1, 1, 0]);
    expect(calcSpecificity("#js_article tr.mp-alt td")).toEqual([1, 1, 2]);
  });
  it(":where 不贡献优先级", () => {
    expect(calcSpecificity(":where(.a) p")[1]).toBe(0);
  });
});

describe("mpcss · parse", () => {
  it("丢弃 @media/@font-face 并给出 lint", () => {
    const r = parseThemeCss("@media screen { p { color: red } } @font-face { src: url(x) } p { color: blue }");
    expect(r.rules.length).toBe(1);
    expect(r.lint.some((i) => i.ruleId === "MP041")).toBe(true);
    expect(r.lint.some((i) => i.ruleId === "MP042")).toBe(true);
  });
  it("丢弃伪元素规则", () => {
    const r = parseThemeCss("p::before { content: 'x' } p { color: red }");
    expect(r.rules.length).toBe(1);
    expect(r.lint.some((i) => i.ruleId === "MP040")).toBe(true);
  });
  it("提取 :root 变量", () => {
    const r = parseThemeCss(":root { --primary: #576b95; } p { color: var(--primary) }");
    expect(r.rootVars["--primary"]).toBe("#576b95");
  });
  it("拆分多选择器", () => {
    const r = parseThemeCss("h1, h2 { color: red }");
    expect(r.rules.length).toBe(2);
    expect(r.rules[0]!.selector).toBe("h1");
    expect(r.rules[1]!.selector).toBe("h2");
  });
});

describe("mpcss · vars", () => {
  it("展开变量与 fallback", () => {
    const r = resolveVariables([{ "--a": "var(--b, red)" }, { "--b": "blue" }]);
    expect(r.vars["--a"]).toBe("blue");
  });
  it("未定义变量记录 MP044", () => {
    const r = resolveVariables([{ "--a": "var(--missing)" }]);
    expect(r.lint.some((i) => i.ruleId === "MP044")).toBe(true);
  });
  it("expandVarsInValue 展开", () => {
    expect(expandVarsInValue("var(--x, 1px)", {})).toBe("1px");
    expect(expandVarsInValue("var(--x)", { "--x": "#fff" })).toBe("#fff");
  });
});

describe("mpcss · cascade", () => {
  it("后者覆盖前者、序列化稳定", () => {
    const decls = [
      { prop: "color", value: "red", important: false, line: 1 },
      { prop: "margin", value: "0", important: false, line: 2 },
      { prop: "color", value: "blue", important: false, line: 3 },
    ];
    const m = mergeDeclarations(decls, {});
    expect(serializeStyle(m)).toBe("color:blue;margin:0");
  });
  it("important 覆盖普通声明", () => {
    const decls = [
      { prop: "color", value: "red", important: false, line: 1 },
      { prop: "color", value: "blue", important: true, line: 2 },
    ];
    expect(mergeDeclarations(decls, {}).get("color")).toBe("blue");
  });
  it("解析原有 inline style", () => {
    const d = parseInlineStyle("color:red; margin: 0 !important");
    expect(d.length).toBe(2);
    expect(d[1]!.important).toBe(true);
  });
});

describe("loader · 安全", () => {
  it("拒绝 zip-slip", () => {
    const evil = zipSync({ "manifest.json": strToU8("{}"), "../../etc/passwd": strToU8("x") });
    expect(() => loadTemplateFromBytes(evil, "evil.zip")).toThrow(/危险路径/);
  });
  it("缺 manifest 报错", () => {
    const z = zipSync({ "theme.css": strToU8("p{}") });
    expect(() => loadTemplateFromBytes(z, "x.zip")).toThrow(/manifest.json/);
  });
  it("非白名单扩展名拒绝", () => {
    const m = { schemaVersion: 1, id: "x", name: "X", version: "1.0.0", entry: { css: "theme.css" } };
    const z = zipSync({
      "manifest.json": strToU8(JSON.stringify(m)),
      "theme.css": strToU8("p{}"),
      "evil.exe": strToU8("MZ"),
    });
    expect(() => loadTemplateFromBytes(z, "x.zip")).toThrow(/不允许的文件类型/);
  });
});

describe("manifest schema", () => {
  it("拒绝非法 id", () => {
    const m = { schemaVersion: 1, id: "Bad_ID", name: "X", version: "1.0.0", entry: { css: "a.css" } };
    expect(() => parseManifest(m)).toThrow(/kebab-case/);
  });
  it("enum 变量需 options", () => {
    const m = { schemaVersion: 1, id: "x", name: "X", version: "1.0.0", entry: { css: "a.css" },
      variables: [{ key: "--s", type: "enum", default: "a" }] };
    expect(() => parseManifest(m)).toThrow(/options/);
  });
});

describe("typography & utils", () => {
  it("中文数字", () => {
    expect(numberToChinese(1)).toBe("一");
    expect(numberToChinese(11)).toBe("十一");
    expect(numberToChinese(21)).toBe("二十一");
  });
  it("中英文空格", () => {
    expect(autoChineseSpacing("使用VS Code写代码")).toBe("使用 VS Code 写代码");
  });
  it("摘要截取", () => {
    expect(makeDigest("  a  b  c ")).toBe("a b c");
  });
  it("semver range", () => {
    expect(semverSatisfies("0.1.0", ">=0.1.0")).toBe(true);
    expect(semverSatisfies("0.0.9", ">=0.1.0")).toBe(false);
    expect(semverSatisfies("0.2.0", "^0.1.0")).toBe(false);
  });
});

describe("typography · 表格斑马纹", () => {
  it("多张表格各自独立计数（对齐参考原型）", () => {
    const $ = cheerio.load(`<section id="js_article">
      <table><tr><th>h1</th></tr><tr><td>a</td></tr><tr><td>b</td></tr></table>
      <table><tr><th>h2</th></tr><tr><td>c</td></tr><tr><td>d</td></tr></table>
    </section>`);
    const r = applyTypography($, { tableZebra: true }, {});
    expect(r.zebraRows).toBe(2);
    const alts = $("tr.mp-alt").toArray();
    expect(alts.length).toBe(2);
    // 每张表各自的第 2 行（索引 1）
    expect($(alts[0]!).text()).toBe("a");
    expect($(alts[1]!).text()).toBe("c");
  });
});

describe("mpcss · inline 残留 var", () => {
  it("值中未定义变量报 MP044 且不误报", () => {
    const { rules } = parseThemeCss("p { color: var(--missing); margin: 0 } q { color: red }");
    const $ = cheerio.load(`<section id="js_article"><p>x</p><q>y</q></section>`);
    const lint = inlineStyles($, rules, {});
    expect(lint.filter((i) => i.ruleId === "MP044").length).toBe(1);
    // 变量已定义时不报
    const { rules: r2 } = parseThemeCss("p { color: var(--ok) }");
    const lint2 = inlineStyles(
      cheerio.load(`<section id="js_article"><p>x</p></section>`),
      r2,
      { "--ok": "#fff" },
    );
    expect(lint2.length).toBe(0);
  });
});

describe("lint · 结构类（MP045）", () => {
  it("使用但无样式的 mp-* 类报 MP045；有样式则不报", () => {
    const $ = cheerio.load(
      `<section id="js_article"><section class="mp-tip"><p>x</p></section></section>`,
    );
    const noStyle = parseThemeCss("p { color: red }").rules;
    const issues = lintContainerClasses($, noStyle);
    expect(issues.some((i) => i.ruleId === "MP045" && i.message.includes(".mp-tip"))).toBe(true);

    const styled = parseThemeCss("#js_article section.mp-tip { margin: 0 }").rules;
    const issues2 = lintContainerClasses($, styled);
    expect(issues2.length).toBe(0);
  });
});
