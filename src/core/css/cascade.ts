import type { Declaration } from "./parse";
import { expandVarsInValue } from "./vars";

/**
 * 合并声明列表：按传入顺序后者覆盖前者；important 声明始终优先于普通声明。
 * 保证输出顺序稳定（按首次出现的属性顺序）。
 */
export function mergeDeclarations(decls: Declaration[], vars: Record<string, string>): Map<string, string> {
  const normal = new Map<string, string>();
  const important = new Map<string, string>();

  for (const d of decls) {
    const prop = d.prop.toLowerCase();
    const value = expandVarsInValue(d.value, vars).trim();
    if (!value) continue;
    if (d.important) {
      important.set(prop, value);
    } else {
      // important 已存在的属性，普通声明不覆盖
      if (!important.has(prop)) normal.set(prop, value);
    }
  }

  // important 覆盖同名普通声明
  for (const [k, v] of important) normal.set(k, v);
  return normal;
}

/** 将声明 map 序列化为 style 字符串（顺序稳定） */
export function serializeStyle(decls: Map<string, string>): string {
  const parts: string[] = [];
  for (const [prop, value] of decls) {
    parts.push(`${prop}:${value}`);
  }
  return parts.join(";");
}

/** 解析元素已有的 inline style 为 Declaration[]（视为最低优先级） */
export function parseInlineStyle(style: string | undefined, line = 0): Declaration[] {
  if (!style) return [];
  const out: Declaration[] = [];
  for (const seg of style.split(";")) {
    const idx = seg.indexOf(":");
    if (idx < 0) continue;
    const prop = seg.slice(0, idx).trim();
    let value = seg.slice(idx + 1).trim();
    const important = /!important\s*$/i.test(value);
    if (important) value = value.replace(/!important\s*$/i, "").trim();
    if (!prop || !value) continue;
    out.push({ prop, value, important, line });
  }
  return out;
}
