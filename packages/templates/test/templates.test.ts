import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ForgeManifestSchema,
  TEMPLATE_IDS,
  getManifest,
  listTemplates,
  scaffold,
  selectTemplate,
  slugify,
  substitute,
  templateDir,
  templateFileList,
  templateFiles,
} from "../src/index.js";

const WEB = ["vite-react-ts", "nextjs", "astro-site"] as const;
const REQUIRED_TOKENS = ["--color-bg", "--color-text", "--color-accent", "--font-display", "--font-body", "--space-", "--radius-", "--ease", "--dur-"];

function npmScripts(id: string): Record<string, string> {
  return (JSON.parse(readFileSync(join(templateDir(id), "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
}

describe("manifests", () => {
  it("lists all six templates", () => {
    expect(listTemplates().map((m) => m.id).sort()).toEqual([...TEMPLATE_IDS].sort());
  });

  it.each(TEMPLATE_IDS)("%s forge.json validates with zod and matches its directory", (id) => {
    const raw = JSON.parse(readFileSync(join(templateDir(id), "forge.json"), "utf8")) as unknown;
    const parsed = ForgeManifestSchema.safeParse(raw);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(getManifest(id).id).toBe(id);
  });

  it("rejects malformed manifests", () => {
    const base = getManifest("nextjs");
    expect(ForgeManifestSchema.safeParse({ ...base, port: 0 }).success).toBe(false);
    expect(ForgeManifestSchema.safeParse({ ...base, kind: "game" }).success).toBe(false);
    expect(ForgeManifestSchema.safeParse({ ...base, unknownKey: 1 }).success).toBe(false);
    expect(ForgeManifestSchema.safeParse({ ...base, crons: [{ name: "x", schedule: "every day", path: "/c" }] }).success).toBe(false);
    expect(ForgeManifestSchema.safeParse({ ...base, crons: [{ name: "nightly", schedule: "0 3 * * 1-5", path: "/api/cron/nightly" }] }).success).toBe(true);
  });
});

describe("referenced files exist", () => {
  it.each(TEMPLATE_IDS)("%s has README, .gitignore, Dockerfile and a test", async (id) => {
    const files = await templateFileList(id);
    for (const f of ["README.md", ".gitignore", "Dockerfile", "forge.json"]) expect(files, f).toContain(f);
    expect(files.some((f) => /(^|\/)(test|tests)\/.+\.(test\.tsx?|py)$/.test(f) && !f.endsWith("__init__.py"))).toBe(true);
    const docker = readFileSync(join(templateDir(id), "Dockerfile"), "utf8");
    expect(docker).toMatch(/^FROM /m);
    expect(docker).toMatch(/EXPOSE \d+/);
    const m = getManifest(id);
    expect(docker).toContain(`EXPOSE ${m.containerPort ?? m.port}`);
    // Every COPY source in the Dockerfile that is a plain file must exist in the template.
    for (const [, src] of docker.matchAll(/^COPY (?!--from)(?:--\S+ )*(\S+) /gm)) {
      if (src && !src.includes("*") && src !== ".") expect(files.some((f) => f === src || f.startsWith(`${src}/`)), `COPY ${src}`).toBe(true);
    }
  });

  it.each(TEMPLATE_IDS.filter((id) => id !== "fastapi"))("%s: every `npm run <script>` in forge.json exists in package.json", (id) => {
    const scripts = npmScripts(id);
    const m = getManifest(id);
    for (const cmd of [m.dev, m.build, m.test, m.typecheck, m.lint, m.e2e].filter(Boolean) as string[]) {
      for (const [, name] of cmd.matchAll(/npm run ([\w:-]+)/g)) expect(scripts[name as string], `${id}: ${cmd}`).toBeDefined();
      if (/^npm test\b/.test(cmd)) expect(scripts.test).toBeDefined();
    }
  });

  it("fastapi references its requirement files and modules", async () => {
    const files = await templateFileList("fastapi");
    for (const f of ["requirements.txt", "requirements-dev.txt", "pyproject.toml", "app/main.py", "app/kit/__init__.py", "tests/test_app.py"]) expect(files).toContain(f);
    const m = getManifest("fastapi");
    expect(m.install).toContain("requirements-dev.txt");
    expect(m.language).toBe("python");
  });

  it.each(WEB)("%s ships design tokens, Playwright config and a smoke e2e", async (id) => {
    const files = await templateFileList(id);
    const tokensPath = files.find((f) => f.endsWith("tokens.css"));
    expect(tokensPath).toBeDefined();
    const css = readFileSync(join(templateDir(id), tokensPath as string), "utf8");
    for (const t of REQUIRED_TOKENS) expect(css, t).toContain(t);
    expect(css).toContain("prefers-reduced-motion");
    expect(files).toContain("playwright.config.ts");
    expect(files.some((f) => f.startsWith("e2e/") && f.endsWith(".spec.ts"))).toBe(true);
    expect(getManifest(id).e2e).toBeDefined();
    expect(getManifest(id).lighthouse).toBe(true);
  });

  it.each(WEB)("%s is accessible by construction (lang, landmarks, skip link, focus styles)", async (id) => {
    const all = Object.values(await templateFiles(id)).join("\n");
    expect(all).toMatch(/<html lang=/);
    expect(all).toMatch(/<main id="main"/);
    expect(all).toMatch(/<header/);
    expect(all).toMatch(/<footer/);
    expect(all).toContain("Skip to content");
    expect(all).toContain(":focus-visible");
  });

  it("templates have no build output or dependencies checked in", async () => {
    for (const id of TEMPLATE_IDS) {
      const files = await templateFileList(id);
      expect(files.some((f) => f.includes("node_modules/") || f.startsWith("dist/") || f.startsWith(".venv/"))).toBe(false);
      expect(existsSync(join(templateDir(id), "package-lock.json"))).toBe(false);
    }
  });
});

describe("substitution", () => {
  it("replaces projectName/projectSlug everywhere", async () => {
    for (const id of TEMPLATE_IDS) {
      const files = await templateFiles(id, { projectName: "Café Öresund" });
      const joined = Object.values(files).join("\n");
      expect(joined, id).not.toContain("{{projectName}}");
      expect(joined, id).not.toContain("{{projectSlug}}");
      expect(joined).toContain("Café Öresund");
      if (files["package.json"]) expect(JSON.parse(files["package.json"]).name).toBe("cafe-oresund");
    }
  });

  it("only replaces known keys and leaves JSX double braces alone", () => {
    const vars = { projectName: "X", projectSlug: "x" };
    expect(substitute("<div style={{color:1}}>{{projectName}} {{unknown}}</div>", vars)).toBe("<div style={{color:1}}>X {{unknown}}</div>");
  });

  it("honours an explicit slug and extra vars", async () => {
    const files = await templateFiles("hono-api", { projectName: "My API", projectSlug: "Custom Slug" });
    expect(JSON.parse(files["package.json"] as string).name).toBe("custom-slug");
  });

  it("slugify produces DNS/npm-safe names", () => {
    expect(slugify("  Hello, World!  ")).toBe("hello-world");
    expect(slugify("Ålands Ölbryggeri AB")).toBe("alands-olbryggeri-ab");
    expect(slugify("!!!")).toBe("app");
    expect(slugify("a".repeat(80)).length).toBeLessThanOrEqual(50);
  });

  it("returns raw files without vars", async () => {
    const files = await templateFiles("vite-react-ts");
    expect(files["package.json"]).toContain("{{projectSlug}}");
  });
});

describe("scaffold", () => {
  it("writes every template file through the writer", async () => {
    const written = new Map<string, string>();
    const res = await scaffold("nextjs", { writeFile: async (p, c) => void written.set(p, c) }, { projectName: "Shop" });
    expect(res.manifest.id).toBe("nextjs");
    expect([...written.keys()].sort()).toEqual(res.files.sort());
    expect(written.get("src/lib/site.ts")).toContain('name: "Shop"');
  });

  it("rejects unknown templates", async () => {
    await expect(templateFiles("rails")).rejects.toThrow(/Unknown template/);
    expect(() => getManifest("rails")).toThrow(/Unknown template/);
  });
});

describe("selectTemplate", () => {
  it.each([
    ["app", undefined, "nextjs"],
    ["app", "booking system with accounts", "nextjs"],
    ["app", "simple SPA", "vite-react-ts"],
    ["app", "analytics dashboard", "vite-react-ts"],
    ["website", undefined, "astro-site"],
    ["website", "restaurant site with menu", "astro-site"],
    ["website", "motion-heavy landing page", "vite-react-ts"],
    ["website", "3D product showcase with WebGL", "vite-react-ts"],
    ["website", "scroll-driven story", "vite-react-ts"],
    ["mobile", undefined, "expo"],
    ["mobile", "react native habit tracker", "expo"],
    ["backend", undefined, "hono-api"],
    ["backend", "python/fastapi", "fastapi"],
    ["backend", "REST API in Python", "fastapi"],
    ["backend", "fastapi", "fastapi"],
    ["app", "nextjs", "nextjs"],
    ["app", "vite", "vite-react-ts"],
    ["website", "astro", "astro-site"],
    ["integration", undefined, "hono-api"],
  ] as const)("%s + %s → %s", (kind, hint, expected) => {
    expect(selectTemplate(kind, hint)).toBe(expected);
  });

  it("does not let a backend hint hijack a mobile intent", () => {
    expect(selectTemplate("mobile", "python backend")).toBe("expo");
  });

  it("throws for intents without a code template", () => {
    expect(() => selectTemplate("image")).toThrow(/No code template/);
  });
});
