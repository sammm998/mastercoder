import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);

export interface FileSymbols {
  path: string;
  lang: "ts" | "tsx" | "js" | "py" | "other";
  lines: number;
  exports: string[];
  components: string[];
  routes: string[];
  imports: string[];
}

type Lang = FileSymbols["lang"];

const GRAMMAR: Record<Exclude<Lang, "other">, string> = {
  ts: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  js: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  py: "tree-sitter-wasms/out/tree-sitter-python.wasm",
};

let initPromise: Promise<void> | null = null;
const languages = new Map<string, Parser.Language>();

async function parserFor(lang: Exclude<Lang, "other">): Promise<Parser> {
  initPromise ??= Parser.init();
  await initPromise;
  let l = languages.get(lang);
  if (!l) {
    l = await Parser.Language.load(require.resolve(GRAMMAR[lang]));
    languages.set(lang, l);
  }
  const p = new Parser();
  p.setLanguage(l);
  return p;
}

export function langOf(path: string): Lang {
  if (/\.tsx$/.test(path)) return "tsx";
  if (/\.(ts|mts|cts)$/.test(path)) return "ts";
  if (/\.(jsx?|mjs|cjs)$/.test(path)) return "js";
  if (/\.py$/.test(path)) return "py";
  return "other";
}

const ROUTE_CALL = /\b(?:app|router|server|api|fastify|hono)\.(get|post|put|patch|delete|all|route)\(\s*["'`]([^"'`]+)["'`]/g;
const PY_ROUTE = /@(?:app|router|api)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;

/** Derive a URL route from Next.js / Astro / Expo Router file conventions. */
export function fileRoute(path: string): string | null {
  const next = path.match(/^(?:src\/)?app\/(.*?)(?:\/)?(page|route)\.(tsx?|jsx?)$/);
  if (next) {
    const segs = (next[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s));
    const route = "/" + segs.join("/");
    return next[2] === "route" ? `API ${route}` : route;
  }
  const pagesApi = path.match(/^(?:src\/)?pages\/(api\/.*?)(?:\/index)?\.(tsx?|jsx?)$/);
  if (pagesApi) return `API /${pagesApi[1]}`;
  const astro = path.match(/^src\/pages\/(.*?)(?:\/index)?\.(astro|md|mdx)$/);
  if (astro) return "/" + (astro[1] === "index" ? "" : astro[1]);
  return null;
}

function walk(node: Parser.SyntaxNode, fn: (n: Parser.SyntaxNode) => void) {
  fn(node);
  for (const c of node.namedChildren) walk(c, fn);
}

export async function extractSymbols(path: string, source: string): Promise<FileSymbols> {
  const lang = langOf(path);
  const out: FileSymbols = { path, lang, lines: source.split("\n").length, exports: [], components: [], routes: [], imports: [] };
  const fr = fileRoute(path);
  if (fr) out.routes.push(fr);
  if (lang === "other") return out;
  const parser = await parserFor(lang);
  const tree = parser.parse(source);
  try {
    if (lang === "py") {
      for (const n of tree.rootNode.namedChildren) {
        const def = n.type === "decorated_definition" ? n.childForFieldName("definition") : n;
        if (def && (def.type === "function_definition" || def.type === "class_definition")) {
          const name = def.childForFieldName("name")?.text;
          if (name && !name.startsWith("_")) out.exports.push(name);
        }
        if (n.type === "import_from_statement") out.imports.push(n.childForFieldName("module_name")?.text ?? "");
      }
      for (const m of source.matchAll(PY_ROUTE)) out.routes.push(`${m[1]!.toUpperCase()} ${m[2]}`);
    } else {
      const isJsx = lang === "tsx" || lang === "js";
      walk(tree.rootNode, (n) => {
        if (n.type === "import_statement") {
          const src = n.childForFieldName("source")?.text;
          if (src) out.imports.push(src.replace(/^["'`]|["'`]$/g, ""));
        }
        if (n.type !== "export_statement") return;
        const decl = n.childForFieldName("declaration");
        const isDefault = n.children.some((c) => c.type === "default");
        const names: string[] = [];
        if (decl) {
          if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
            for (const d of decl.namedChildren) if (d.type === "variable_declarator") names.push(d.childForFieldName("name")?.text ?? "");
          } else {
            const nm = decl.childForFieldName("name")?.text;
            if (nm) names.push(nm);
          }
        } else {
          for (const c of n.namedChildren) {
            if (c.type === "export_clause") for (const s of c.namedChildren) names.push(s.childForFieldName("alias")?.text ?? s.childForFieldName("name")?.text ?? "");
            else if (isDefault && c.type === "identifier") names.push(c.text);
          }
        }
        for (const nm of names.filter(Boolean)) {
          out.exports.push(isDefault ? `default ${nm}` : nm);
          if (isJsx && /^[A-Z]/.test(nm) && /<[A-Za-z]/.test(n.text)) out.components.push(nm);
        }
        if (isDefault && names.length === 0) out.exports.push("default");
        // Next.js route handlers export GET/POST/... functions
        for (const nm of names) if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(nm) && fr?.startsWith("API")) out.routes.push(`${nm} ${fr.slice(4)}`);
      });
      for (const m of source.matchAll(ROUTE_CALL)) out.routes.push(`${m[1]!.toUpperCase()} ${m[2]}`);
    }
  } finally {
    tree.delete();
    parser.delete();
  }
  out.exports = [...new Set(out.exports)];
  out.routes = [...new Set(out.routes)];
  return out;
}

const IGNORE = /(^|\/)(node_modules|\.git|dist|build|\.next|\.expo|coverage|__pycache__|\.venv|\.turbo)(\/|$)|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|mp4|webm|lock|map)$|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/;

export function shouldIndex(path: string): boolean {
  return !IGNORE.test(path);
}

/**
 * Compact, incrementally refreshed map of a repository: files, exports, components and routes.
 * Only changed files are re-parsed (content hash cache). Never loads whole files into prompts.
 */
export class RepoMap {
  private files = new Map<string, { hash: string; symbols: FileSymbols }>();

  async update(path: string, source: string): Promise<boolean> {
    if (!shouldIndex(path)) return false;
    const hash = createHash("sha1").update(source).digest("hex");
    if (this.files.get(path)?.hash === hash) return false;
    this.files.set(path, { hash, symbols: await extractSymbols(path, source) });
    return true;
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  /** Refresh from a reader (e.g. the sandbox) for the given paths, or all listed paths. */
  async refresh(paths: string[], read: (p: string) => Promise<string>): Promise<number> {
    let changed = 0;
    for (const p of paths.filter(shouldIndex)) {
      try {
        if (await this.update(p, await read(p))) changed++;
      } catch {
        this.remove(p);
      }
    }
    return changed;
  }

  get size(): number {
    return this.files.size;
  }

  symbols(): FileSymbols[] {
    return [...this.files.values()].map((f) => f.symbols).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Render as compact text for the system prompt, truncated to a character budget. */
  render(maxChars = 12_000): string {
    const lines: string[] = [];
    for (const s of this.symbols()) {
      const parts = [`${s.path} (${s.lines}L)`];
      if (s.routes.length) parts.push(`routes: ${s.routes.join(", ")}`);
      if (s.components.length) parts.push(`components: ${s.components.join(", ")}`);
      const other = s.exports.filter((e) => !s.components.includes(e));
      if (other.length) parts.push(`exports: ${other.slice(0, 12).join(", ")}${other.length > 12 ? ", …" : ""}`);
      lines.push(parts.join(" | "));
    }
    let out = "";
    for (const l of lines) {
      if (out.length + l.length + 1 > maxChars) {
        out += `… (${lines.length - out.split("\n").length + 1} more files)\n`;
        break;
      }
      out += l + "\n";
    }
    return out;
  }
}
