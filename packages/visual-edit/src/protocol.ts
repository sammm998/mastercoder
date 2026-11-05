/**
 * postMessage protocol between the Forge workspace (parent) and the inspector running inside the
 * generated app's dev preview (iframe). Both sides validate every message with these guards.
 */

export const SRC_ATTR = "data-forge-src";

export interface SourcePosition {
  /** 1-based line. */
  line: number;
  /** 1-based column of the element's opening `<`. */
  column: number;
}

export interface SourceLocation extends SourcePosition {
  /** Project-relative path, e.g. "src/App.tsx". */
  path: string;
}

export interface InspectedStyles {
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontWeight: string;
  padding: string;
  margin: string;
  borderRadius: string;
}

export interface ForgeSelectMessage {
  type: "forge:select";
  src: string;
  tag: string;
  text: string;
  /** True when the element's text comes from its own direct text nodes (editable as text). */
  hasDirectText: boolean;
  classes: string[];
  attrs: { src?: string; alt?: string; href?: string };
  styles: InspectedStyles;
  rect: { x: number; y: number; width: number; height: number };
}

export interface ForgeReadyMessage {
  type: "forge:ready";
  version: number;
}

export type InspectorToParent = ForgeSelectMessage | ForgeReadyMessage;

export interface ForgeHighlightMessage {
  type: "forge:highlight";
  /** data-forge-src value to outline, or null to clear. */
  src: string | null;
}

export interface ForgeInspectMessage {
  type: "forge:inspect";
  enabled: boolean;
}

export type ParentToInspector = ForgeHighlightMessage | ForgeInspectMessage;

export const PROTOCOL_VERSION = 1;

/** Parse "src/App.tsx:12:5" (path may itself contain colons, e.g. Windows drive letters). */
export function parseSrc(src: string): SourceLocation | null {
  const m = /^(.+):(\d+):(\d+)$/.exec(src);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const line = Number(m[2]);
  const column = Number(m[3]);
  if (line < 1 || column < 1) return null;
  const path = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.startsWith("/") || path.split("/").includes("..")) return null;
  return { path, line, column };
}

export function formatSrc(loc: SourceLocation): string {
  return `${loc.path}:${loc.line}:${loc.column}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const str = (v: unknown): v is string => typeof v === "string";

export function isSelectMessage(v: unknown): v is ForgeSelectMessage {
  if (!isObj(v) || v.type !== "forge:select") return false;
  if (!str(v.src) || !str(v.tag) || !str(v.text) || typeof v.hasDirectText !== "boolean") return false;
  if (!Array.isArray(v.classes) || !v.classes.every(str)) return false;
  if (!isObj(v.attrs) || !isObj(v.styles) || !isObj(v.rect)) return false;
  return parseSrc(v.src) !== null && v.src.length <= 600 && v.text.length <= 10_000;
}

export function isReadyMessage(v: unknown): v is ForgeReadyMessage {
  return isObj(v) && v.type === "forge:ready" && typeof v.version === "number";
}

export function isInspectorMessage(v: unknown): v is InspectorToParent {
  return isSelectMessage(v) || isReadyMessage(v);
}

export function isParentMessage(v: unknown): v is ParentToInspector {
  if (!isObj(v)) return false;
  if (v.type === "forge:highlight") return v.src === null || (str(v.src) && v.src.length <= 600);
  if (v.type === "forge:inspect") return typeof v.enabled === "boolean";
  return false;
}

/** A CSS selector for a tagged element, suitable for pinning comments. */
export function selectorForSrc(src: string): string {
  return `[${SRC_ATTR}="${src.replace(/["\\]/g, "\\$&")}"]`;
}

export function srcFromSelector(selector: string): string | null {
  const m = /^\[data-forge-src="((?:[^"\\]|\\.)*)"\]$/.exec(selector);
  return m?.[1] ? m[1].replace(/\\(.)/g, "$1") : null;
}
