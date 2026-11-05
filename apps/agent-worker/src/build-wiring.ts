import type { Job } from "bullmq";
import { and, eq, projects, deployments } from "@forge/db";
import { MeteredLLM } from "@forge/llm";
import { QUEUES, newId, BuildJobSchema, DeployJobSchema, type BuildJob } from "@forge/shared";
import type { AgentDeps, SandboxPort, DesignPort, CheckpointPort, GatesPort, TemplatesPort, BrowserPort } from "@forge/agent-core";
import { createSandboxProvider, type Sandbox, type SandboxProvider } from "@forge/sandbox";
import { runGates, type GateName } from "@forge/quality-gates";
import { selectTemplate, getManifest, templateFiles, isTemplateId } from "@forge/templates";
import { kitFilesFor, createDbBranchProvider, createDeployProvider, type KitFeature } from "@forge/app-kit";
import { createCheckpointing } from "./checkpoints.js";
import { generateDirections, pickDirection, tokensFromDirection, tokensToCss, composeLanding, composePortfolio, generateContent, analyzePage, runLighthouse } from "@forge/design";
import { billingSettler } from "./settle.js";
import { runBuildJob } from "./jobs/build.js";
import { runMediaRequest } from "./jobs/media.js";
import { runSlidesRequest } from "./jobs/slides.js";
import { createMediaProvider } from "@forge/media";
import type { BuildQueueDeps } from "./build-queue.js";

/** Kit features added to each template on scaffold (auth apps get Better Auth + Drizzle + RLS helper). */
const KIT: Record<string, KitFeature[]> = { nextjs: ["auth", "db", "seo"], "vite-react-ts": [], "astro-site": ["seo"], expo: [], fastapi: [], "hono-api": [] };

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
    if (!existing) await d.db.update(projects).set({ sandboxId: sb.id }).where(eq(projects.id, projectId));
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
      const names: GateName[] = (opts.gates as GateName[] | undefined) ?? (["typecheck", "lint", "unit", "integration", "semgrep", "gitleaks", "osv", "rls", "auth", "validation", "client-secrets", "lighthouse", "visual-qa"] as GateName[]);
      const report = await runGates(sb as unknown as Sandbox, { gates: e2eEnabled ? [...names, "e2e"] : names, previewUrl: opts.previewUrl, visualScore: opts.visualScore, lighthouse: opts.previewUrl ? (u) => runLighthouse(u) : undefined });
      if (!e2eEnabled) report.results.push({ gate: "e2e", passed: false, skipped: true, details: "no Playwright browser in the sandbox image (set FORGE_E2E_GATE=1 with a browser-enabled image)", findings: [], durationMs: 0 });
      return report;
    },
  };

  const design = (llm: MeteredLLM): DesignPort => ({
    async artDirection({ brief, spec, kind, brand }) {
      const briefIn = { name: spec.title.replace(/ (Landing Page|Portfolio)$/, ""), description: brief.slice(0, 1000), kind: kind === "website" ? (/portfolio/i.test(spec.title) ? "portfolio" : "landing") : "app", features: /3d/i.test(brief) ? ["3d"] : /scroll/i.test(brief) ? ["scroll storytelling"] : [] } as const;
      const dirs = await generateDirections(llm, briefIn, brand as never);
      const dir = pickDirection(dirs, briefIn);
      const tokensCss = tokensToCss(tokensFromDirection(dir));
      let files: Record<string, string> | undefined;
      if (kind === "website") {
        const content = await generateContent(llm, briefIn);
        files = briefIn.kind === "portfolio" ? composePortfolio({ brief: briefIn, direction: dir, content }) : composeLanding({ brief: briefIn, direction: dir, content });
      }
      return { directionName: dir.name, tokensCss, tokens: tokensFromDirection(dir) as unknown as Record<string, unknown>, files };
    },
    async visualQa(url) {
      const r = await analyzePage(url);
      return { score: r.score, notes: r.notes, critic: "heuristic" };
    },
    lighthouse: (url) => runLighthouse(url),
  });

  const cps = createCheckpointing(d.db, dbBranches);
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

  d.consume(
    QUEUES.build,
    async (job: Job) => {
      if (job.name === "restore-checkpoint") return restoreCheckpoint(job.data as { projectId: string; checkpointId: string });
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
            design: design(llm),
            checkpoints: checkpointsPort(j),
            browser,
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
