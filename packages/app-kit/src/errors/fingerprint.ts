import { createHash } from "node:crypto";

export interface StackFrame {
  function?: string;
  file: string;
  line?: number;
  column?: number;
  /** false for node_modules / runtime internals / site-packages. */
  inApp: boolean;
}

const V8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;
const PY = /^\s*File "(.+?)", line (\d+), in (.+)$/;

function isInApp(file: string): boolean {
  return !/(node_modules|^node:|internal\/|site-packages|dist-packages|<frozen|webpack-internal:\/\/\/\(webpack\)|\/_next\/static\/chunks\/(framework|main|webpack))/.test(file);
}

/** Normalise a file reference: strip origins, query strings, webpack prefixes and absolute roots. */
export function normalizeFile(file: string): string {
  let f = file.replace(/^(webpack-internal:\/\/\/|webpack:\/\/\/?|file:\/\/)/, "").replace(/[?#].*$/, "");
  f = f.replace(/^https?:\/\/[^/]+/, "");
  f = f.replace(/^\(\w+\)\/\.?\/?/, "");
  const markers = ["/src/", "/app/", "/pages/", "/lib/", "/tests/"];
  for (const m of markers) {
    const i = f.lastIndexOf(m);
    if (i >= 0 && !f.includes("node_modules")) return f.slice(i + 1);
  }
  return f.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Parse V8 (Node/Chrome), Gecko/WebKit (Firefox/Safari) and Python tracebacks. */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  const lines = stack.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    let m = V8.exec(line);
    if (m) {
      frames.push({ function: m[1], file: normalizeFile(m[2] as string), line: Number(m[3]), column: Number(m[4]), inApp: isInApp(m[2] as string) });
      continue;
    }
    m = PY.exec(line);
    if (m) {
      frames.push({ function: m[3], file: normalizeFile(m[1] as string), line: Number(m[2]), inApp: isInApp(m[1] as string) });
      continue;
    }
    m = GECKO.exec(line);
    if (m && m[2]?.includes("/")) frames.push({ function: m[1] || undefined, file: normalizeFile(m[2]), line: Number(m[3]), column: Number(m[4]), inApp: isInApp(m[2]) });
  }
  // Python tracebacks list the innermost frame last; V8/Gecko list it first.
  return /Traceback \(most recent call last\)/.test(stack) ? frames.reverse() : frames;
}

/** Message with volatile parts (ids, numbers, quoted values, URLs) replaced, for grouping. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    // Quoted identifiers (property/function names) stay; other quoted values are data.
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, (m, q: string) => (/^[A-Za-z_$][\w$.]{0,60}$/.test(m.slice(1, -1)) ? m : `${q}<str>${q}`))
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/** Stable group key: error type + normalised message + top three in-app frames (no line numbers). */
export function fingerprint(e: { type: string; message: string; stack?: string; fingerprint?: string[] }): string {
  if (e.fingerprint?.length) return createHash("sha256").update(e.fingerprint.join("\n")).digest("hex").slice(0, 16);
  const frames = parseStack(e.stack).filter((f) => f.inApp).slice(0, 3);
  const parts = [e.type, normalizeMessage(e.message), ...frames.map((f) => `${f.file}#${f.function ?? "?"}`)];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}
