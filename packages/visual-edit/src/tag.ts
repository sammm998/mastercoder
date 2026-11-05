import MagicString from "magic-string";
import { isHostElement, parseSource, walk } from "./ast.js";
import { SRC_ATTR } from "./protocol.js";

export interface TagResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
  count: number;
}

export function relativePath(file: string, root: string): string {
  const f = file.replace(/\\/g, "/").split("?")[0] ?? file;
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  return f.startsWith(r + "/") ? f.slice(r.length + 1) : f.replace(/^\/+/, "");
}

/**
 * Add `data-forge-src="path:line:col"` to every host JSX element that doesn't already have one.
 * Returns null when nothing changed. Line and column are 1-based and point at the opening `<`.
 */
export function tagJsxSource(code: string, relPath: string): TagResult | null {
  if (!code.includes("<")) return null;
  const ast = parseSource(code, relPath);
  const s = new MagicString(code);
  let count = 0;
  walk(ast.program, (n) => {
    if (n.type !== "JSXOpeningElement" || !isHostElement(n) || !n.loc) return;
    const has = n.attributes.some((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === SRC_ATTR);
    if (has) return;
    const value = `${relPath}:${n.loc.start.line}:${n.loc.start.column + 1}`;
    s.appendLeft(n.name.end!, ` ${SRC_ATTR}=${/["\\\n]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`}`);
    count++;
  });
  if (count === 0) return null;
  return { code: s.toString(), map: s.generateMap({ hires: true, source: relPath, includeContent: true }), count };
}
