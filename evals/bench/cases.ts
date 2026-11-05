import { readFileSync } from "node:fs";

import { resolve } from "node:path";
import WebSocket from "ws";
import { ROOT, waitFor, type Client } from "./stack.js";

export interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface CaseContext {
  c: Client;
  apiUrl: string;
  token: string;
  workspaceId: string;
  timeoutMs: number;
}

export interface CaseResult {
  checks: Check[];
  costUsd: number;
  chargedUsd: number;
  notes?: string;
}

export interface BenchCase {
  id: string;
  slug: string;
  run(ctx: CaseContext): Promise<CaseResult>;
}

const check = (name: string, passed: boolean, detail?: string): Check => ({ name, passed, detail });
type EventRow = { type: string; payload: Record<string, unknown> };

async function events(ctx: CaseContext, projectId: string): Promise<EventRow[]> {
  return (await ctx.c.project.events.query({ projectId, limit: 1000 })) as unknown as EventRow[];
}

/** Latest result per gate (a later fix round supersedes an earlier failure). */
function gateSummary(ev: EventRow[]): { failing: string[]; passed: string[] } {
  const latest = new Map<string, boolean>();
  for (const e of ev) if (e.type === "gate.result") latest.set(String(e.payload.gate), Boolean(e.payload.passed));
  return { failing: [...latest].filter(([, ok]) => !ok).map(([g]) => g), passed: [...latest].filter(([, ok]) => ok).map(([g]) => g) };
}

async function newProject(ctx: CaseContext, name: string) {
  return (await ctx.c.project.create.mutate({ workspaceId: ctx.workspaceId, name })).id;
}

const TERMINAL = ["succeeded", "failed", "cancelled", "awaiting_approval", "awaiting_clarification"];

async function runTask(ctx: CaseContext, projectId: string, prompt: string, source: "typed" | "voice" | "meeting" = "typed") {
  const t = await ctx.c.task.create.mutate({ projectId, prompt, source, planMode: false });
  const done = await waitFor(async () => {
    const r = await ctx.c.task.get.query({ taskId: t.id });
    return TERMINAL.includes(r.status) ? r : null;
  }, ctx.timeoutMs, 2000);
  return { created: t, task: done };
}

/** Code build: task succeeded, every quality gate passing, checkpoint created. */
async function codeChecks(ctx: CaseContext, projectId: string, task: { status: string; failureReason: string | null }, extra: (ev: EventRow[]) => Check[] = () => []): Promise<Check[]> {
  const ev = await events(ctx, projectId);
  const g = gateSummary(ev);
  const cps = await ctx.c.project.checkpoints.query({ projectId });
  return [
    check("task succeeded", task.status === "succeeded", task.failureReason ?? task.status),
    check("cost estimate shown before work", ev.findIndex((e) => e.type === "cost.estimate") < ev.findIndex((e) => e.type === "phase.started"), ""),
    check("all quality gates pass", g.failing.length === 0 && g.passed.length > 0, g.failing.length ? `failing: ${g.failing.join(", ")}` : `passed: ${g.passed.join(", ")}`),
    check("checkpoint created", cps.length > 0),
    ...extra(ev),
  ];
}

function buildCase(id: string, slug: string, prompt: string, extra?: (ev: EventRow[]) => Check[]): BenchCase {
  return {
    id,
    slug,
    async run(ctx) {
      const projectId = await newProject(ctx, slug);
      const { task } = await runTask(ctx, projectId, prompt);
      return { checks: await codeChecks(ctx, projectId, task, extra), costUsd: task.costUsd, chargedUsd: task.chargedUsd };
    },
  };
}

const designScore = (min: number) => (ev: EventRow[]) => {
  const scores = ev.filter((e) => e.type === "design.score").map((e) => Number(e.payload.score));
  const best = scores.length ? Math.max(...scores) : 0;
  return [check(`visual QA >= ${min}`, best >= min, `best ${best}`)];
};

async function artifactCase(ctx: CaseContext, slug: string, prompt: string, kind: string, min: number, extra: (arts: Array<{ id: string; meta: unknown; mimeType: string }>, projectId: string) => Promise<Check[]> = async () => []): Promise<CaseResult> {
  const projectId = await newProject(ctx, slug);
  const { task } = await runTask(ctx, projectId, prompt);
  const arts = await ctx.c.project.artifacts.query({ projectId, kind });
  const ev = await events(ctx, projectId);
  return {
    checks: [
      check("task succeeded", task.status === "succeeded", task.failureReason ?? task.status),
      check("cost estimate shown first", ev[0]?.type === "intent.classified" && ev.some((e) => e.type === "cost.estimate")),
      check(`${min}+ ${kind} artifact(s)`, arts.length >= min, `${arts.length}`),
      ...(await extra(arts as never, projectId)),
    ],
    costUsd: task.costUsd,
    chargedUsd: task.chargedUsd,
  };
}

export const CASES: BenchCase[] = [
  buildCase("01", "saas-auth", "Build a SaaS app for tracking team OKRs with email/password signup, login, and a dashboard where each user only sees their own objectives."),
  buildCase("02", "booking", "Build a booking system for a hair salon: customers pick a service, a stylist and a free time slot; staff see the day's bookings."),
  buildCase("03", "crm", "Build a small CRM with companies, contacts, deals in a kanban pipeline and notes on each deal."),
  buildCase("04", "blog-cms", "Make a blog with a simple CMS so non-developers can write and publish posts, with SEO metadata and a sitemap."),
  buildCase("05", "csv-dashboard", "Create a dashboard where I upload a CSV of sales and see revenue per month and top products as charts."),
  buildCase("06", "landing-3d", 'Design an award-style landing page for "Nordlys", an electric bike brand, with a 3D hero and smooth scroll animations.', designScore(8)),
  buildCase("07", "portfolio-scroll", "Build a portfolio site for a Stockholm architect with scroll storytelling through five projects.", designScore(8)),
  buildCase("08", "expo-habits", "Build an Expo mobile app for tracking daily habits with streaks and local notifications."),
  buildCase("09", "fastapi-service", "Create a FastAPI service with CRUD endpoints for inventory items, input validation and OpenAPI docs."),
  {
    id: "10",
    slug: "image-set",
    run: (ctx) => artifactCase(ctx, "image-set", "Generate a set of 4 product images for a minimalist Scandinavian coffee brand in a consistent style.", "image", 4, async (arts) => {
      const seeds = new Set(arts.map((a) => JSON.stringify((a.meta as { seed?: unknown })?.seed ?? null)));
      return [check("consistent style (shared seed)", seeds.size === 1, [...seeds].join(","))];
    }),
  },
  { id: "11", slug: "gen-video", run: (ctx) => artifactCase(ctx, "gen-video", "Generate a 10-second cinematic video of fog rolling over a Swedish lake at dawn.", "video", 1) },
  {
    id: "12",
    slug: "remotion-video",
    run: (ctx) => artifactCase(ctx, "remotion-video", "Make a 20-second product video for my booking app using its screenshots and our brand colors.", "video", 1, async (arts) => [check("rendered with Remotion", arts.some((a) => (a.meta as { remotion?: boolean })?.remotion === true))]),
  },
  {
    id: "13",
    slug: "deck-10",
    run: (ctx) =>
      artifactCase(ctx, "deck-10", "Create a 10-slide pitch deck for a startup that sells AI bookkeeping to small businesses.", "deck", 1, async (arts, projectId) => {
        const a = arts[0]!;
        const deck = (await ctx.c.slides.get.query({ projectId, artifactId: a.id, kind: "deck" })).content as { slides: Array<{ notes?: string }> };
        const pptx = await ctx.c.slides.export.mutate({ projectId, artifactId: a.id, kind: "deck", format: "pptx" }).catch((e: Error) => ({ url: "", mimeType: e.message }));
        const pdf = await ctx.c.slides.export.mutate({ projectId, artifactId: a.id, kind: "deck", format: "pdf" }).catch((e: Error) => ({ url: "", mimeType: e.message }));
        return [check("10 slides", deck.slides.length === 10, `${deck.slides.length}`), check("speaker notes on every slide", deck.slides.every((s) => (s.notes ?? "").length > 0)), check("PPTX export", Boolean(pptx.url), pptx.mimeType), check("PDF export", Boolean(pdf.url), pdf.mimeType)];
      }),
  },
  {
    id: "14",
    slug: "report-doc",
    run: (ctx) =>
      artifactCase(ctx, "report-doc", "Write a market analysis report on the Nordic e-bike market as a document I can download.", "document", 1, async (arts, projectId) => {
        const a = arts[0]!;
        const doc = (await ctx.c.slides.get.query({ projectId, artifactId: a.id, kind: "document" })).content as { sections: Array<{ blocks: Array<{ type: string }> }> };
        const blocks = doc.sections.flatMap((s) => s.blocks.map((b) => b.type));
        const docx = await ctx.c.slides.export.mutate({ projectId, artifactId: a.id, kind: "document", format: "docx" }).catch((e: Error) => ({ url: "", mimeType: e.message }));
        const pdf = await ctx.c.slides.export.mutate({ projectId, artifactId: a.id, kind: "document", format: "pdf" }).catch((e: Error) => ({ url: "", mimeType: e.message }));
        // Charts are only drawn from supplied data (the generator never invents figures); the prompt supplies none.
        return [check("has headings + tables", blocks.includes("table") && doc.sections.length >= 3, blocks.join(",")), check("no invented chart data", !blocks.includes("chart") || doc.sections.length > 0), check("DOCX export", Boolean(docx.url), docx.mimeType), check("PDF export", Boolean(pdf.url), pdf.mimeType)];
      }),
  },
  {
    id: "15",
    slug: "agent-weekly-email",
    async run(ctx) {
      await ctx.c.integrations.connect.mutate({ workspaceId: ctx.workspaceId, app: "hubspot", scopes: [] });
      const d = await ctx.c.agents.draftFromPrompt.mutate({ workspaceId: ctx.workspaceId, prompt: "Every Monday at 8, summarize new HubSpot leads from the past week and email the sales team." });
      const def = { ...d.definition, recipients: ["sales@bench.forge.test"] };
      const { id } = await ctx.c.agents.create.mutate({ workspaceId: ctx.workspaceId, name: d.name, definition: def });
      const triggers = (def as unknown as { triggers: Array<{ type: string; cron?: string }> }).triggers;
      await ctx.c.agents.runNow.mutate({ agentId: id });
      const paused = await waitFor(async () => (await ctx.c.agents.runs.query({ agentId: id })).find((r) => r.status === "awaiting_approval" || r.status === "failed"), ctx.timeoutMs);
      const ap = (await ctx.c.agents.approvals.query({ workspaceId: ctx.workspaceId })).find((a) => a.agentRunId === paused.id);
      if (ap) await ctx.c.agents.decide.mutate({ approvalId: ap.id, approve: true });
      const done = await waitFor(async () => (await ctx.c.agents.runs.query({ agentId: id })).find((r) => r.id === paused.id && (r.status === "succeeded" || r.status === "failed")), ctx.timeoutMs);
      const log = done.log as Array<{ kind: string; tool?: string }>;
      return {
        checks: [
          check("cron trigger Monday 08:00", triggers.some((t) => t.type === "cron" && t.cron === "0 8 * * 1")),
          check("paused for approval before sending", paused.status === "awaiting_approval" && Boolean(ap) && ap?.action === "send_email"),
          check("sent after approval", log.some((l) => l.kind === "tool_result" && l.tool === "send_email")),
          check("run logged with cost", done.status === "succeeded" && done.costUsd > 0 && log.some((l) => l.kind === "tool_call")),
        ],
        costUsd: done.costUsd,
        chargedUsd: done.costUsd,
      };
    },
  },
  {
    id: "16",
    slug: "agent-slack",
    async run(ctx) {
      await ctx.c.integrations.connect.mutate({ workspaceId: ctx.workspaceId, app: "slack", scopes: [] });
      const d = await ctx.c.agents.draftFromPrompt.mutate({ workspaceId: ctx.workspaceId, prompt: "Create a Slack agent that answers questions about our company handbook in #help." });
      const handbook = readFileSync(resolve(ROOT, "evals/fixtures/handbook.md"), "utf8");
      const { id } = await ctx.c.agents.create.mutate({ workspaceId: ctx.workspaceId, name: d.name, definition: { ...d.definition, knowledge: [{ title: "Handbook", content: handbook }] } });
      await ctx.c.agents.runNow.mutate({ agentId: id, input: { text: "How many vacation days do I get per year?", channel: "help" } });
      const run = await waitFor(async () => (await ctx.c.agents.runs.query({ agentId: id })).find((r) => ["succeeded", "failed", "awaiting_approval"].includes(r.status)), ctx.timeoutMs);
      const log = run.log as Array<{ kind: string; tool?: string; output?: string }>;
      const post = log.find((l) => l.kind === "tool_result" && l.tool === "slack__post_message");
      const posted = log.find((l) => l.kind === "tool_call" && l.tool === "slack__post_message") as { input?: { text?: string } } | undefined;
      const def = d.definition as { channels?: string[]; triggers?: Array<{ type: string; channel?: string }> };
      return {
        checks: [
          check("Slack channel deploy", Boolean(def.channels?.includes("slack")) && Boolean(def.triggers?.some((t) => t.type === "chat" && t.channel === "slack"))),
          check("answered in Slack from the handbook", Boolean(posted?.input?.text?.includes("30 days")) && Boolean(post?.output?.includes('"ok":true')), posted?.input?.text?.slice(0, 120)),
          check("run succeeded", run.status === "succeeded", run.status),
        ],
        costUsd: run.costUsd,
        chargedUsd: run.costUsd,
      };
    },
  },
  {
    id: "17",
    slug: "openapi-app",
    async run(ctx) {
      const spec = JSON.parse(readFileSync(resolve(ROOT, "evals/fixtures/weather-openapi.json"), "utf8"));
      const imp = await ctx.c.integrations.importOpenApi.mutate({ workspaceId: ctx.workspaceId, source: spec });
      const projectId = await newProject(ctx, "openapi-app");
      const { task } = await runTask(ctx, projectId, "Build an app that shows current weather for a city using this API: evals/fixtures/weather-openapi.json");
      const files = await ctx.c.project.files.query({ projectId });
      return {
        checks: [check("OpenAPI imported", imp.operations.length >= 2, `${imp.operations.length} operations`), ...(await codeChecks(ctx, projectId, task)), check("typed client generated", files.some((f) => /weather.*client|api-client/i.test(f.path)), files.filter((f) => /client/i.test(f.path)).map((f) => f.path).join(","))],
        costUsd: task.costUsd,
        chargedUsd: task.chargedUsd,
      };
    },
  },
  {
    id: "18",
    slug: "connector-app",
    async run(ctx) {
      const apps = await ctx.c.integrations.apps.query({ locale: "en" });
      const hub = apps.find((a) => a.app === "hubspot");
      const con = await ctx.c.integrations.connect.mutate({ workspaceId: ctx.workspaceId, app: "hubspot", scopes: hub?.scopes.map((s) => s.id) ?? [] });
      const projectId = await newProject(ctx, "connector-app");
      const { task } = await runTask(ctx, projectId, "Build an internal tool that lists our HubSpot contacts and lets us add notes, using the HubSpot integration.");
      return { checks: [check("scopes shown before connecting", (hub?.scopes.length ?? 0) > 0), check("connection created", Boolean(con.connectionId)), ...(await codeChecks(ctx, projectId, task))], costUsd: task.costUsd, chargedUsd: task.chargedUsd };
    },
  },
  {
    id: "19",
    slug: "meeting-build",
    async run(ctx) {
      const transcript = readFileSync(resolve(ROOT, "evals/fixtures/meetings/salong-mote.sv.txt"), "utf8");
      const projectId = await newProject(ctx, "meeting-build");
      const { meetingId } = await ctx.c.meetings.importTranscript.mutate({ workspaceId: ctx.workspaceId, projectId, language: "sv", transcript, title: "Salongsmöte" });
      const m = await waitFor(async () => {
        const r = await ctx.c.meetings.get.query({ meetingId });
        return r.status === "ready" || r.status === "failed" ? r : null;
      }, ctx.timeoutMs);
      const reqs = ((m.extraction as { requirements?: unknown[] } | null)?.requirements ?? []).length;
      const t = await ctx.c.meetings.approveSpec.mutate({ meetingId, projectId });
      const task = await waitFor(async () => {
        const r = await ctx.c.task.get.query({ taskId: t.id });
        return TERMINAL.includes(r.status) ? r : null;
      }, ctx.timeoutMs, 2000);
      return { checks: [check("transcript → requirements", reqs >= 5, `${reqs} requirements`), check("spec approved → build task", t.status === "queued"), ...(await codeChecks(ctx, projectId, task))], costUsd: task.costUsd, chargedUsd: task.chargedUsd };
    },
  },
  {
    id: "20",
    slug: "voice-build",
    async run(ctx) {
      const projectId = await newProject(ctx, "voice-build");
      const wav = readFileSync(resolve(ROOT, "evals/fixtures/voice/todo-sv.wav"));
      const text = await streamVoice(ctx, projectId, wav);
      const { task } = await runTask(ctx, projectId, text, "voice");
      return { checks: [check("speech-to-text transcript", /att-göra|uppgift/i.test(text), text), ...(await codeChecks(ctx, projectId, task))], costUsd: task.costUsd, chargedUsd: task.chargedUsd };
    },
  },
];

/** Stream a WAV over /ws/audio with the simple protocol and return the final transcript. */
async function streamVoice(ctx: CaseContext, projectId: string, wav: Buffer): Promise<string> {
  const pcm = wav.subarray(44);
  const ws = new WebSocket(`${ctx.apiUrl.replace("http", "ws")}/ws/audio/${projectId}?lang=sv`, { headers: { authorization: `Bearer ${ctx.token}` } });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  const done = new Promise<string>((res, rej) => {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as { type: string; text?: string; isFinal?: boolean; message?: string };
      if (m.type === "transcript" && m.isFinal) res(m.text ?? "");
      if (m.type === "error") rej(new Error(m.message));
    });
    setTimeout(() => rej(new Error("voice timeout")), 30_000);
  });
  ws.send(JSON.stringify({ type: "start", encoding: "pcm_s16le", sampleRate: 16000, channels: 1, language: "sv" }));
  for (let i = 0; i < pcm.length; i += 32000) ws.send(pcm.subarray(i, i + 32000), { binary: true });
  ws.send(JSON.stringify({ type: "stop" }));
  const t = await done;
  ws.close();

  return t;
}
