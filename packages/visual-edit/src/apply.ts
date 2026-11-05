import MagicString from "magic-string";
import type { Expression, JSXAttribute, JSXElement, JSXText, ObjectExpression, ObjectProperty, StringLiteral, TemplateLiteral } from "@babel/types";
import { VisualEditError, findElementAt, parseSource, tagName } from "./ast.js";
import type { SourcePosition } from "./protocol.js";

export type VisualEdit =
  | { kind: "text"; value: string }
  | { kind: "class"; add?: string[]; remove?: string[] }
  | { kind: "style"; prop: string; value: string | number | null }
  | { kind: "attr"; name: "src" | "alt" | "href"; value: string };

export interface ApplyOptions {
  /** Used to choose parser plugins (".tsx" by default). */
  filename?: string;
}

export interface ElementInfo {
  tag: string;
  line: number;
  column: number;
  /** Static text when the element's text is literal, else null. */
  text: string | null;
  className: string | null;
  style: Record<string, string> | null;
  attrs: Partial<Record<"src" | "alt" | "href", string>>;
}

const ATTR_NAMES = new Set(["src", "alt", "href"]);

/**
 * Apply a visual edit to the JSX element whose opening tag starts at `pos` and return the new source.
 * Only the touched span changes; formatting, comments and quote style elsewhere are preserved.
 * Throws VisualEditError when the element can't be found or the value is computed at runtime.
 */
export function applyVisualEdit(source: string, pos: SourcePosition, edit: VisualEdit, opts: ApplyOptions = {}): string {
  const ast = parseSource(source, opts.filename);
  const el = findElementAt(ast, pos.line, pos.column);
  if (!el) throw new VisualEditError("NOT_FOUND", `No JSX element at ${pos.line}:${pos.column}`);
  const s = new MagicString(source);
  switch (edit.kind) {
    case "text":
      editText(s, source, el, edit.value);
      break;
    case "class":
      editClass(s, source, el, edit.add ?? [], edit.remove ?? []);
      break;
    case "style":
      editStyle(s, source, el, edit.prop, edit.value);
      break;
    case "attr":
      if (!ATTR_NAMES.has(edit.name)) throw new VisualEditError("UNSUPPORTED", `Attribute ${String(edit.name)} cannot be edited`);
      editAttr(s, source, el, edit.name, edit.value);
      break;
    default:
      throw new VisualEditError("UNSUPPORTED", "Unknown edit kind");
  }
  return s.toString();
}

/** Describe the element at `pos` (used to prefill the visual edit panel). */
export function describeElement(source: string, pos: SourcePosition, opts: ApplyOptions = {}): ElementInfo {
  const ast = parseSource(source, opts.filename);
  const el = findElementAt(ast, pos.line, pos.column);
  if (!el) throw new VisualEditError("NOT_FOUND", `No JSX element at ${pos.line}:${pos.column}`);
  const loc = el.openingElement.loc!.start;
  const cls = findAttr(el, "className") ?? findAttr(el, "class");
  const style = findAttr(el, "style");
  const attrs: ElementInfo["attrs"] = {};
  for (const name of ["src", "alt", "href"] as const) {
    const a = findAttr(el, name);
    const v = a ? staticString(a.value as Expression | null) : null;
    if (v !== null) attrs[name] = v;
  }
  let styleObj: Record<string, string> | null = null;
  if (style?.value?.type === "JSXExpressionContainer" && style.value.expression.type === "ObjectExpression") {
    styleObj = {};
    for (const p of style.value.expression.properties) {
      if (p.type !== "ObjectProperty") continue;
      const key = propKey(p);
      const val = p.value.type === "StringLiteral" ? p.value.value : p.value.type === "NumericLiteral" ? String(p.value.value) : null;
      if (key && val !== null) styleObj[key] = val;
    }
  }
  return {
    tag: tagName(el.openingElement),
    line: loc.line,
    column: loc.column + 1,
    text: textTarget(el)?.value ?? null,
    className: cls ? classTokensOf(cls)?.join(" ") ?? null : null,
    style: styleObj,
    attrs,
  };
}

// ---------------------------------------------------------------- text

type TextTarget = { kind: "jsxtext"; node: JSXText; value: string } | { kind: "literal"; node: StringLiteral | TemplateLiteral; value: string };

function textTarget(el: JSXElement): TextTarget | null {
  const meaningful = el.children.filter((c) => !(c.type === "JSXText" && c.value.trim() === ""));
  for (const c of meaningful) {
    if (c.type === "JSXText") return { kind: "jsxtext", node: c, value: normaliseJsxText(c.value) };
    if (c.type === "JSXExpressionContainer") {
      const e = c.expression;
      if (e.type === "StringLiteral") return { kind: "literal", node: e, value: e.value };
      if (e.type === "TemplateLiteral" && e.expressions.length === 0) return { kind: "literal", node: e, value: e.quasis[0]?.value.cooked ?? "" };
    }
  }
  return null;
}

/** JSX collapses whitespace that contains newlines; mirror that so the panel shows what renders. */
function normaliseJsxText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((l, i, arr) => (i === 0 ? l.replace(/\s+$/, "") : i === arr.length - 1 ? l.replace(/^\s+/, "") : l.trim()))
    .filter((l) => l.length > 0)
    .join(" ")
    .trim();
}

function editText(s: MagicString, source: string, el: JSXElement, value: string) {
  const open = el.openingElement;
  if (open.selfClosing) {
    if (isVoidTag(tagName(open))) throw new VisualEditError("UNSUPPORTED", `<${tagName(open)}> cannot contain text`);
    // `<p />` → `<p>text</p>`
    const end = open.end!;
    const slash = source.lastIndexOf("/", end - 1);
    s.overwrite(slash, end, `>${jsxTextOrExpr(value)}</${tagName(open)}>`);
    return;
  }
  const target = textTarget(el);
  if (!target) {
    const hasDynamic = el.children.some((c) => c.type === "JSXExpressionContainer" && c.expression.type !== "JSXEmptyExpression");
    const hasElements = el.children.some((c) => c.type === "JSXElement" || c.type === "JSXFragment");
    if (!hasDynamic && !hasElements) {
      // Empty element: insert the text between the tags.
      s.appendLeft(open.end!, jsxTextOrExpr(value));
      return;
    }
    throw new VisualEditError("DYNAMIC", "This element's text is computed at runtime; edit it in the code editor");
  }
  if (target.kind === "jsxtext") {
    const raw = target.node.value;
    const lead = /^\s*/.exec(raw)?.[0] ?? "";
    const trail = /\s*$/.exec(raw)?.[0] ?? "";
    const start = target.node.start! + lead.length;
    const end = target.node.end! - trail.length;
    if (end <= start) s.appendLeft(start, jsxTextOrExpr(value));
    else s.overwrite(start, end, jsxTextOrExpr(value));
  } else {
    const quote = target.node.type === "TemplateLiteral" ? "`" : (source[target.node.start!] as '"' | "'");
    s.overwrite(target.node.start!, target.node.end!, quoteString(value, quote));
  }
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
function isVoidTag(t: string) {
  return VOID.has(t);
}

/** Plain text stays JSX text; characters JSX treats specially go through a string expression. */
function jsxTextOrExpr(value: string): string {
  if (value === "") return "";
  if (/[{}<>]/.test(value) || /^\s|\s$/.test(value) || /\n/.test(value)) return `{${JSON.stringify(value)}}`;
  return value;
}

function quoteString(value: string, quote: '"' | "'" | "`"): string {
  if (quote === "`") return "`" + value.replace(/[\\`]/g, "\\$&").replace(/\$\{/g, "\\${") + "`";
  if (quote === "'") return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- attributes

function findAttr(el: JSXElement, name: string): JSXAttribute | null {
  for (const a of el.openingElement.attributes) {
    if (a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === name) return a;
  }
  return null;
}

function staticString(v: Expression | null | undefined | JSXAttribute["value"]): string | null {
  if (!v) return null;
  if (v.type === "StringLiteral") return v.value;
  if (v.type === "JSXExpressionContainer") {
    const e = v.expression;
    if (e.type === "StringLiteral") return e.value;
    if (e.type === "TemplateLiteral" && e.expressions.length === 0) return e.quasis[0]?.value.cooked ?? "";
  }
  return null;
}

/** Insert a new attribute right after the last existing attribute (or the tag name). */
function insertAttr(s: MagicString, el: JSXElement, text: string) {
  const open = el.openingElement;
  const last = open.attributes[open.attributes.length - 1];
  const at = last ? last.end! : open.name.end!;
  s.appendLeft(at, ` ${text}`);
}

function preferredQuote(source: string, el: JSXElement): '"' | "'" {
  for (const a of el.openingElement.attributes) {
    if (a.type === "JSXAttribute" && a.value?.type === "StringLiteral") return source[a.value.start!] === "'" ? "'" : '"';
  }
  return '"';
}

function attrStringValue(value: string, quote: '"' | "'"): string {
  // JSX attribute strings have no escape sequences; fall back to an expression when needed.
  if (!value.includes(quote) && !value.includes("\n")) return `${quote}${value}${quote}`;
  return `{${JSON.stringify(value)}}`;
}

function editAttr(s: MagicString, source: string, el: JSXElement, name: string, value: string) {
  const a = findAttr(el, name);
  const quote = preferredQuote(source, el);
  if (!a) {
    insertAttr(s, el, `${name}=${attrStringValue(value, quote)}`);
    return;
  }
  if (!a.value) {
    s.appendLeft(a.end!, `=${attrStringValue(value, quote)}`);
    return;
  }
  const q = a.value.type === "StringLiteral" ? (source[a.value.start!] as '"' | "'") : quote;
  s.overwrite(a.value.start!, a.value.end!, attrStringValue(value, q));
}

// ---------------------------------------------------------------- className

function splitClasses(v: string): string[] {
  return v.split(/\s+/).filter(Boolean);
}

function mergeClasses(current: string[], add: string[], remove: string[]): string[] {
  const rm = new Set(remove.flatMap(splitClasses));
  const out = current.filter((c) => !rm.has(c));
  for (const c of add.flatMap(splitClasses)) if (!out.includes(c)) out.push(c);
  return out;
}

function classTokensOf(a: JSXAttribute): string[] | null {
  const v = staticString(a.value);
  return v === null ? null : splitClasses(v);
}

function editClass(s: MagicString, source: string, el: JSXElement, add: string[], remove: string[]) {
  const a = findAttr(el, "className") ?? findAttr(el, "class");
  if (!a) {
    const next = mergeClasses([], add, []);
    if (next.length) insertAttr(s, el, `className=${attrStringValue(next.join(" "), preferredQuote(source, el))}`);
    return;
  }
  const v = a.value;
  if (!v) {
    s.appendLeft(a.end!, `=${attrStringValue(mergeClasses([], add, []).join(" "), '"')}`);
    return;
  }
  if (v.type === "StringLiteral") {
    const next = mergeClasses(splitClasses(v.value), add, remove).join(" ");
    s.overwrite(v.start!, v.end!, attrStringValue(next, source[v.start!] as '"' | "'"));
    return;
  }
  if (v.type !== "JSXExpressionContainer") throw new VisualEditError("DYNAMIC", "className is not a string");
  const e = v.expression;
  if (e.type === "StringLiteral") {
    s.overwrite(e.start!, e.end!, quoteString(mergeClasses(splitClasses(e.value), add, remove).join(" "), source[e.start!] as '"' | "'"));
    return;
  }
  if (e.type === "TemplateLiteral") {
    editTemplateClasses(s, e, add, remove);
    return;
  }
  if (e.type === "CallExpression") {
    // cn("a b", cond && "c") / clsx(...) / twMerge(...): edit static string args, append new classes.
    const removeSet = new Set(remove.flatMap(splitClasses));
    const existing = new Set<string>();
    for (const arg of e.arguments) {
      if (arg.type !== "StringLiteral") continue;
      const tokens = splitClasses(arg.value);
      tokens.forEach((t) => existing.add(t));
      if (tokens.some((t) => removeSet.has(t))) s.overwrite(arg.start!, arg.end!, quoteString(tokens.filter((t) => !removeSet.has(t)).join(" "), source[arg.start!] as '"' | "'"));
    }
    const toAdd = add.flatMap(splitClasses).filter((c) => !existing.has(c));
    if (toAdd.length) {
      const lastArg = e.arguments[e.arguments.length - 1];
      const lit = JSON.stringify(toAdd.join(" "));
      if (lastArg) s.appendLeft(lastArg.end!, `, ${lit}`);
      else s.appendLeft(e.end! - 1, lit);
    }
    return;
  }
  throw new VisualEditError("DYNAMIC", "className is computed at runtime; edit it in the code editor");
}

function editTemplateClasses(s: MagicString, t: TemplateLiteral, add: string[], remove: string[]) {
  const removeSet = new Set(remove.flatMap(splitClasses));
  const existing = new Set<string>();
  for (const q of t.quasis) splitClasses(q.value.raw).forEach((c) => existing.add(c));
  const toAdd = add.flatMap(splitClasses).filter((c) => !existing.has(c));
  t.quasis.forEach((q, i) => {
    const raw = q.value.raw;
    // Remove whole tokens but keep the boundary whitespace next to `${...}`.
    let next = raw.replace(/(^|\s)(\S+)(?=\s|$)/g, (m, sp: string, tok: string) => (removeSet.has(tok) ? sp : m)).replace(/ {2,}/g, " ");
    if (i === t.quasis.length - 1 && toAdd.length) {
      // The last quasi follows an expression (unless it's the only one), so it needs a leading space.
      const lead = t.quasis.length === 1 ? (/^\s*/.exec(next)?.[0] ?? "") : " ";
      next = lead + [...splitClasses(next), ...toAdd].join(" ");
    }
    if (next !== raw) s.overwrite(q.start!, q.end!, next);
  });
}

// ---------------------------------------------------------------- style

/** `background-color` → `backgroundColor`; custom properties (`--x`) are kept as-is. */
export function cssPropToJs(prop: string): string {
  if (prop.startsWith("--")) return prop;
  return prop.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function propKey(p: ObjectProperty): string | null {
  if (p.computed) return null;
  if (p.key.type === "Identifier") return p.key.name;
  if (p.key.type === "StringLiteral") return p.key.value;
  return null;
}

function styleKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function styleValue(v: string | number): string {
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

function editStyle(s: MagicString, source: string, el: JSXElement, prop: string, value: string | number | null) {
  const key = cssPropToJs(prop);
  if (!/^(--[\w-]+|[a-zA-Z]+)$/.test(key)) throw new VisualEditError("UNSUPPORTED", `Invalid style property ${prop}`);
  const a = findAttr(el, "style");
  const remove = value === null || value === "";
  if (!a) {
    if (!remove) insertAttr(s, el, `style={{ ${styleKey(key)}: ${styleValue(value)} }}`);
    return;
  }
  if (a.value?.type !== "JSXExpressionContainer" || a.value.expression.type !== "ObjectExpression") {
    if (a.value?.type === "StringLiteral") throw new VisualEditError("UNSUPPORTED", "style must be an object in JSX");
    throw new VisualEditError("DYNAMIC", "style is computed at runtime; edit it in the code editor");
  }
  const obj = a.value.expression;
  const existing = obj.properties.find((p): p is ObjectProperty => p.type === "ObjectProperty" && propKey(p) === key);
  if (existing) {
    if (remove) removeProperty(s, source, obj, existing);
    else s.overwrite(existing.value.start!, existing.value.end!, styleValue(value));
    return;
  }
  if (remove) return;
  const entry = `${styleKey(key)}: ${styleValue(value)}`;
  const last = obj.properties[obj.properties.length - 1];
  if (!last) {
    s.overwrite(obj.start!, obj.end!, `{ ${entry} }`);
    return;
  }
  // Keep multi-line objects multi-line with matching indentation.
  const between = source.slice(obj.start! + 1, obj.properties[0]!.start!);
  const nl = between.match(/\n([ \t]*)$/);
  const trailingComma = /^\s*,/.test(source.slice(last.end!, obj.end! - 1));
  if (nl) {
    const indent = nl[1] ?? "";
    if (trailingComma) {
      const commaAt = source.indexOf(",", last.end!);
      s.appendLeft(commaAt + 1, `\n${indent}${entry},`);
    } else s.appendLeft(last.end!, `,\n${indent}${entry}`);
  } else {
    if (trailingComma) {
      const commaAt = source.indexOf(",", last.end!);
      s.appendLeft(commaAt + 1, ` ${entry},`);
    } else s.appendLeft(last.end!, `, ${entry}`);
  }
}

function removeProperty(s: MagicString, source: string, obj: ObjectExpression, prop: ObjectProperty) {
  const props = obj.properties;
  const i = props.indexOf(prop);
  if (props.length === 1) {
    s.overwrite(obj.start!, obj.end!, "{}");
    return;
  }
  if (i < props.length - 1) {
    s.remove(prop.start!, props[i + 1]!.start!);
  } else {
    const prev = props[i - 1]!;
    const commaAfter = source.slice(prop.end!, obj.end! - 1).match(/^\s*,/);
    s.remove(prev.end!, prop.end! + (commaAfter ? commaAfter[0].length : 0));
  }
}
