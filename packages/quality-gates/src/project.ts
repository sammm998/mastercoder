import { z } from "zod";
import type { Sandbox } from "@forge/sandbox";

/** forge.json manifest: explicit commands + public routes. */
export const ForgeManifestSchema = z
  .object({
    kind: z.string().optional(),
    typecheck: z.string().nullable().optional(),
    lint: z.string().nullable().optional(),
    test: z.string().nullable().optional(),
    integration: z.string().nullable().optional(),
    e2e: z.string().nullable().optional(),
    build: z.string().nullable().optional(),
    publicRoutes: z.array(z.string()).optional(),
  })
  .passthrough();
export type ForgeManifest = z.infer<typeof ForgeManifestSchema>;

const PackageJsonSchema = z
  .object({
    name: z.string().optional(),
    scripts: z.record(z.string()).optional(),
    dependencies: z.record(z.string()).optional(),
    devDependencies: z.record(z.string()).optional(),
  })
  .passthrough();
export type PackageJson = z.infer<typeof PackageJsonSchema>;

export type ProjectLanguage = "node" | "python" | "unknown";
export type CommandGate = "typecheck" | "lint" | "unit" | "integration" | "e2e";

export interface ProjectInfo {
  language: ProjectLanguage;
  kind: string;
  packageManager: "pnpm" | "yarn" | "npm" | "bun" | "pip" | "poetry" | "uv" | null;
  /** Command per gate, or null with a reason in `reasons`. */
  commands: Record<CommandGate, string | null>;
  reasons: Partial<Record<CommandGate, string>>;
  build: string | null;
  publicRoutes: string[];
  manifest: ForgeManifest | null;
  manifestError?: string;
  packageJson: PackageJson | null;
  deps: Set<string>;
}

async function tryRead(sb: Sandbox, path: string): Promise<string | null> {
  try {
    return await sb.readFile(path);
  } catch {
    return null;
  }
}

function detectKind(deps: Set<string>, files: Set<string>, language: ProjectLanguage): string {
  if (deps.has("next")) return "nextjs";
  if (deps.has("expo")) return "expo";
  if (deps.has("vite") || [...files].some((f) => /^vite\.config\.(ts|js|mjs|mts)$/.test(f))) return "vite";
  if (deps.has("hono")) return "hono";
  if (deps.has("fastify")) return "fastify";
  if (deps.has("express")) return "express";
  if (language === "python") return deps.has("fastapi") ? "fastapi" : deps.has("django") ? "django" : deps.has("flask") ? "flask" : "python";
  return language === "node" ? "node" : "unknown";
}

function runner(pm: ProjectInfo["packageManager"]): string {
  return pm === "pnpm" ? "pnpm run" : pm === "yarn" ? "yarn run" : pm === "bun" ? "bun run" : "npm run";
}

/** Read forge.json if present, else infer commands from package.json scripts / pyproject.toml. */
export async function detectProject(sb: Sandbox, topLevel: string[]): Promise<ProjectInfo> {
  const files = new Set(topLevel);
  const info: ProjectInfo = {
    language: "unknown",
    kind: "unknown",
    packageManager: null,
    commands: { typecheck: null, lint: null, unit: null, integration: null, e2e: null },
    reasons: {},
    build: null,
    publicRoutes: [],
    manifest: null,
    packageJson: null,
    deps: new Set(),
  };

  const manifestText = files.has("forge.json") ? await tryRead(sb, "forge.json") : null;
  if (manifestText !== null) {
    try {
      info.manifest = ForgeManifestSchema.parse(JSON.parse(manifestText));
    } catch (e) {
      info.manifestError = `forge.json invalid: ${(e as Error).message.slice(0, 200)}`;
    }
  }

  const pkgText = files.has("package.json") ? await tryRead(sb, "package.json") : null;
  if (pkgText !== null) {
    const parsed = PackageJsonSchema.safeParse(safeJson(pkgText));
    if (parsed.success) {
      info.packageJson = parsed.data;
      info.language = "node";
      for (const d of Object.keys({ ...parsed.data.dependencies, ...parsed.data.devDependencies })) info.deps.add(d);
    }
    info.packageManager = files.has("pnpm-lock.yaml") ? "pnpm" : files.has("yarn.lock") ? "yarn" : files.has("bun.lockb") || files.has("bun.lock") ? "bun" : "npm";
  }
  const pyproject = files.has("pyproject.toml") ? await tryRead(sb, "pyproject.toml") : null;
  const requirements = files.has("requirements.txt") ? await tryRead(sb, "requirements.txt") : null;
  if (info.language === "unknown" && (pyproject !== null || requirements !== null)) {
    info.language = "python";
    info.packageManager = files.has("uv.lock") ? "uv" : files.has("poetry.lock") ? "poetry" : "pip";
    const text = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
    for (const d of ["fastapi", "django", "flask", "pydantic", "pytest", "mypy", "ruff", "pyright", "flake8", "playwright"]) if (text.includes(d)) info.deps.add(d);
  }
  info.kind = info.manifest?.kind ?? detectKind(info.deps, files, info.language);
  info.publicRoutes = info.manifest?.publicRoutes ?? [];

  const scripts = info.packageJson?.scripts ?? {};
  const run = runner(info.packageManager);
  const pick = (gate: CommandGate, manifestKey: "typecheck" | "lint" | "test" | "integration" | "e2e", inferred: () => string | null, none: string): void => {
    const m = info.manifest?.[manifestKey];
    if (m === null) {
      info.reasons[gate] = `disabled in forge.json (${manifestKey}: null)`;
      return;
    }
    if (typeof m === "string" && m.trim()) {
      info.commands[gate] = m;
      return;
    }
    const cmd = inferred();
    if (cmd) info.commands[gate] = cmd;
    else info.reasons[gate] = none;
  };

  if (info.language === "node") {
    pick("typecheck", "typecheck", () => (scripts.typecheck ? `${run} typecheck` : scripts["type-check"] ? `${run} type-check` : files.has("tsconfig.json") && info.deps.has("typescript") ? "npx --no-install tsc --noEmit -p tsconfig.json" : null), "no typecheck script and no tsconfig.json + typescript");
    pick("lint", "lint", () => (scripts.lint ? `${run} lint` : null), "no lint script");
    pick("unit", "test", () => (scripts["test:unit"] ? `${run} test:unit` : scripts.test && !/no test specified/.test(scripts.test) ? `${run} test` : null), "no test script");
    pick("integration", "integration", () => (scripts["test:integration"] ? `${run} test:integration` : null), "no test:integration script");
    pick("e2e", "e2e", () => (scripts["test:e2e"] ? `${run} test:e2e` : scripts.e2e ? `${run} e2e` : null), "no test:e2e / e2e script");
    info.build = info.manifest?.build ?? (scripts.build ? `${run} build` : null);
  } else if (info.language === "python") {
    const py = (pyproject ?? "").toLowerCase();
    pick("typecheck", "typecheck", () => (py.includes("[tool.mypy]") || info.deps.has("mypy") ? "mypy ." : py.includes("[tool.pyright]") || info.deps.has("pyright") ? "pyright" : null), "no mypy/pyright configured");
    pick("lint", "lint", () => (py.includes("[tool.ruff") || info.deps.has("ruff") ? "ruff check ." : info.deps.has("flake8") ? "flake8" : null), "no ruff/flake8 configured");
    pick("unit", "test", () => (info.deps.has("pytest") || py.includes("[tool.pytest") ? "pytest -q" : null), "no pytest configured");
    pick("integration", "integration", () => null, "no integration command (set forge.json integration)");
    pick("e2e", "e2e", () => null, "no e2e command (set forge.json e2e)");
    info.build = info.manifest?.build ?? null;
  } else {
    for (const [gate, key] of [["typecheck", "typecheck"], ["lint", "lint"], ["unit", "test"], ["integration", "integration"], ["e2e", "e2e"]] as const) {
      pick(gate, key, () => null, "no package.json / pyproject.toml / forge.json command");
    }
  }
  return info;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
