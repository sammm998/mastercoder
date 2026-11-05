import { randomBytes } from "node:crypto";
import type { Sandbox } from "@forge/sandbox";

export interface SourceFile {
  /** Path relative to /workspace, forward slashes. */
  path: string;
  content: string;
  lines: string[];
}

export const PRUNE_DIRS = ["node_modules", ".git", ".venv", "venv", "__pycache__", ".turbo", ".cache", "coverage", ".pnpm-store", ".mypy_cache", ".pytest_cache", ".expo"];
const PRUNE_PATHS = ["./.next/cache", "./.next/server", "./.next/standalone", "./.next/types"];
export const SOURCE_EXT = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro", "py", "sql", "json", "yml", "yaml", "toml",
  "ini", "cfg", "properties", "sh", "tf", "env", "pem", "key", "html", "lock", "txt",
];
const NAMED = ["Dockerfile", ".env", ".npmrc", ".pypirc", "Pipfile"];
const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 5000;

function wanted(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (NAMED.includes(base) || base.startsWith(".env")) return true;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return SOURCE_EXT.includes(ext);
}

function make(path: string, content: string): SourceFile {
  return { path, content, lines: content.split(/\r?\n/) };
}

/**
 * Read every source/config file of the project in one sandbox exec (find + awk with a random delimiter);
 * falls back to listFiles + readFile when the sandbox lacks find/awk.
 */
export async function collectFiles(sb: Sandbox, env?: Record<string, string>): Promise<SourceFile[]> {
  const token = `@@FORGE_FILE_${randomBytes(8).toString("hex")}@@`;
  const prune = `\\( -type d \\( ${PRUNE_DIRS.map((d) => `-name '${d}'`).join(" -o ")} \\) -o ${PRUNE_PATHS.map((p) => `-path '${p}'`).join(" -o ")} \\) -prune`;
  const names = [...SOURCE_EXT.map((e) => `-name '*.${e}'`), ...NAMED.map((n) => `-name '${n}'`), "-name '.env.*'"].join(" -o ");
  const cmd = `find . ${prune} -o -type f \\( ${names} \\) -size -${Math.floor(MAX_BYTES / 1024)}k -print0 | xargs -0 -r awk -v M='${token}' 'FNR==1{print M FILENAME} {print}'`;
  const r = await sb.exec(cmd, { timeoutMs: 120000, env });
  if (r.exitCode === 0 && (r.stdout.includes(token) || r.stdout === "")) {
    const out: SourceFile[] = [];
    let path: string | null = null;
    let buf: string[] = [];
    const flush = (): void => {
      if (path !== null) out.push(make(path, buf.join("\n")));
    };
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith(token)) {
        flush();
        path = line.slice(token.length).replace(/^\.\//, "");
        buf = [];
      } else if (path !== null) buf.push(line);
    }
    flush();
    // awk adds a final newline per file; drop the artefact empty last line from the split
    for (const f of out) {
      if (f.lines.length > 1 && f.lines[f.lines.length - 1] === "") {
        f.lines.pop();
        f.content = f.lines.join("\n");
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_FILES);
  }
  // Fallback: one read per file.
  const all = await sb.listFiles(".", { recursive: true, exclude: PRUNE_DIRS });
  const files: SourceFile[] = [];
  for (const p of all.filter((x) => wanted(x) && !PRUNE_PATHS.some((pp) => x.startsWith(pp.slice(2) + "/"))).slice(0, MAX_FILES)) {
    try {
      const content = await sb.readFile(p);
      if (content.length <= MAX_BYTES) files.push(make(p, content));
    } catch {
      /* unreadable: skip */
    }
  }
  return files;
}

/** 1-based line number of a character offset. */
export function lineOf(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

export const isTestFile = (p: string): boolean =>
  /(^|\/)(__tests__|tests?|e2e|cypress|playwright)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.py$/.test(p);

export const isCodeFile = (p: string): boolean => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|astro|py)$/.test(p);

export const isBuildOutput = (p: string): boolean => /^(dist|build|out|\.next|\.output|\.vercel)\//.test(p);
