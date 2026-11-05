import { parse, type ParserPlugin } from "@babel/parser";
import type { File, Node, JSXElement, JSXOpeningElement } from "@babel/types";

export class VisualEditError extends Error {
  constructor(
    readonly code: "PARSE" | "NOT_FOUND" | "DYNAMIC" | "UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "VisualEditError";
  }
}

export function parseSource(source: string, filename = "file.tsx"): File {
  const plugins: ParserPlugin[] = ["jsx", "decorators-legacy", "importAttributes"];
  // `.ts` files can't contain JSX, but `<T>x` casts would confuse the jsx plugin there; .js/.jsx get flow-free JSX.
  if (/\.(tsx?|mts|cts)$/.test(filename) || !/\.(jsx?|mjs|cjs)$/.test(filename)) plugins.push("typescript");
  try {
    return parse(source, { sourceType: "module", plugins, errorRecovery: false });
  } catch (e) {
    throw new VisualEditError("PARSE", `Could not parse ${filename}: ${(e as Error).message}`);
  }
}

/** Depth-first walk over every AST node (no @babel/traverse needed). Return false to skip children. */
export function walk(node: Node, visit: (n: Node, parent: Node | null) => boolean | void, parent: Node | null = null): void {
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node) as Array<keyof Node>) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments" || key === "extra") continue;
    const value = node[key] as unknown;
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, node);
    } else if (isNode(value)) {
      walk(value, visit, node);
    }
  }
}

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string" && "start" in v;
}

/** Host elements are lower-case intrinsic tags (`div`, `img`, `svg:path`), not components. */
export function isHostElement(opening: JSXOpeningElement): boolean {
  const n = opening.name;
  if (n.type === "JSXIdentifier") return /^[a-z]/.test(n.name);
  if (n.type === "JSXNamespacedName") return true;
  return false;
}

export function tagName(opening: JSXOpeningElement): string {
  const n = opening.name;
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXNamespacedName") return `${n.namespace.name}:${n.name.name}`;
  const parts: string[] = [];
  let cur: typeof n | typeof n.object = n;
  while (cur.type === "JSXMemberExpression") {
    parts.unshift(cur.property.name);
    cur = cur.object;
  }
  if (cur.type === "JSXIdentifier") parts.unshift(cur.name);
  return parts.join(".");
}

/**
 * Locate the JSX element whose opening `<` is at (line, column) — both 1-based, as emitted by the
 * source-tag plugins. Falls back to the innermost element whose opening tag spans the position.
 */
export function findElementAt(ast: File, line: number, column: number): JSXElement | null {
  let exact: JSXElement | null = null;
  let containing: JSXElement | null = null;
  walk(ast.program, (n) => {
    if (n.type !== "JSXElement" || !n.loc) return;
    const s = n.openingElement.loc?.start;
    if (s && s.line === line && s.column + 1 === column) exact = n;
    const os = n.openingElement.loc;
    if (os && within(os.start, os.end, line, column)) containing = n;
  });
  return exact ?? containing;
}

function within(start: { line: number; column: number }, end: { line: number; column: number }, line: number, column: number): boolean {
  const c = column - 1;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && c < start.column) return false;
  if (line === end.line && c >= end.column) return false;
  return true;
}
