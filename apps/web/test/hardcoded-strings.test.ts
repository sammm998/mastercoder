import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Every user-facing string in JSX must come from the i18n catalogs (messages/{en,sv}.json), so a Swedish
 * UI never shows stray English (and vice versa). This walks every .tsx file in src/app and
 * src/components (and src/features) and fails on:
 *   - JSX text containing letters, e.g. <p>Save changes</p>
 *   - string-literal user-facing attributes: placeholder, title, alt, aria-label, aria-description, label
 * Allowed: brand / product / technology names and code-like tokens (see ALLOW).
 */
const ROOTS = ["src/app", "src/components", "src/features"];
const ATTRS = new Set(["placeholder", "title", "alt", "aria-label", "aria-description", "aria-roledescription", "label"]);

/** Proper nouns and code tokens that are identical in every language. */
const ALLOW = new Set([
  "Forge",
  "GitHub",
  "Figma",
  "Next.js",
  "Expo",
  "FastAPI",
  "Remotion",
  "PPTX",
  "DOCX",
  "PDF",
  "Stripe",
  "Postgres",
  "OWASP",
  "EU",
  "API",
  "MCP",
  "OpenAPI",
  "HTTP",
  "stdio",
  "TLS",
  "IP",
  "npx",
  "Svenska",
  "English",
  "px",
  "s",
  "ms",
  "kr",
  "€",
  "$",
]);

function isAllowed(text: string): boolean {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) return true;
  if (!/\p{L}/u.test(s)) return true; // punctuation, numbers, arrows, separators
  if (ALLOW.has(s)) return true;
  if (/^(https?:\/\/|www\.)\S+$/.test(s)) return true; // example URLs in placeholders
  if (/^[\w.-]+(\/[\w.-]+)+$/.test(s)) return true; // path-like examples ("org/repo", "app/page.tsx")
  if (/^&[a-z]+;/.test(s)) return true; // HTML entities such as &lt; around tag names
  // Every word is an allowlisted name, a URL/path/code token, or a single letter (e.g. initials).
  return s.replace(/&[a-z]+;/g, " ").split(/[\s·,]+/).every((w) => !w || ALLOW.has(w) || /^[\p{Lu}]$/u.test(w) || /^\d+([.,]\d+)?[a-z%]*$/.test(w) || /^(https?:|www\.|\/|\.|#|@|[a-z]+[A-Z.:_-]|[\w-]+\.(json|ts|tsx|md|css|js|png|svg)$)/u.test(w) || !/\p{L}/u.test(w));
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (f.endsWith(".tsx")) out.push(p);
  }
  return out;
}

export function findHardcoded(source: string, fileName = "x.tsx"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const at = (n: ts.Node) => `${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n) && !isAllowed(n.text)) hits.push(`${fileName}:${at(n)} text "${n.text.trim().slice(0, 60)}"`);
    if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText()) && n.initializer) {
      const init = n.initializer;
      const lit = ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression)) ? init.expression.text : null;
      if (lit !== null && !isAllowed(lit)) hits.push(`${fileName}:${at(n)} ${n.name.getText()}="${lit.slice(0, 60)}"`);
    }
    // String literals rendered directly as JSX children: {"Some text"}
    if (ts.isJsxExpression(n) && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent)) && n.expression && ts.isStringLiteral(n.expression) && !isAllowed(n.expression.text)) {
      hits.push(`${fileName}:${at(n)} expr "${n.expression.text.slice(0, 60)}"`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe("no hard-coded user-facing strings", () => {
  it("detects literals and ignores translated/brand text", () => {
    expect(findHardcoded(`const a = <p>Save changes</p>;`)).toHaveLength(1);
    expect(findHardcoded(`const a = <input placeholder="Your name" />;`)).toHaveLength(1);
    expect(findHardcoded(`const a = <button aria-label={"Close"} />;`)).toHaveLength(1);
    expect(findHardcoded(`const a = <p>{"Hello there"}</p>;`)).toHaveLength(1);
    expect(findHardcoded(`const a = <p>{t("x.y")} · Forge</p>;`)).toEqual([]);
    expect(findHardcoded(`const a = <p>Next.js · Expo · FastAPI</p>;`)).toEqual([]);
    expect(findHardcoded(`const a = <input placeholder="https://www.figma.com/design/…" />;`)).toEqual([]);
    expect(findHardcoded(`const a = <span>→ 12px</span>;`)).toEqual([]);
  });

  it("src/app, src/components and src/features render only catalog strings", () => {
    const root = join(__dirname, "..");
    const hits = ROOTS.flatMap((r) => files(join(root, r))).flatMap((f) => findHardcoded(readFileSync(f, "utf8"), relative(root, f)));
    expect(hits).toEqual([]);
  });
});
