import { readFileSync, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeError, type IntentKind } from "@forge/shared";
import { parseManifest, type ForgeManifest, type TemplateKind } from "./manifest.js";

export const TEMPLATE_IDS = ["vite-react-ts", "nextjs", "astro-site", "expo", "fastapi", "hono-api"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** Directory that holds `files/<id>/`. Resolved relative to this source file. */
export const TEMPLATES_ROOT = fileURLToPath(new URL("../files/", import.meta.url));

/** Build/install output and local state never copied into a scaffold. */
const IGNORED = new Set(["node_modules", "dist", ".next", ".astro", ".expo", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "playwright-report", "test-results", "coverage", ".turbo", ".DS_Store"]);

export interface TemplateVars {
  projectName: string;
  projectSlug?: string;
  /** Extra `{{key}}` substitutions. Only keys present here are replaced. */
  [key: string]: string | undefined;
}

export interface FileWriter {
  writeFile(path: string, content: string): Promise<void>;
}

export function isTemplateId(id: string): id is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(id);
}

function assertId(id: string): asserts id is TemplateId {
  if (!isTemplateId(id)) throw new ForgeError("NOT_FOUND", `Unknown template "${id}". Known: ${TEMPLATE_IDS.join(", ")}`);
}

export function templateDir(id: string): string {
  assertId(id);
  return join(TEMPLATES_ROOT, id);
}

const manifestCache = new Map<TemplateId, ForgeManifest>();

/** Parsed + validated `forge.json` of a template. */
export function getManifest(id: string): ForgeManifest {
  assertId(id);
  const cached = manifestCache.get(id);
  if (cached) return cached;
  const m = parseManifest(readFileSync(join(templateDir(id), "forge.json"), "utf8"));
  if (m.id !== id) throw new ForgeError("INTERNAL", `forge.json id "${m.id}" does not match template dir "${id}"`);
  manifestCache.set(id, m);
  return m;
}

export function listTemplates(): ForgeManifest[] {
  return TEMPLATE_IDS.filter((id) => existsSync(join(TEMPLATES_ROOT, id, "forge.json"))).map(getManifest);
}

/** kebab-case slug usable as npm package name, docker image and DNS label. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return s || "app";
}

export function resolveVars(vars: TemplateVars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (typeof v === "string") out[k] = v;
  out.projectSlug = vars.projectSlug ? slugify(vars.projectSlug) : slugify(vars.projectName);
  return out;
}

/** Replace `{{key}}` for keys in `vars` only, so JSX like `style={{a:1}}` and unknown braces are untouched. */
export function substitute(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (m, key: string) => (key in vars ? (vars[key] as string) : m));
}

/**
 * Substitute with values escaped for the file type, so a project name like `Bob's "Shop" <3>` can
 * neither break a string literal / JSON document nor inject markup.
 */
export function substituteForFile(path: string, content: string, vars: Record<string, string>): string {
  let esc: (v: string) => string = (v) => v;
  if (/\.(json|[cm]?[jt]sx?|py|astro|toml)$/.test(path)) esc = (v) => JSON.stringify(v).slice(1, -1);
  else if (/\.(html?|svg|xml)$/.test(path)) esc = (v) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  const escaped: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) escaped[k] = esc(v);
  return substitute(content, escaped);
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORED.has(e.name) || e.name.endsWith(".tsbuildinfo") || e.name.endsWith(".hold")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out);
    else if (e.isFile()) out.push(relative(root, full).split(sep).join(posix.sep));
  }
}

/** Relative (posix) paths of every file in a template. */
export async function templateFileList(id: string): Promise<string[]> {
  const root = templateDir(id);
  const out: string[] = [];
  await walk(root, root, out);
  return out.sort();
}

/**
 * All files of a template read from disk, keyed by relative posix path. With `vars`, `{{projectName}}`,
 * `{{projectSlug}}` (and any other provided key) are substituted.
 */
export async function templateFiles(id: string, vars?: TemplateVars): Promise<Record<string, string>> {
  const root = templateDir(id);
  const resolved = vars ? resolveVars(vars) : undefined;
  const files: Record<string, string> = {};
  for (const rel of await templateFileList(id)) {
    const content = await readFile(join(root, rel), "utf8");
    files[rel] = resolved ? substituteForFile(rel, content, resolved) : content;
  }
  return files;
}

export interface ScaffoldResult {
  manifest: ForgeManifest;
  files: string[];
}

/** Write a template (with substitution) through any writer: local fs, sandbox, object store. */
export async function scaffold(id: string, writer: FileWriter, vars: TemplateVars): Promise<ScaffoldResult> {
  const files = await templateFiles(id, vars);
  for (const [path, content] of Object.entries(files)) await writer.writeFile(path, content);
  return { manifest: getManifest(id), files: Object.keys(files) };
}

const HINT_ALIASES: Array<[RegExp, TemplateId]> = [
  [/\b(next(\.?js)?|app router)\b/, "nextjs"],
  [/\bvite\b/, "vite-react-ts"],
  [/\bastro\b/, "astro-site"],
  [/\b(expo|react[- ]native)\b/, "expo"],
  [/\b(python|fastapi|pydantic|django|flask)\b/, "fastapi"],
  [/\bhono\b/, "hono-api"],
];
const SIMPLE_SPA = /\b(spa|single[- ]page|dashboards?|admin panel|internal tool|client[- ]only|static app|calculator|widget|prototype)\b/;
const MOTION_HEAVY = /\b(3d|three(\.js)?|webgl|r3f|shaders?|motion[- ]heavy|scroll[- ](driven|story|telling)|scrollytelling|parallax|immersive|gsap|animated landing|interactive landing)\b/;

/**
 * Pick a starter for an intent. Explicit framework hints win; otherwise:
 * app → nextjs (vite-react-ts for simple SPAs/dashboards), website → astro-site (vite-react-ts for
 * motion-heavy/3D landing pages), mobile → expo, backend → hono-api (fastapi for Python hints).
 */
export function selectTemplate(intentKind: IntentKind | TemplateKind, hint?: string): TemplateId {
  const h = (hint ?? "").toLowerCase();
  if (isTemplateId(h)) return h;
  const kindTemplates: Partial<Record<string, TemplateKind>> = { app: "app", website: "website", mobile: "mobile", backend: "backend", integration: "backend" };
  const kind = kindTemplates[intentKind];
  if (!kind) throw new ForgeError("BAD_INPUT", `No code template for intent kind "${intentKind}"`);
  for (const [re, id] of HINT_ALIASES) {
    if (!re.test(h)) continue;
    // A framework hint must still fit the platform: never put a Python API on a mobile intent.
    const m = getManifest(id);
    if (m.kind === kind || (kind === "website" && m.kind === "app") || (kind === "app" && m.kind === "website")) return id;
  }
  switch (kind) {
    case "app":
      return SIMPLE_SPA.test(h) ? "vite-react-ts" : "nextjs";
    case "website":
      return MOTION_HEAVY.test(h) ? "vite-react-ts" : "astro-site";
    case "mobile":
      return "expo";
    case "backend":
      return "hono-api";
  }
}
