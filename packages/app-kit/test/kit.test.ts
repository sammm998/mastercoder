import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { ForgeManifestSchema, TEMPLATE_IDS, templateFiles, type TemplateId } from "@forge/templates";
import { FEATURES, KIT_FEATURES, KIT_ROOT, kitEnvVars, kitFilesFor, kitSupport, resolveFeatures, type KitFeature } from "../src/index.js";

function supported(t: TemplateId): KitFeature[] {
  return KIT_FEATURES.filter((f) => kitSupport(t)[f] !== "unsupported");
}

const EXT = [".ts", ".tsx", ".astro", ".json", ".js"];

/** Resolve every relative / "@/" import of every TS file against template + kit output. */
async function unresolvedImports(t: TemplateId, features: KitFeature[]): Promise<string[]> {
  const project = { ...(await templateFiles(t, { projectName: "Check" })), ...kitFilesFor(t, features, { vars: { projectName: "Check" } }) };
  const paths = new Set(Object.keys(project));
  const missing: string[] = [];
  for (const [file, content] of Object.entries(project)) {
    if (!/\.(tsx?|astro)$/.test(file)) continue;
    for (const [, spec] of content.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
      if (!spec || !(spec.startsWith(".") || spec.startsWith("@/"))) continue;
      const base = spec.startsWith("@/") ? posix.join("src", spec.slice(2)) : posix.join(posix.dirname(file), spec);
      const noJs = base.replace(/\.js$/, "");
      const candidates = [base, ...EXT.map((e) => noJs + e), ...EXT.map((e) => posix.join(noJs, `index${e}`))];
      if (!candidates.some((c) => paths.has(c))) missing.push(`${file} → ${spec}`);
    }
  }
  return missing;
}

describe("feature registry", () => {
  it("every referenced kit dir exists", () => {
    for (const f of KIT_FEATURES) {
      for (const spec of Object.values(FEATURES[f].templates)) {
        if (spec === "builtin" || !spec) continue;
        for (const d of spec.dirs) expect(existsSync(join(KIT_ROOT, d)), `${f}: ${d}`).toBe(true);
      }
    }
  });

  it("resolves requirements transitively in canonical order", () => {
    expect(resolveFeatures(["cms"])).toEqual(["db", "email", "auth", "cms"]);
    expect(resolveFeatures(["seo", "seo"])).toEqual(["seo"]);
  });

  it("knows what each template supports", () => {
    expect(kitSupport("nextjs").cms).toBe("supported");
    expect(kitSupport("astro-site").seo).toBe("builtin");
    expect(kitSupport("vite-react-ts").auth).toBe("unsupported");
    expect(supported("nextjs")).toEqual([...KIT_FEATURES]);
  });
});

describe("kitFilesFor", () => {
  it.each(TEMPLATE_IDS.filter((t) => supported(t).length > 0))("%s: all supported features produce wired, resolvable files", async (t) => {
    const features = supported(t);
    const files = kitFilesFor(t, features, { vars: { projectName: "Check" } });
    expect(Object.keys(files).length).toBeGreaterThan(3);
    for (const [p, c] of Object.entries(files)) {
      expect(c.length, p).toBeGreaterThan(0);
      expect(c, p).not.toContain("{{projectName}}");
      expect(c, p).not.toContain("@forge-kit:server-only");
    }
    expect(await unresolvedImports(t, features)).toEqual([]);
    const manifest = ForgeManifestSchema.parse(JSON.parse(files["forge.json"] as string));
    expect(manifest.features).toEqual(expect.arrayContaining(features));
    expect(files["KIT.md"]).toContain("Forge app-kit");
  });

  it.each(TEMPLATE_IDS)("%s: each supported feature also works alone", async (t) => {
    for (const f of supported(t)) {
      expect(await unresolvedImports(t, [f]), `${t}+${f}`).toEqual([]);
    }
  });

  it("merges dependencies, scripts and env vars for nextjs", () => {
    const files = kitFilesFor("nextjs", ["auth", "payments", "storage"]);
    const pkg = JSON.parse(files["package.json"] as string) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.dependencies["better-auth"]).toMatch(/^\^1\./);
    expect(pkg.dependencies.stripe).toBeDefined();
    expect(pkg.dependencies["drizzle-orm"]).toBeDefined();
    expect(pkg.dependencies.next).toBeDefined();
    expect(pkg.devDependencies["drizzle-kit"]).toBeDefined();
    expect(pkg.scripts["db:migrate"]).toBe("drizzle-kit migrate");
    const env = files[".env.example"] as string;
    for (const v of ["BETTER_AUTH_SECRET", "STRIPE_WEBHOOK_SECRET", "S3_BUCKET", "DATABASE_URL", "EMAIL_PROVIDER", "NEXT_PUBLIC_SITE_URL"]) expect(env).toMatch(new RegExp(`^${v}=`, "m"));
    // Secrets never get example values.
    expect(env).toMatch(/^BETTER_AUTH_SECRET=$/m);
  });

  it("marks server-only modules for Next.js and strips the marker elsewhere", () => {
    expect(kitFilesFor("nextjs", ["ai"])["src/lib/forge-ai.ts"]).toMatch(/^import "server-only";/);
    expect(kitFilesFor("hono-api", ["ai"])["src/lib/forge-ai.ts"]).not.toContain("server-only");
  });

  it("generates cron jobs and mirrors them into forge.json", () => {
    const files = kitFilesFor("nextjs", ["cron", "auth"]);
    expect(files["src/lib/cron-jobs.ts"]).toContain('"cleanup-auth"');
    const m = ForgeManifestSchema.parse(JSON.parse(files["forge.json"] as string));
    expect(m.crons?.map((c) => c.path)).toEqual(["/api/cron/heartbeat", "/api/cron/cleanup-auth"]);
    const hono = ForgeManifestSchema.parse(JSON.parse(kitFilesFor("hono-api", ["cron"])["forge.json"] as string));
    expect(hono.crons).toEqual([{ name: "heartbeat", schedule: "41 * * * *", path: "/cron/heartbeat" }]);
  });

  it("keeps existing crons, features and env lines when re-applied", () => {
    const first = kitFilesFor("hono-api", ["cron"]);
    const forgeJson = JSON.stringify({ ...JSON.parse(first["forge.json"] as string), crons: [{ name: "report", schedule: "0 6 * * 1", path: "/cron/report" }] });
    const second = kitFilesFor("hono-api", ["ai"], { forgeJson, envExample: first[".env.example"], packageJson: first["package.json"] });
    const m = ForgeManifestSchema.parse(JSON.parse(second["forge.json"] as string));
    expect(m.features).toEqual(["ai", "cron"]);
    expect(m.crons).toEqual([{ name: "report", schedule: "0 6 * * 1", path: "/cron/report" }]);
    expect((second[".env.example"] as string).match(/^CRON_SECRET=/gm)?.length).toBe(1);
  });

  it("wires the hono kit slot with observability first", () => {
    const idx = kitFilesFor("hono-api", ["auth", "observability", "payments"])["src/kit/index.ts"] as string;
    expect(idx.indexOf("mountObservability(app)")).toBeLessThan(idx.indexOf("mountAuth(app)"));
    expect(idx).toContain('import { mountPayments } from "./payments-routes.js";');
  });

  it("wires the nextjs slot (lang from i18n, banner + beacon in body)", () => {
    const slots = kitFilesFor("nextjs", ["i18n", "analytics", "cookie-consent"])["src/kit/slots.tsx"] as string;
    expect(slots).toContain("return await getLocale();");
    expect(slots).toContain("<Analytics />");
    expect(slots).toContain("<CookieConsent />");
  });

  it("adds Python requirements once for fastapi", () => {
    const req = kitFilesFor("fastapi", ["ai", "observability"])["requirements.txt"] as string;
    expect(req.match(/^httpx==/gm)?.length).toBe(1);
    expect(req).toContain("fastapi==");
  });

  it("treats built-in features as installed without copying files", () => {
    const files = kitFilesFor("astro-site", ["seo"]);
    expect(Object.keys(files).sort()).toEqual([".env.example", "KIT.md", "forge.json", "package.json", "src/kit/Body.astro", "src/kit/Head.astro"]);
    expect(JSON.parse(files["forge.json"] as string).features).toEqual(["seo"]);
  });

  it("escapes the project name per file type", () => {
    const files = kitFilesFor("nextjs", ["cms"], { vars: { projectName: 'Bob\'s "Shop"' } });
    expect(JSON.parse(files["src/content/site.json"] as string).hero.title).toBe('Bob\'s "Shop"');
  });

  it("rejects unsupported combinations and unknown features", () => {
    expect(() => kitFilesFor("vite-react-ts", ["cms"])).toThrow(/does not support.*cms/);
    expect(() => kitFilesFor("expo", ["payments"])).toThrow(/payments/);
    expect(() => kitFilesFor("nextjs", ["blockchain" as KitFeature])).toThrow();
    expect(() => kitFilesFor("rails", [])).toThrow(/Unknown template/);
  });

  it("lists env vars a feature set needs", () => {
    const names = kitEnvVars("nextjs", ["ai"]).map((e) => e.name);
    expect(names).toEqual(["FORGE_AI_GATEWAY_URL", "FORGE_PROJECT_TOKEN"]);
    expect(kitEnvVars("nextjs", ["auth"]).find((e) => e.name === "BETTER_AUTH_SECRET")?.secret).toBe(true);
  });
});
