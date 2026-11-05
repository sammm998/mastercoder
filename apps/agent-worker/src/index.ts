import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { connect, runMigrations, userAgents } from "@forge/db";
import { createLLM, MeteredLLM } from "@forge/llm";
import { QUEUES, createLogger, createObjectStore, MediaJobSchema, SlidesJobSchema, TranscriptionJobSchema, MeetingBotJobSchema, AgentRunJobSchema, ScanJobSchema } from "@forge/shared";
import { initTracing, createErrorReporter, monitorTick, createAlertSink, httpCheck, withSpan } from "@forge/observability";
import { createMediaProvider } from "@forge/media";
import { createSttProvider } from "@forge/speech";
import { createMeetingBotProvider } from "@forge/meetings";
import { AgentService, DrizzleMemoryStore, createAgentRunner } from "@forge/agents-runtime";
import { createConnectorProvider, Vault, DrizzleSecretStore, createKeyProvider } from "@forge/integrations";
import { scanDeployment, createUrlReputation } from "@forge/abuse";
import { DbUsageSink, WorkerEventSink } from "./runtime.js";
import { runMediaRequest } from "./jobs/media.js";
import { runSlidesRequest } from "./jobs/slides.js";
import { runTranscription, runMeetingBot } from "./jobs/meetings.js";
import { syncAgentSchedules } from "./scheduler.js";
import { ConnectionToolExecutor } from "./agent-tools.js";
import { registerBuildQueue } from "./build-queue.js";

const log = createLogger({ service: "agent-worker" });
const tracing = initTracing("agent-worker");
const errors = await createErrorReporter("agent-worker");
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const pub = new Redis(redisUrl, { maxRetriesPerRequest: null });

await runMigrations();
const { db } = connect(undefined, Number(process.env.WORKER_DB_POOL || 20));
const store = await createObjectStore();
const events = new WorkerEventSink(db, pub);
const usage = new DbUsageSink(db);
const llm = createLLM();
const media = createMediaProvider();
const stt = createSttProvider();
const bots = createMeetingBotProvider();
const connectors = createConnectorProvider();
const vault = new Vault(new DrizzleSecretStore(db), createKeyProvider());
const agents = new AgentService({
  db,
  runner: createAgentRunner(new MeteredLLM(llm, usage)),
  tools: new ConnectionToolExecutor(db, connectors, vault),
  memory: new DrizzleMemoryStore(db),
  usage,
  onFailure: (a) => log.warn("agent run failed", a),
});

type Handler = (job: Job) => Promise<unknown>;
const workers: Worker[] = [];
function consume(queue: string, handler: Handler, concurrency = Number(process.env.WORKER_CONCURRENCY || 4)) {
  const w = new Worker(queue, (job) => withSpan(`job.${queue}`, { "forge.job_id": String(job.id), "forge.job_name": job.name }, () => handler(job)), { connection, concurrency });
  w.on("failed", (job, err) => {
    log.error("job failed", { queue, job: job?.id, name: job?.name, error: err.message });
    errors.capture(err, { tags: { queue, job: String(job?.id) } });
  });
  workers.push(w);
}

consume(QUEUES.media, async (job) => {
  const p = MediaJobSchema.parse(job.data);
  const out = await runMediaRequest({ ...p, options: p.options }, { db, provider: media, store, usage: usage.withDefaults({ workspaceId: p.workspaceId, projectId: p.projectId, taskId: p.taskId }), events, renderRemotion: async (o) => (await import("@forge/media/remotion")).renderRemotionVideo(o) });
  await usage.flush();
  await events.flush();
  return { artifacts: out.map((a) => a.id) };
}, 2);

consume(QUEUES.slides, async (job) => {
  const p = SlidesJobSchema.parse(job.data);
  const r = await runSlidesRequest(p, { db, llm: new MeteredLLM(llm, usage, { workspaceId: p.workspaceId, projectId: p.projectId, taskId: p.taskId }), store, usage, events });
  await events.flush();
  return r;
}, 2);

const meetingDeps = { db, llm: new MeteredLLM(llm, usage), stt, bots, store, usage, events, webhookUrl: process.env.API_URL ? `${process.env.API_URL}/hooks/meetings/${bots.name}` : undefined };
consume(QUEUES.transcription, async (job) => {
  const p = TranscriptionJobSchema.parse(job.data);
  const r = await runTranscription(p, meetingDeps);
  await events.flush();
  return { requirements: r.extraction.requirements.length };
}, 2);
const botQueue = new Queue(QUEUES.meetingBot, { connection });
consume(QUEUES.meetingBot, async (job) => {
  const p = MeetingBotJobSchema.parse(job.data);
  const r = await runMeetingBot(p, meetingDeps);
  // Keep polling bots that are still in the meeting.
  if (p.action !== "leave" && !["ready", "left", "error"].includes(r.status)) await botQueue.add("poll", { ...p, action: "poll" }, { delay: 30_000 });
  return r;
});

const agentQueue = new Queue(QUEUES.agentRun, { connection });
consume(QUEUES.agentRun, async (job) => {
  const p = AgentRunJobSchema.parse(job.data);
  if (job.name === "resume" && p.resumeRunId) return agents.resume(p.resumeRunId);
  if (job.name === "evals") return agents.runEvals(p.agentId);
  return agents.trigger(p.agentId, p.trigger, p.input ?? null);
});

const reputation = createUrlReputation();
consume(QUEUES.scan, async (job) => {
  const p = ScanJobSchema.parse(job.data);
  const html = await fetch(p.url, { signal: AbortSignal.timeout(15_000) }).then((r) => r.text()).catch(() => "");
  return scanDeployment(db, reputation, { projectId: p.projectId, deploymentId: p.deploymentId, files: { "index.html": html }, hostname: new URL(p.url).hostname });
});

await registerBuildQueue({ consume, db, llm, store, events, usage, log });

// Cron triggers → BullMQ job schedulers, re-synced every minute.
const sync = async () => {
  try {
    await syncAgentSchedules(db, agentQueue);
  } catch (e) {
    log.warn("schedule sync failed", { error: (e as Error).message });
  }
};
await sync();
const syncTimer = setInterval(sync, 60_000);

// Provider health + cost alerts every 5 minutes.
const alerts = createAlertSink();
const checks = [httpCheck("anthropic", "llm", "https://status.anthropic.com/api/v2/status.json"), { provider: "postgres", kind: "db" as const, check: async () => void (await db.select().from(userAgents).limit(1)) }, { provider: "redis", kind: "queue" as const, check: async () => void (await connection.ping()) }];
const monitorTimer = setInterval(() => void monitorTick(db, checks, alerts).catch((e) => log.warn("monitor failed", { error: (e as Error).message })), 300_000);

log.info("worker started", { queues: workers.map((w) => w.name), llm: llm.name, mockLLM: llm.isMock, media: media.name, stt: stt.name, bots: bots.name });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    clearInterval(syncTimer);
    clearInterval(monitorTimer);
    await Promise.all(workers.map((w) => w.close()));
    await tracing.shutdown();
    process.exit(0);
  });
}


