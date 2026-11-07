import type { Job } from "bullmq";
import { and, eq, projects, deployments, projectFiles } from "@forge/db";
import { MeteredLLM } from "@forge/llm";
import { signPreviewToken, type ForgeEventInput } from "@forge/shared";
import { QUEUES, newId, BuildJobSchema, DeployJobSchema, type BuildJob } from "@forge/shared";
import { startDevPreview } from "@forge/agent-core";
import type { AgentDeps, SandboxPort, DesignPort, CheckpointPort, GatesPort, TemplatesPort, BrowserPort } from "@forge/agent-core";
import { createSandboxProvider, type Sandbox, type SandboxProvider } from "@forge/sandbox";
import { runGates, type GateName } from "@forge/quality-gates";
import { selectTemplate, getManifest, templateFiles, isTemplateId } from "@forge/templates";
import { kitFilesFor, createDbBranchProvider, createDeployProvider, type KitFeature } from "@forge/app-kit";
import { createCheckpointing } from "./checkpoints.js";
import { generateDirections, pickDirection, normalizeDirection, ArtDirectionSchema, generateConcept, conceptToText, tokensFromDirection, tokensToCss, composeLanding, composePortfolio, generateContent, analyzePage, runLighthouse, crawlSite } from "@forge/design";
import { billingSettler } from "./settle.js";
import { runBuildJob } from "./jobs/build.js";
import { runMediaRequest } from "./jobs/media.js";
import { runSlidesRequest } from "./jobs/slides.js";
import { runChat } from "./jobs/chat.js";
import "./mock-llm.js";
import { createMediaProvider } from "@forge/media";
import type { BuildQueueDeps } from "./build-queue.js";
import { createHmac } from "node:crypto";
import { PgCloneBranchProvider } from "@forge/app-kit";
import { PLUGIN_FILE, VISUAL_EDIT_PLUGIN_SOURCE, patchPackageJson, patchViteConfig } from "@forge/visual-edit";
import type { ProjectSetupPort } from "@forge/agent-core";

/** Vite projects get the visual-edit plugin (source tags + inspector in dev only) so Edit works in the preview. */
const visualEditSetup: ProjectSetupPort = {
  async prepare(sb) {
    const read = (p: string) => sb.readFile(p).catch(() => null);
    let config: string | null = null;
    let path = "vite.config.ts";
    for (const p of ["vite.config.ts", "vite.config.js", "vite.config.mjs"]) {
      config = await read(p);
      if (config !== null) {
        path = p;
        break;
      }
    }
    if (config === null) return { packageJsonChanged: false, notes: [] };
    const patched = patchViteConfig(config);
    if (patched === null) return { packageJsonChanged: false, notes: [] };
    await sb.writeFile(PLUGIN_FILE, VISUAL_EDIT_PLUGIN_SOURCE);
    if (patched !== config) await sb.writeFile(path, patched);
    const pkg = await read("package.json");
    const pkgPatched = pkg ? patchPackageJson(pkg) : null;
    if (pkgPatched) await sb.writeFile("package.json", pkgPatched);
    return { packageJsonChanged: !!pkgPatched, notes: patched !== config ? ["Visual editing enabled in the preview (Edit)."] : [] };
  },
};

/** Kit features added to each template on scaffold (auth apps get Better Auth + Drizzle + RLS helper). */
const KIT: Record<string, KitFeature[]> = { nextjs: ["auth", "db", "seo"], "vite-react-ts": [], "astro-site": ["seo"], expo: [], fastapi: [], "hono-api": [] };

const BINARY_MEDIA = /\.(png|jpe?g|webp|gif|avif|mp4|webm)$/i;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", mp4: "video/mp4", webm: "video/webm" };

export async function wireBuild(d: BuildQueueDeps): Promise<void> {
  const sandboxes: SandboxProvider = createSandboxProvider({ usage: d.usage });
  const live = new Map<string, Sandbox>();
  const dbBranches = createDbBranchProvider();
  const deployer = createDeployProvider();
  const media = createMediaProvider();

  const sandboxFor = async (projectId: string): Promise<Sandbox> => {
    const cached = live.get(projectId);
    if (cached) return cached;
    const [p] = await d.db.select().from(projects).where(eq(projects.id, projectId));
    const existing = p?.sandboxId ? await sandboxes.get(p.sandboxId) : null;
    const sb = existing ?? (await sandboxes.create({ projectId }));
    if (!existing) {
      await d.db.update(projects).set({ sandboxId: sb.id }).where(eq(projects.id, projectId));
      // A fresh sandbox (e.g. after a worker restart) starts from the project's saved files, so follow-up
      // prompts edit the existing project instead of an empty directory.
      const saved = await d.db.select({ path: projectFiles.path, content: projectFiles.content }).from(projectFiles).where(eq(projectFiles.projectId, projectId));
      for (const f of saved) {
        const m = BINARY_MEDIA.test(f.path) ? /^data:[^;]+;base64,(.*)$/s.exec(f.content) : null;
        await sb.writeFile(f.path, m ? Uint8Array.from(Buffer.from(m[1]!, "base64")) : f.content);
      }
      if (saved.length) d.log.info("sandbox restored from saved files", { projectId, files: saved.length });
    }
    // Every command (agent tools, gates, dev server) runs with the app's managed .env loaded, so
    // migrations, tests and the preview all use the project's own database and auth secret.
    if (!(sb as { __envWrapped?: boolean }).__envWrapped) {
      const exec0 = sb.exec.bind(sb);
      sb.exec = (cmd, o) => exec0(`set -a; [ -f .env ] && . ./.env >/dev/null 2>&1; set +a; ${cmd}`, o);
      (sb as { __envWrapped?: boolean }).__envWrapped = true;
    }
    live.set(projectId, sb);
    return sb;
  };

  const templates: TemplatesPort = {
    select: (kind, hint) => selectTemplate(kind as Parameters<typeof selectTemplate>[0], hint),
    manifest: (id) => getManifest(id) as ReturnType<TemplatesPort["manifest"]>,
    async scaffold(id, writer, vars) {
      const files = await templateFiles(id, { projectName: vars.projectName ?? "app", ...vars });
      const features = isTemplateId(id) ? (KIT[id] ?? []) : [];
      const kit = features.length ? kitFilesFor(id, features, { packageJson: files["package.json"], forgeJson: files["forge.json"], envExample: files[".env.example"] }) : {};
      const all = { ...files, ...kit };
      for (const [p, c] of Object.entries(all)) await writer.writeFile(p, c);
      return Object.keys(all);
    },
  };

  // The e2e gate needs a Playwright browser inside the sandbox image. Without one (FORGE_E2E_GATE unset) it
  // is reported as skipped — never as passed.
  const e2eEnabled = process.env.FORGE_E2E_GATE === "1";
  const gates: GatesPort = {
    async run(sb, opts) {
      const names: GateName[] = (opts.gates as GateName[] | undefined) ?? (["typecheck", "lint", "unit", "integration", "semgrep", "gitleaks", "osv", "rls", "auth", "validation", "client-secrets", "lighthouse", "visual-qa", "links"] as GateName[]);
      const report = await runGates(sb as unknown as Sandbox, { gates: e2eEnabled ? [...names, "e2e"] : names, previewUrl: opts.previewUrl, visualScore: opts.visualScore, lighthouse: opts.previewUrl ? (u) => runLighthouse(u) : undefined, crawl: opts.previewUrl ? (u) => crawlSite(u) : undefined });
      if (!e2eEnabled) report.results.push({ gate: "e2e", passed: false, skipped: true, details: "no Playwright browser in the sandbox image (set FORGE_E2E_GATE=1 with a browser-enabled image)", findings: [], durationMs: 0 });
      return report;
    },
  };

  const briefFor = (brief: string, spec: { title: string }, kind: string) =>
    ({ name: spec.title.replace(/ (Landing Page|Portfolio)$/, ""), description: brief.slice(0, 1000), kind: kind === "website" ? (/portfolio/i.test(spec.title) ? "portfolio" : "landing") : "app", features: /3d/i.test(brief) ? ["3d"] : /scroll/i.test(brief) ? ["scroll storytelling"] : [] }) as const;
  /**
   * Real photography/illustration for a website (MEDIA_PROVIDER=openai|fal|replicate): a hero image and a
   * supporting image in the art direction's mood and palette, written to public/images/.
   */
  const siteImages = async (brief: string, dir: { name: string; mood: string; palette: { bg: string; accent: string; accent2: string } }, j: BuildJob) => {
    const style = `${dir.mood}; art direction "${dir.name}"; colour palette ${dir.palette.bg}, ${dir.palette.accent}, ${dir.palette.accent2}; no text, no logos, no watermarks`;
    const shots = [
      { path: "public/images/hero.png", w: 1536, h: 1024, what: "hero image", prompt: `Wide hero image for this website: ${brief.slice(0, 600)}` },
      { path: "public/images/feature.png", w: 1024, h: 1024, what: "supporting image for a feature/about section", prompt: `Supporting detail image for this website: ${brief.slice(0, 600)}` },
    ];
    const out: Array<{ path: string; bytes: Uint8Array; description: string }> = [];
    for (const s of shots) {
      const r = await media.textToImage({ prompt: s.prompt, width: s.w, height: s.h, n: 1, style });
      await d.usage.record({ kind: "image_count", quantity: 1, costUsd: r.costUsd, provider: media.name, projectId: j.projectId, taskId: j.taskId, workspaceId: j.workspaceId });
      const bytes = r.items[0]?.bytes;
      if (bytes) out.push({ path: s.path, bytes, description: `${s.what} (${s.w}×${s.h}), served at /${s.path.replace(/^public\//, "")}` });
    }
    return out;
  };

  const design = (llm: MeteredLLM, j: BuildJob): DesignPort => ({
    async proposeDirections({ brief, spec, kind, brand }) {
      return generateDirections(llm, briefFor(brief, spec, kind), brand as never);
    },
    async artDirection({ brief, spec, kind, brand, direction }) {
      const briefIn = briefFor(brief, spec, kind);
      // A direction the user picked from the proposals is used as-is (no new generation, no extra cost).
      const chosen = direction ? ArtDirectionSchema.safeParse(direction) : null;
      const dir = chosen?.success ? normalizeDirection(chosen.data) : pickDirection(await generateDirections(llm, briefIn, brand as never), briefIn);
      const tokensCss = tokensToCss(tokensFromDirection(dir));
      let files: Record<string, string> | undefined;
      if (kind === "website") {
        const content = await generateContent(llm, briefIn);
        files = briefIn.kind === "portfolio" ? composePortfolio({ brief: briefIn, direction: dir, content }) : composeLanding({ brief: briefIn, direction: dir, content });
      }
      const [assets, concept] = await Promise.all([
        kind === "website" && !media.isMock ? siteImages(brief, dir, j).catch(() => []) : Promise.resolve([]),
        kind === "website" ? generateConcept(llm, briefIn, dir).then(conceptToText).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      return { directionName: dir.name, tokensCss, tokens: tokensFromDirection(dir) as unknown as Record<string, unknown>, files, assets, concept };
    },
    async visualQa(url) {
      const r = await analyzePage(url);
      return { score: r.score, notes: r.notes, critic: "heuristic" };
    },
    lighthouse: (url) => runLighthouse(url),
  });

  const cps = createCheckpointing(d.db, dbBranches);

  /**
   * The app's runtime environment in its sandbox: a real Postgres database with its own least-privilege
   * role (per project), an auth secret and the public preview URL, written to a managed block in .env.
   * Secrets are derived (HMAC) from the platform secret, so nothing extra is stored.
   */
  const secretBase = process.env.FILES_SECRET || process.env.AUTH_SECRET || "dev-secret";
  const derive = (purpose: string, projectId: string) => createHmac("sha256", secretBase).update(`${purpose}:${projectId}`).digest("base64url").slice(0, 40);
  const appEnv = async (projectId: string): Promise<Record<string, string>> => {
    const env: Record<string, string> = { BETTER_AUTH_SECRET: derive("auth", projectId), NODE_ENV: "development" };
    const pub = process.env.PREVIEW_PUBLIC_URL?.replace(/\/$/, "");
    if (pub) Object.assign(env, { BETTER_AUTH_URL: pub, APP_URL: pub, NEXT_PUBLIC_APP_URL: pub, PUBLIC_URL: pub });
    if (dbBranches instanceof PgCloneBranchProvider) {
      const root = await cps.ensureProjectDb(projectId);
      if (root) {
        const url = await dbBranches.ensureAppRole(root, `${root}_app`.slice(0, 60), derive("db", projectId));
        Object.assign(env, { DATABASE_URL: url, DATABASE_MIGRATION_URL: url });
      }
    }
    return env;
  };
  const appEnvSetup = async (sb: SandboxPort, projectId: string) => {
    const env = await appEnv(projectId);
    const block = ["# >>> forge managed (database + auth for the preview) — do not edit", ...Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`), "# <<< forge managed"].join("\n");
    const cur = await sb.readFile(".env").catch(() => "");
    const rest = cur.replace(/# >>> forge managed[\s\S]*?# <<< forge managed\n?/g, "").trim();
    await sb.writeFile(".env", `${block}\n${rest ? `${rest}\n` : ""}`);
    const gi = await sb.readFile(".gitignore").catch(() => "");
    if (!/^\.env$/m.test(gi)) await sb.writeFile(".gitignore", `${gi.trimEnd()}\n.env\n`.trimStart());
    return env;
  };
  const setupPort: ProjectSetupPort = {
    async prepare(sb, ctx) {
      const notes: string[] = [];
      const env = await appEnvSetup(sb, ctx.projectId).catch((e: Error) => (notes.push(`App database/env not configured: ${e.message.slice(0, 200)}`), null));
      if (env?.DATABASE_URL) {
        notes.push("A private Postgres database is connected (DATABASE_URL in .env); sign-up and data work in the preview.");
        // Apply the app's migrations to its database (no-op when there are none yet).
        const pkg = await sb.readFile("package.json").catch(() => "");
        if (/"db:migrate"\s*:/.test(pkg)) {
          const m = await sb.exec("test -d node_modules && npm run db:migrate 2>&1 | tail -20", { timeoutMs: 180_000 });
          if (m.exitCode !== 0) notes.push(`Database migrations did not apply yet: ${(m.stdout + m.stderr).slice(-300)}`);
        }
      }
      const ve = await visualEditSetup.prepare(sb, ctx);
      return { packageJsonChanged: ve.packageJsonChanged, notes: [...notes, ...ve.notes] };
    },
  };

  // Preview links: the agent sees the dev server's internal URL; users get a signed link to the preview
  // proxy (its own origin), which forwards to this worker over the private network.
  const previewBase = process.env.PREVIEW_PUBLIC_URL?.replace(/\/$/, "");
  const secret = process.env.AUTH_SECRET;
  const wsink = d.events as { transform?: ((e: ForgeEventInput) => ForgeEventInput) | null };
  if (previewBase && secret && "transform" in wsink) {
    wsink.transform = (e) => {
      if (e.type !== "preview.ready") return e;
      const u = new URL(e.url);
      if (["127.0.0.1", "localhost", "0.0.0.0"].includes(u.hostname)) u.hostname = process.env.RAILWAY_PRIVATE_DOMAIN || process.env.PREVIEW_TARGET_HOST || u.hostname;
      const token = signPreviewToken({ projectId: e.projectId, target: u.origin, exp: Math.floor(Date.now() / 1000) + 24 * 3600 }, secret);
      return { ...e, url: `${previewBase}/__forge/open?t=${encodeURIComponent(token)}` };
    };
  }

  // Live file mirror: every file the agent writes lands in project_files immediately (not only at
  // checkpoints), so the editor and file tree update while the build runs.
  const sink = d.events as { onEvent?: (fn: (e: { type: string; projectId: string; path?: string; change?: string }) => void) => () => void };
  sink.onEvent?.((e) => {
    // .env holds the app's database credentials: it stays in the sandbox and never reaches saved files.
    if (e.type !== "file.changed" || !e.path || /(^|\/)(node_modules|\.git|dist|\.next)(\/|$)|(^|\/)\.env(\.local)?$/.test(e.path)) return;
    const sb = live.get(e.projectId);
    if (!sb) return;
    const path = e.path;
    void (async () => {
      if (e.change === "deleted") return d.db.delete(projectFiles).where(and(eq(projectFiles.projectId, e.projectId), eq(projectFiles.path, path)));
      // Binary media (generated images) are kept as data: URIs so a fresh sandbox can restore them.
      const media = BINARY_MEDIA.exec(path);
      const content = media
        ? await sb.exec(`base64 -w0 -- ${JSON.stringify(path)}`, { timeoutMs: 30_000 }).then((r) => (r.exitCode === 0 && r.stdout.length < 12_000_000 ? `data:${MIME[media[1]!.toLowerCase()]};base64,${r.stdout.trim()}` : null))
        : await sb.readFile(path).catch(() => null);
      if (content === null || (!media && (content.length > 500_000 || content.includes("\u0000")))) return;
      await d.db.insert(projectFiles).values({ projectId: e.projectId, path, content }).onConflictDoUpdate({ target: [projectFiles.projectId, projectFiles.path], set: { content, updatedAt: new Date() } });
    })().catch(() => undefined);
  });
  const checkpointsPort = (_job: BuildJob): CheckpointPort => ({ create: (i) => cps.create(i) });

  const browser: BrowserPort = {
    async screenshot(url, viewport) {
      const { chromium } = await import("playwright");
      const b = await chromium.launch();
      try {
        const page = await b.newPage({ viewport: { width: viewport, height: Math.round(viewport * 0.65) } });
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        const png = await page.screenshot({ fullPage: false });
        const key = `screenshots/${newId("shot")}-${viewport}.png`;
        await d.store.put(key, png, { contentType: "image/png" });
        return { url: await d.store.url(key) };
      } finally {
        await b.close();
      }
    },
  };

  const settle = billingSettler(d.db);
  const renderRemotion = async (o: { composition: "Explainer" | "ProductDemo" | "AnimatedText"; props: unknown; durationSec: number }) => {
    const { renderRemotionVideo } = await import("@forge/media/remotion");
    return renderRemotionVideo(o);
  };

  /**
   * Import a GitHub repository into a project: shallow clone into the sandbox (GITHUB_TOKEN for private
   * repos), save the files, detect the template from forge.json / package.json and start the preview path.
   */
  const importGithub = async (p: { projectId: string; repo: string; branch?: string }) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo)) throw new Error("Invalid repository");
    const branch = /^[\w./-]{1,100}$/.test(p.branch ?? "main") ? (p.branch ?? "main") : "main";
    const sb = await sandboxFor(p.projectId);
    const base = { projectId: p.projectId };
    d.events.emit({ type: "message", ...base, role: "system", text: `Importing github.com/${p.repo} (${branch})…` });
    const token = process.env.GITHUB_TOKEN;
    const url = token ? `https://x-access-token:${token}@github.com/${p.repo}.git` : `https://github.com/${p.repo}.git`;
    const clone = await sb.exec(`rm -rf .forge-import && git clone --depth 1 --branch ${JSON.stringify(branch)} ${JSON.stringify(url)} .forge-import 2>&1 || git clone --depth 1 ${JSON.stringify(url)} .forge-import 2>&1`, { timeoutMs: 300_000 });
    if (clone.exitCode !== 0) {
      const msg = (clone.stdout + clone.stderr).replace(token ?? "\u0000", "***").slice(-600);
      d.events.emit({ type: "message", ...base, role: "system", text: `GitHub import failed: ${msg}` });
      throw new Error(`git clone failed for ${p.repo}`);
    }
    await sb.exec("rm -rf .forge-import/.git && cp -a .forge-import/. . && rm -rf .forge-import", { timeoutMs: 120_000 });
    const files = (await sb.listFiles(".", { recursive: true })).filter((f) => !/(^|\/)(node_modules|\.git|dist|\.next|build)(\/|$)/.test(f));
    let saved = 0;
    for (const f of files.slice(0, 2000)) {
      const content = await sb.readFile(f).catch(() => null);
      if (content === null || content.length > 500_000 || content.includes("\u0000")) continue;
      await d.db.insert(projectFiles).values({ projectId: p.projectId, path: f, content }).onConflictDoUpdate({ target: [projectFiles.projectId, projectFiles.path], set: { content, updatedAt: new Date() } });
      d.events.emit({ type: "file.changed", ...base, path: f, change: "created" });
      saved++;
    }
    const pkg = await sb.readFile("package.json").then((s) => JSON.parse(s) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }).catch(() => null);
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const template = deps.next ? "nextjs" : deps.astro ? "astro-site" : deps.expo ? "expo" : deps.hono ? "hono-api" : deps.vite ? "vite-react-ts" : null;
    await d.db.update(projects).set({ githubRepo: p.repo, ...(template ? { template } : {}) }).where(eq(projects.id, p.projectId));
    d.events.emit({ type: "message", ...base, role: "system", text: `Imported ${saved} files from github.com/${p.repo}${template ? ` (${template})` : ""}. Ask for a change to start building on it.` });
    return { files: saved, template };
  };

  d.consume(
    QUEUES.build,
    async (job: Job) => {
      if (job.name === "restore-checkpoint") return restoreCheckpoint(job.data as { projectId: string; checkpointId: string });
      if (job.name === "import-github") return importGithub(job.data as { projectId: string; repo: string; branch?: string });
      const payload = BuildJobSchema.parse(job.data);
      const llm = new MeteredLLM(d.llm, d.usage, { workspaceId: payload.workspaceId, projectId: payload.projectId, taskId: payload.taskId });
      return runBuildJob(payload, {
        db: d.db,
        llm: d.llm,
        events: d.events as never,
        usage: d.usage,
        settle,
        sandboxFor: (projectId) => sandboxFor(projectId) as unknown as Promise<SandboxPort>,
        agentPorts: async (j) =>
          ({
            templates,
            gates,
            design: design(llm, j),
            checkpoints: checkpointsPort(j),
            browser,
            setup: setupPort,
            ...(d.integrations ? { integrations: { listTools: (pid: string) => d.integrations!.listProjectTools(pid), call: (pid: string, tool: string, input: unknown) => d.integrations!.callProjectTool(pid, tool, input) } } : {}),
            media: {
              generateImage: async (i) => (await runMediaRequest({ taskId: j.taskId, projectId: i.projectId, workspaceId: j.workspaceId, kind: "image", prompt: i.prompt, options: { n: i.n } }, { db: d.db, provider: media, store: d.store, usage: d.usage, events: d.events })).map((a) => ({ artifactId: a.id, url: a.storageKey })),
              generateVideo: async (i) => {
                const [a] = await runMediaRequest({ taskId: j.taskId, projectId: i.projectId, workspaceId: j.workspaceId, kind: "video", prompt: i.prompt, options: { durationSec: i.durationSec } }, { db: d.db, provider: media, store: d.store, usage: d.usage, events: d.events });
                return { artifactId: a!.id, url: a!.storageKey };
              },
            },
            slides: { createDeck: async (i) => ({ artifactId: (await runSlidesRequest({ taskId: j.taskId, projectId: i.projectId, workspaceId: j.workspaceId, kind: "deck", prompt: i.prompt, slideCount: i.slideCount }, { db: d.db, llm, store: d.store, usage: d.usage, events: d.events })).artifactId }) },
          }) satisfies Omit<AgentDeps, "llm" | "events" | "usage" | "sandbox">,
        pipelines: {
          question: async (j, pd) => void (await runChat(j, { db: d.db, llm: pd.llm, events: pd.events })),
          media: async (j, kind) => void (await runMediaRequest({ taskId: j.taskId, projectId: j.projectId, workspaceId: j.workspaceId, kind: kind === "image" ? (/\b(set|images|bilder|\d+ (product )?images)\b/i.test(j.prompt) ? "image-set" : "image") : j.intents.some((i) => i.kind === "video" && i.hint === "remotion") ? "remotion" : "video", prompt: j.prompt, options: { durationSec: Number(j.prompt.match(/(\d+)[- ]?(?:second|sekund|s\b)/i)?.[1] ?? 10) } }, { db: d.db, provider: media, store: d.store, usage: d.usage, events: d.events, renderRemotion })),
          slides: async (j, kind) => void (await runSlidesRequest({ taskId: j.taskId, projectId: j.projectId, workspaceId: j.workspaceId, kind: kind === "slides" ? "deck" : "document", prompt: j.prompt, slideCount: Number(j.prompt.match(/(\d+)[- ]slide/)?.[1] ?? 10) }, { db: d.db, llm, store: d.store, usage: d.usage, events: d.events })),
        },
        isCancelled: async () => false,
      });
    },
    Number(process.env.BUILD_CONCURRENCY || 2),
  );

  async function restoreCheckpoint(i: { projectId: string; checkpointId: string }) {
    const sb = await sandboxFor(i.projectId);
    const cp = await cps.restore({ sandbox: sb as unknown as SandboxPort, projectId: i.projectId, checkpointId: i.checkpointId });
    d.events.emit({ type: "checkpoint.created", projectId: i.projectId, checkpointId: cp.id, commit: cp.commitSha, label: `restored: ${cp.label}` });
    return { restored: cp.id };
  }

  // Bring a finished project's preview back (dev servers do not survive a worker restart).
  d.consume(
    QUEUES.preview,
    async (job: Job) => {
      const { projectId } = job.data as { projectId: string };
      const sb = await sandboxFor(projectId);
      const forge = await sb.readFile("forge.json").then((s) => JSON.parse(s) as { dev?: string; port?: number; install?: string }).catch(() => null);
      const [p] = await d.db.select({ template: projects.template }).from(projects).where(eq(projects.id, projectId));
      const fallback = p?.template && isTemplateId(p.template) ? getManifest(p.template) : null;
      const dev = forge?.dev ?? fallback?.dev;
      const port = forge?.port ?? fallback?.port;
      if (!dev || !port) return { started: false, reason: "no dev command" };
      const hasDeps = await sb.exec("test -d node_modules && echo yes || echo no", { timeoutMs: 10_000 });
      if (hasDeps.stdout.trim() !== "yes" && (forge?.install ?? fallback?.install)) await sb.exec(`${forge?.install ?? fallback?.install} --prefer-offline --no-audit --no-fund --loglevel=error`, { timeoutMs: 900_000 });
      await setupPort.prepare(sb as unknown as SandboxPort, { projectId }).catch(() => undefined);
      const url = await startDevPreview(sb as unknown as SandboxPort, d.events, { id: p?.template ?? "project", kind: "app", install: forge?.install ?? "npm install", dev, port } as never, { projectId }, 180);
      return { started: !!url };
    },
    4,
  );

  d.consume(QUEUES.deploy, async (job: Job) => {
    const p = DeployJobSchema.parse(job.data);
    const [project] = await d.db.select().from(projects).where(eq(projects.id, p.projectId));
    if (!project) throw new Error("Project not found");
    if (job.name === "rollback" && p.rollbackTo) {
      const r = await deployer.rollback(p.projectId, p.rollbackTo);
      await d.db.update(deployments).set({ status: "rolled_back" }).where(and(eq(deployments.projectId, p.projectId), eq(deployments.status, "live")));
      await d.db.update(deployments).set({ status: "live", url: r.url }).where(eq(deployments.id, p.rollbackTo));
      d.events.emit({ type: "deploy.status", projectId: p.projectId, deploymentId: p.rollbackTo, status: "live", url: r.url });
      return r;
    }
    const sb = await sandboxFor(p.projectId);
    const report = await runGates(sb, {});
    const depId = newId("dep");
    if (!report.passed) {
      await d.db.insert(deployments).values({ id: depId, projectId: p.projectId, checkpointId: p.checkpointId, branch: p.branch, provider: deployer.name, region: process.env.DATA_REGION || "eu-central-1", status: "blocked", gateReport: report as unknown as object });
      for (const g of report.blockers) d.events.emit({ type: "gate.result", projectId: p.projectId, gate: g.gate, passed: false, details: g.details.slice(0, 2000), fix: g.fix });
      d.events.emit({ type: "deploy.status", projectId: p.projectId, deploymentId: depId, status: "blocked" });
      return { blocked: report.blockers.map((b) => b.gate) };
    }
    const manifest = project.template && isTemplateId(project.template) ? getManifest(project.template) : null;
    const r = await deployer.deploy({ projectId: p.projectId, dir: sb.workdir, branch: p.branch, port: manifest?.containerPort ?? manifest?.port, healthPath: manifest?.healthPath });
    await d.db.update(deployments).set({ status: "rolled_back" }).where(and(eq(deployments.projectId, p.projectId), eq(deployments.branch, p.branch), eq(deployments.status, "live")));
    await d.db.insert(deployments).values({ id: depId, projectId: p.projectId, checkpointId: p.checkpointId, branch: p.branch, url: r.url, provider: deployer.name, region: r.region, status: "live", gateReport: report as unknown as object });
    d.events.emit({ type: "deploy.status", projectId: p.projectId, deploymentId: depId, status: "live", url: r.url });
    return { url: r.url };
  }, 2);

}
