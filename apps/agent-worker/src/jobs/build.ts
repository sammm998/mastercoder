import { MeteredLLM, type LLMProvider } from "@forge/llm";
import { BuildAgent, type AgentDeps, type BuildOutcome, type SandboxPort } from "@forge/agent-core";
import { BuildJobSchema, type BuildJob, type IntentKind } from "@forge/shared";
import { withSpan, spanEventRecorder } from "@forge/observability";
import { eq, projects, type Db } from "@forge/db";
import { DbUsageSink, WorkerEventSink, markTaskRunning, settleTask, type Settler, type TaskOutcome } from "../runtime.js";

/** Non-code deliverables handled by dedicated pipelines (media, slides, agent builder, Q&A). */
export interface SidePipelines {
  media?(job: BuildJob, kind: "image" | "video", deps: { llm: LLMProvider; events: WorkerEventSink; usage: DbUsageSink }): Promise<void>;
  slides?(job: BuildJob, kind: "slides" | "document", deps: { llm: LLMProvider; events: WorkerEventSink; usage: DbUsageSink }): Promise<void>;
  agent?(job: BuildJob, deps: { llm: LLMProvider; events: WorkerEventSink; usage: DbUsageSink }): Promise<void>;
  question?(job: BuildJob, deps: { llm: LLMProvider; events: WorkerEventSink }): Promise<void>;
}

export interface BuildJobDeps {
  db: Db;
  llm: LLMProvider;
  events: WorkerEventSink;
  usage: DbUsageSink;
  settle: Settler;
  /** Provision (or reuse) the project's sandbox. */
  sandboxFor(projectId: string, workspaceId: string): Promise<SandboxPort>;
  /** Everything else the build agent needs (templates, gates, design, checkpoints, media...). */
  agentPorts(job: BuildJob, sandbox: SandboxPort): Promise<Omit<AgentDeps, "llm" | "events" | "usage" | "sandbox">>;
  pipelines: SidePipelines;
  isCancelled(taskId: string): Promise<boolean>;
}

const CODE: IntentKind[] = ["app", "website", "mobile", "backend"];

export async function runBuildJob(raw: unknown, d: BuildJobDeps): Promise<{ outcome: TaskOutcome; build?: BuildOutcome; chargedUsd: number }> {
  const job = BuildJobSchema.parse(raw);
  const base = { projectId: job.projectId, taskId: job.taskId };
  return withSpan("agent.task", { "forge.task_id": job.taskId, "forge.project_id": job.projectId, "forge.intents": job.intents.map((i) => i.kind).join(",") }, async (span) => {
    const off = d.events.onEvent(spanEventRecorder(span) as (e: unknown) => void);
    const usage = d.usage.withDefaults({ workspaceId: job.workspaceId, projectId: job.projectId, taskId: job.taskId });
    const llm = new MeteredLLM(d.llm, usage, { workspaceId: job.workspaceId, projectId: job.projectId, taskId: job.taskId });
    await markTaskRunning(d.db, job.taskId);
    let outcome: TaskOutcome = "succeeded";
    let reason: string | undefined;
    let build: BuildOutcome | undefined;
    try {
      const kinds = new Set(job.intents.map((i) => i.kind));
      if ([...kinds].some((k) => CODE.includes(k)) || kinds.size === 0 || (kinds.size === 1 && kinds.has("integration"))) {
        const sandbox = await d.sandboxFor(job.projectId, job.workspaceId);
        const ports = await d.agentPorts(job, sandbox);
        const [project] = await d.db.select().from(projects).where(eq(projects.id, job.projectId));
        build = await new BuildAgent({ ...ports, llm, events: d.events, usage, sandbox, isCancelled: () => d.isCancelled(job.taskId) }).run({
          taskId: job.taskId,
          projectId: job.projectId,
          workspaceId: job.workspaceId,
          prompt: job.prompt,
          intents: job.intents,
          planMode: job.planMode,
          approvedSpec: job.approvedSpec,
          brand: project?.brand ?? undefined,
          existingProject: Boolean(project?.template),
        });
        if (build.status === "succeeded" && build.template && !project?.template) await d.db.update(projects).set({ template: build.template }).where(eq(projects.id, job.projectId));
        outcome = build.status === "succeeded" ? "succeeded" : build.status === "awaiting_approval" ? "awaiting_approval" : build.status === "cancelled" ? "cancelled_by_user" : "failed_agent_error";
        reason = build.reason;
      }
      if (outcome === "succeeded") {
        const pd = { llm, events: d.events, usage };
        if (kinds.has("image") && d.pipelines.media) await d.pipelines.media(job, "image", pd);
        if (kinds.has("video") && d.pipelines.media) await d.pipelines.media(job, "video", pd);
        if (kinds.has("slides") && d.pipelines.slides) await d.pipelines.slides(job, "slides", pd);
        if (kinds.has("document") && d.pipelines.slides) await d.pipelines.slides(job, "document", pd);
        if (kinds.has("agent") && d.pipelines.agent) await d.pipelines.agent(job, pd);
        if (kinds.has("question") && kinds.size === 1 && d.pipelines.question) await d.pipelines.question(job, pd);
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      outcome = err.code === "PROVIDER_ERROR" ? "failed_provider" : err.code === "MODERATION_BLOCKED" ? "failed_agent_error" : "failed_provider";
      reason = err.message;
      d.events.emit({ type: "task.failed", ...base, reason: err.message, charged: false, blockedOn: err.code });
    }
    await usage.flush();
    const costUsd = llm.totalCostUsd;
    const s = await settleTask(d.db, d.settle, { taskId: job.taskId, outcome, costUsd, reason, spec: build?.spec });
    if (outcome === "succeeded") d.events.emit({ type: "task.completed", ...base, summary: build?.summary ?? "Done", chargedUsd: s.chargedUsd });
    await d.events.flush();
    off();
    span.setAttribute("forge.outcome", outcome);
    span.setAttribute("forge.charged_usd", s.chargedUsd);
    return { outcome, build, chargedUsd: s.chargedUsd };
  });
}
