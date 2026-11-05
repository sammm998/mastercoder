import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, sql, desc, usageRecords, workspaces, tasks, projects } from "@forge/db";
import { router, authedProcedure, publicProcedure, requireWorkspace, audit } from "../trpc.js";
import { requireService, type BillingPort } from "../services.js";

function periodStart(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export const billingRouter = router({
  plans: publicProcedure.query(({ ctx }) => requireService<BillingPort>(ctx.deps.services, "billing").plans()),

  summary: authedProcedure.input(z.object({ workspaceId: z.string() })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "project.read");
    const [ws] = await ctx.deps.db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId));
    if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
    const since = periodStart();
    const byKind = await ctx.deps.db
      .select({ kind: usageRecords.kind, quantity: sql<number>`sum(${usageRecords.quantity})`.mapWith(Number), costUsd: sql<number>`sum(${usageRecords.costUsd})`.mapWith(Number) })
      .from(usageRecords)
      .where(and(eq(usageRecords.workspaceId, input.workspaceId), gte(usageRecords.at, since)))
      .groupBy(usageRecords.kind);
    const charged = await ctx.deps.db
      .select({ total: sql<number>`coalesce(sum(${tasks.chargedUsd}), 0)`.mapWith(Number), notCharged: sql<number>`count(*) filter (where ${tasks.status} = 'failed' and ${tasks.charged} = false)`.mapWith(Number) })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(projects.workspaceId, input.workspaceId), gte(tasks.createdAt, since)));
    const billing = ctx.deps.services.billing as BillingPort | undefined;
    return {
      plan: ws.plan,
      spendCapUsd: ws.spendCapUsd,
      periodStart: since.toISOString(),
      usage: byKind,
      priceUsd: billing ? billing.priceUsage(byKind) : null,
      chargedUsd: charged[0]?.total ?? 0,
      failedTasksNotCharged: charged[0]?.notCharged ?? 0,
    };
  }),

  taskCosts: authedProcedure.input(z.object({ workspaceId: z.string(), limit: z.number().int().min(1).max(200).default(50) })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "project.read");
    return ctx.deps.db
      .select({ id: tasks.id, prompt: tasks.prompt, status: tasks.status, estimateLowUsd: tasks.estimateLowUsd, estimateHighUsd: tasks.estimateHighUsd, chargedUsd: tasks.chargedUsd, charged: tasks.charged, createdAt: tasks.createdAt, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(projects.workspaceId, input.workspaceId))
      .orderBy(desc(tasks.createdAt))
      .limit(input.limit);
  }),

  checkout: authedProcedure.input(z.object({ workspaceId: z.string(), plan: z.enum(["pro", "team", "enterprise"]) })).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "billing.manage");
    const [ws] = await ctx.deps.db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId));
    if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
    const r = await requireService<BillingPort>(ctx.deps.services, "billing").checkoutUrl({
      workspaceId: ws.id,
      plan: input.plan,
      customerId: ws.stripeCustomerId,
      email: ctx.user.email,
      successUrl: `${ctx.deps.config.appUrl}/app/billing?checkout=success`,
      cancelUrl: `${ctx.deps.config.appUrl}/app/billing?checkout=cancelled`,
    });
    if (!ws.stripeCustomerId) await ctx.deps.db.update(workspaces).set({ stripeCustomerId: r.customerId }).where(eq(workspaces.id, ws.id));
    await audit(ctx, "billing.checkout", { workspaceId: ws.id, meta: { plan: input.plan } });
    return { url: r.url };
  }),

  portal: authedProcedure.input(z.object({ workspaceId: z.string() })).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "billing.manage");
    const [ws] = await ctx.deps.db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId));
    if (!ws?.stripeCustomerId) throw new TRPCError({ code: "BAD_REQUEST", message: "No billing account yet" });
    return requireService<BillingPort>(ctx.deps.services, "billing").portalUrl({ customerId: ws.stripeCustomerId, returnUrl: `${ctx.deps.config.appUrl}/app/billing` });
  }),
});
