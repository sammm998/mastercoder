import type { Job } from "bullmq";
import { and, eq, checkpoints, projects, projectFiles, deployments } from "@forge/db";
import { MeteredLLM } from "@forge/llm";
import { QUEUES, newId, BuildJobSchema, DeployJobSchema, type BuildJob } from "@forge/shared";
import type { AgentDeps, SandboxPort, DesignPort, CheckpointPort, GatesPort, TemplatesPort, BrowserPort } from "@forge/agent-core";
import { createSandboxProvider, type Sandbox, type SandboxProvider } from "@forge/sandbox";
import { runGates } from "@forge/quality-gates";
import { selectTemplate, getManifest, templateFiles, isTemplateId } from "@forge/templates";
import { kitFilesFor, createDbBranchProvider, createDeployProvider, PgCloneBranchProvider, type KitFeature } from "@forge/app-kit";
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

  const gates: GatesPort = {
    run: (sb, opts) => runGates(sb as unknown as Sandbox, { previewUrl: opts.previewUrl, visualScore: opts.visualScore, lighthouse: opts.previewUrl ? (u) => runLighthouse(u) : undefined }),
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

  const checkpointsPort = (job: BuildJob): CheckpointPort => ({
    async create({ sandbox, projectId, taskId, label }) {
      await sandbox.exec(`git init -q 2>/dev/null; git -c user.email=agent@forge.local -c user.name="Forge" add -A && git -c user.email=agent@forge.local -c user.name="Forge" commit -qm ${JSON.stringify(`checkpoint: ${label}`)} --allow-empty`, { timeoutMs: 60_000 });
      const commit = (await sandbox.exec("git rev-parse HEAD")).stdout.trim() || "unknown";
      const { snapshotId } = await sandbox.snapshot(label);
      let dbBranchId: string | undefined;
      const [p] = await d.db.select().from(projects).where(eq(projects.id, projectId));
      const root = p?.dbBranchRoot ?? (await ensureProjectDb(projectId));
      if (root) dbBranchId = (await dbBranches.createBranch(root, `cp_${Date.now().toString(36)}`)).branchId;
      const id = newId("cp");
      await d.db.insert(checkpoints).values({ id, projectId, taskId, label, commitSha: commit, sandboxSnapshotId: snapshotId, dbBranchId });
      await mirrorFiles(sandbox, projectId);
      void job;
      return { checkpointId: id, commit, snapshotId, dbBranchId };
    },
  });

  async function ensureProjectDb(projectId: string): Promise<string | null> {
    if (!(dbBranches instanceof PgCloneBranchProvider)) return null;
    const root = `app_${projectId.replace(/[^a-z0-9]/g, "_")}`.slice(0, 40);
    if (!(await dbBranches.exists(root))) await dbBranches.createDatabase(root);
    await d.db.update(projects).set({ dbBranchRoot: root }).where(eq(projects.id, projectId));
    return root;
  }

  /** Durable copy of the project's source files for the editor, remix and export. */
  async function mirrorFiles(sandbox: SandboxPort, projectId: string) {
    const files = (await sandbox.listFiles(".", { recursive: true })).filter((f) => !/(^|\/)(node_modules|\.git|\.next|dist|\.venv|__pycache__)(\/|$)/.test(f)).slice(0, 2000);
    for (const path of files) {
      const content = await sandbox.readFile(path).catch(() => null);
      if (content === null || content.length > 500_000 || content.includes("\u0000")) continue;
      await d.db.insert(projectFiles).values({ projectId, path, content }).onConflictDoUpdate({ target: [projectFiles.projectId, projectFiles.path], set: { content, updatedAt: new Date() } });
    }
  }

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
          media: async (j, kind) => void (await runMediaRequest({ taskId: j.taskId, projectId: j.projectId, workspaceId: j.workspaceId, kind: kind === "image" ? (/\b(set|images|bilder|\d+ (product )?images)\b/i.test(j.prompt) ? "image-set" : "image") : "video", prompt: j.prompt, options: {} }, { db: d.db, provider: media, store: d.store, usage: d.usage, events: d.events })),
          slides: async (j, kind) => void (await runSlidesRequest({ taskId: j.taskId, projectId: j.projectId, workspaceId: j.workspaceId, kind: kind === "slides" ? "deck" : "document", prompt: j.prompt, slideCount: Number(j.prompt.match(/(\d+)[- ]slide/)?.[1] ?? 10) }, { db: d.db, llm, store: d.store, usage: d.usage, events: d.events })),
        },
        isCancelled: async () => false,
      });
    },
    Number(process.env.BUILD_CONCURRENCY || 2),
  );

  async function restoreCheckpoint(i: { projectId: string; checkpointId: string }) {
    const [cp] = await d.db.select().from(checkpoints).where(and(eq(checkpoints.id, i.checkpointId), eq(checkpoints.projectId, i.projectId)));
    if (!cp) throw new Error("Checkpoint not found");
    const sb = await sandboxFor(i.projectId);
    if (cp.sandboxSnapshotId) await sb.restore(cp.sandboxSnapshotId);
    const [p] = await d.db.select().from(projects).where(eq(projects.id, i.projectId));
    if (cp.dbBranchId && p?.dbBranchRoot) await dbBranches.restoreBranch(p.dbBranchRoot, cp.dbBranchId);
    await mirrorFiles(sb as unknown as SandboxPort, i.projectId);
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
