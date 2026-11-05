import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, desc, userAgents, userAgentVersions, agentRuns, approvals } from "@forge/db";
import { QUEUES, newId } from "@forge/shared";
import { router, authedProcedure, requireWorkspace, audit, type AuthedContext } from "../trpc.js";
import { requireService, type AgentDefiner } from "../services.js";
import { newToken } from "../auth/password.js";

async function loadAgent(ctx: AuthedContext, agentId: string, perm: "project.read" | "agents.manage") {
  const [a] = await ctx.deps.db.select().from(userAgents).where(eq(userAgents.id, agentId));
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
  await requireWorkspace(ctx, a.workspaceId, perm);
  return a;
}

/** Cron expressions in definitions are scheduled by agent-worker's scheduler; manual runs go to the queue. */
export const agentsRouter = router({
  list: authedProcedure.input(z.object({ workspaceId: z.string() })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "project.read");
    return ctx.deps.db.select().from(userAgents).where(eq(userAgents.workspaceId, input.workspaceId)).orderBy(desc(userAgents.createdAt));
  }),

  get: authedProcedure.input(z.object({ agentId: z.string() })).query(async ({ ctx, input }) => {
    const a = await loadAgent(ctx, input.agentId, "project.read");
    const versions = await ctx.deps.db.select({ version: userAgentVersions.version, createdAt: userAgentVersions.createdAt }).from(userAgentVersions).where(eq(userAgentVersions.agentId, a.id)).orderBy(desc(userAgentVersions.version));
    return {
      ...a,
      webhookSecret: undefined,
      versions,
      channels: {
        webhookUrl: `${ctx.deps.config.apiUrl}/hooks/agents/${a.id}`,
        restUrl: `${ctx.deps.config.apiUrl}/v1/agents/${a.id}/messages`,
        inboundEmail: `agent+${a.id}@${process.env.INBOUND_EMAIL_DOMAIN || "in.forge.local"}`,
        widgetSnippet: `<script src="${ctx.deps.config.apiUrl}/widget.js" data-agent="${a.id}" async></script>`,
      },
    };
  }),

  /** Prompt → definition (not saved until `create`), so the user can review tools, scopes and approvals first. */
  draftFromPrompt: authedProcedure.input(z.object({ workspaceId: z.string(), prompt: z.string().min(5).max(8000) })).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "agents.manage");
    return requireService<AgentDefiner>(ctx.deps.services, "agents").generate(input.prompt, { workspaceId: input.workspaceId });
  }),

  create: authedProcedure
    .input(z.object({ workspaceId: z.string(), projectId: z.string().optional(), name: z.string().min(1).max(100), definition: z.record(z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "agents.manage");
      const v = requireService<AgentDefiner>(ctx.deps.services, "agents").validate(input.definition);
      if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.error });
      const id = newId("agt");
      await ctx.deps.db.transaction(async (tx) => {
        await tx.insert(userAgents).values({ id, workspaceId: input.workspaceId, projectId: input.projectId, name: input.name, definition: v.definition, webhookSecret: newToken(24) });
        await tx.insert(userAgentVersions).values({ agentId: id, version: 1, definition: v.definition });
      });
      await audit(ctx, "agent.create", { workspaceId: input.workspaceId, target: id });
      return { id };
    }),

  update: authedProcedure.input(z.object({ agentId: z.string(), definition: z.record(z.unknown()) })).mutation(async ({ ctx, input }) => {
    const a = await loadAgent(ctx, input.agentId, "agents.manage");
    const v = requireService<AgentDefiner>(ctx.deps.services, "agents").validate(input.definition);
    if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.error });
    const version = a.version + 1;
    await ctx.deps.db.transaction(async (tx) => {
      await tx.insert(userAgentVersions).values({ agentId: a.id, version, definition: v.definition });
      await tx.update(userAgents).set({ version, definition: v.definition }).where(eq(userAgents.id, a.id));
    });
    await audit(ctx, "agent.update", { workspaceId: a.workspaceId, target: a.id, meta: { version } });
    return { version };
  }),

  rollback: authedProcedure.input(z.object({ agentId: z.string(), version: z.number().int().min(1) })).mutation(async ({ ctx, input }) => {
    const a = await loadAgent(ctx, input.agentId, "agents.manage");
    const [old] = await ctx.deps.db.select().from(userAgentVersions).where(and(eq(userAgentVersions.agentId, a.id), eq(userAgentVersions.version, input.version)));
    if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "Version not found" });
    const version = a.version + 1;
    await ctx.deps.db.insert(userAgentVersions).values({ agentId: a.id, version, definition: old.definition });
    await ctx.deps.db.update(userAgents).set({ version, definition: old.definition }).where(eq(userAgents.id, a.id));
    return { version };
  }),

  setStatus: authedProcedure.input(z.object({ agentId: z.string(), status: z.enum(["active", "paused"]) })).mutation(async ({ ctx, input }) => {
    const a = await loadAgent(ctx, input.agentId, "agents.manage");
    await ctx.deps.db.update(userAgents).set({ status: input.status }).where(eq(userAgents.id, a.id));
    await audit(ctx, input.status === "paused" ? "agent.pause" : "agent.resume", { workspaceId: a.workspaceId, target: a.id });
    return { ok: true };
  }),

  runNow: authedProcedure.input(z.object({ agentId: z.string(), input: z.unknown().optional(), test: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
    const a = await loadAgent(ctx, input.agentId, "agents.manage");
    if (a.status === "paused" && !input.test) throw new TRPCError({ code: "BAD_REQUEST", message: "Agent is paused" });
    const job = await ctx.deps.queue.add(QUEUES.agentRun, "run", { agentId: a.id, workspaceId: a.workspaceId, trigger: input.test ? "test" : "manual", input: input.input });
    return { jobId: job.id };
  }),

  runEvals: authedProcedure.input(z.object({ agentId: z.string() })).mutation(async ({ ctx, input }) => {
    const a = await loadAgent(ctx, input.agentId, "agents.manage");
    const job = await ctx.deps.queue.add(QUEUES.agentRun, "evals", { agentId: a.id, workspaceId: a.workspaceId, trigger: "test" });
    return { jobId: job.id };
  }),

  runs: authedProcedure.input(z.object({ agentId: z.string(), limit: z.number().int().min(1).max(200).default(50) })).query(async ({ ctx, input }) => {
    const a = await loadAgent(ctx, input.agentId, "project.read");
    return ctx.deps.db.select().from(agentRuns).where(eq(agentRuns.agentId, a.id)).orderBy(desc(agentRuns.startedAt)).limit(input.limit);
  }),

  approvals: authedProcedure.input(z.object({ workspaceId: z.string(), status: z.enum(["pending", "approved", "rejected"]).default("pending") })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "project.read");
    return ctx.deps.db.select().from(approvals).where(and(eq(approvals.workspaceId, input.workspaceId), eq(approvals.status, input.status))).orderBy(desc(approvals.createdAt));
  }),

  /** Human approval for irreversible actions (send, pay, delete). Approving resumes the paused run. */
  decide: authedProcedure.input(z.object({ approvalId: z.string(), approve: z.boolean() })).mutation(async ({ ctx, input }) => {
    const [ap] = await ctx.deps.db.select().from(approvals).where(eq(approvals.id, input.approvalId));
    if (!ap) throw new TRPCError({ code: "NOT_FOUND", message: "Approval not found" });
    await requireWorkspace(ctx, ap.workspaceId, "agents.manage");
    if (ap.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "Already decided" });
    await ctx.deps.db.update(approvals).set({ status: input.approve ? "approved" : "rejected", decidedBy: ctx.user.id, decidedAt: new Date() }).where(eq(approvals.id, ap.id));
    if (ap.agentRunId) {
      const [run] = await ctx.deps.db.select().from(agentRuns).where(eq(agentRuns.id, ap.agentRunId));
      if (run) await ctx.deps.queue.add(QUEUES.agentRun, "resume", { agentId: run.agentId, workspaceId: ap.workspaceId, trigger: "manual", resumeRunId: run.id });
    }
    await audit(ctx, input.approve ? "approval.approve" : "approval.reject", { workspaceId: ap.workspaceId, target: ap.id, meta: { action: ap.action } });
    return { ok: true };
  }),
});
