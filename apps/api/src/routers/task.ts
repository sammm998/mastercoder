import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, desc, tasks } from "@forge/db";
import { PromptSource, QUEUES, newId, type BuildJob, type Intent } from "@forge/shared";
import { router, authedProcedure, requireProject, audit, type AuthedContext, type ProjectRow } from "../trpc.js";
import { getService, type IntentClassifier, type SpendChecker } from "../services.js";

async function enqueueBuild(ctx: AuthedContext, project: ProjectRow, taskId: string, prompt: string, source: z.infer<typeof PromptSource>, intents: Intent[], planMode: boolean, approvedSpec?: unknown) {
  const job: BuildJob = { taskId, projectId: project.id, workspaceId: project.workspaceId, userId: ctx.user.id, prompt, source, intents, planMode, approvedSpec };
  await ctx.deps.queue.add(QUEUES.build, "task", job, { jobId: `${taskId}${approvedSpec ? "-approved" : ""}` });
}

export const taskRouter = router({
  create: authedProcedure
    .input(z.object({ projectId: z.string(), prompt: z.string().min(1).max(20_000), source: PromptSource.default("typed"), planMode: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const { project } = await requireProject(ctx, input.projectId, "project.write");
      const classifier = getService<IntentClassifier>(ctx.deps.services, "intent");
      if (!classifier) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Intent router not configured" });
      const result = await classifier.classify(input.prompt, { source: input.source });
      const spend = getService<SpendChecker>(ctx.deps.services, "spend");
      if (spend) await spend.check({ userId: ctx.user.id, workspaceId: project.workspaceId }, result.estimate.highUsd);

      const id = newId("tsk");
      const status = result.needsClarification ? "awaiting_clarification" : "queued";
      await ctx.deps.db.insert(tasks).values({
        id,
        projectId: project.id,
        userId: ctx.user.id,
        prompt: input.prompt,
        source: input.source,
        intents: result.intents,
        status,
        planMode: input.planMode,
        estimateLowUsd: result.estimate.lowUsd,
        estimateHighUsd: result.estimate.highUsd,
      });
      await ctx.deps.events.publish({ type: "intent.classified", projectId: project.id, taskId: id, intents: result.intents });
      await ctx.deps.events.publish({ type: "cost.estimate", projectId: project.id, taskId: id, ...result.estimate });
      if (result.needsClarification && result.question) {
        await ctx.deps.events.publish({ type: "clarify.question", projectId: project.id, taskId: id, question: result.question, options: result.options });
      } else {
        await enqueueBuild(ctx, project, id, input.prompt, input.source, result.intents, input.planMode);
      }
      await audit(ctx, "task.create", { workspaceId: project.workspaceId, target: id });
      return { id, status, intents: result.intents, estimate: result.estimate, question: result.needsClarification ? result.question : undefined };
    }),

  answerClarification: authedProcedure.input(z.object({ taskId: z.string(), answer: z.string().min(1).max(2000) })).mutation(async ({ ctx, input }) => {
    const [task] = await ctx.deps.db.select().from(tasks).where(eq(tasks.id, input.taskId));
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
    const { project } = await requireProject(ctx, task.projectId, "project.write");
    if (task.status !== "awaiting_clarification") throw new TRPCError({ code: "BAD_REQUEST", message: "Task is not waiting for an answer" });
    const prompt = `${task.prompt}\n\nClarification: ${input.answer}`;
    await ctx.deps.db.update(tasks).set({ prompt, status: "queued" }).where(eq(tasks.id, task.id));
    await enqueueBuild(ctx, project, task.id, prompt, PromptSource.parse(task.source), (task.intents as Intent[]) ?? [], task.planMode);
    return { ok: true };
  }),

  /** Plan mode: the user approves (optionally edited) spec before building. */
  approvePlan: authedProcedure.input(z.object({ taskId: z.string(), spec: z.unknown().optional() })).mutation(async ({ ctx, input }) => {
    const [task] = await ctx.deps.db.select().from(tasks).where(eq(tasks.id, input.taskId));
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
    const { project } = await requireProject(ctx, task.projectId, "project.write");
    if (task.status !== "awaiting_approval") throw new TRPCError({ code: "BAD_REQUEST", message: "Task has no plan waiting for approval" });
    const spec = input.spec ?? task.spec;
    await ctx.deps.db.update(tasks).set({ status: "queued", spec }).where(eq(tasks.id, task.id));
    await enqueueBuild(ctx, project, task.id, task.prompt, PromptSource.parse(task.source), (task.intents as Intent[]) ?? [], false, spec);
    await audit(ctx, "task.approve_plan", { workspaceId: project.workspaceId, target: task.id });
    return { ok: true };
  }),

  cancel: authedProcedure.input(z.object({ taskId: z.string() })).mutation(async ({ ctx, input }) => {
    const [task] = await ctx.deps.db.select().from(tasks).where(eq(tasks.id, input.taskId));
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
    await requireProject(ctx, task.projectId, "project.write");
    if (["succeeded", "failed", "cancelled"].includes(task.status)) return { ok: true };
    await ctx.deps.db.update(tasks).set({ status: "cancelled", completedAt: new Date() }).where(eq(tasks.id, task.id));
    await ctx.deps.kv.set(`cancel:${task.id}`, "1", 86400);
    return { ok: true };
  }),

  list: authedProcedure.input(z.object({ projectId: z.string() })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    return ctx.deps.db.select().from(tasks).where(eq(tasks.projectId, input.projectId)).orderBy(desc(tasks.createdAt));
  }),

  get: authedProcedure.input(z.object({ taskId: z.string() })).query(async ({ ctx, input }) => {
    const [task] = await ctx.deps.db.select().from(tasks).where(and(eq(tasks.id, input.taskId)));
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
    await requireProject(ctx, task.projectId, "project.read");
    return task;
  }),
});
