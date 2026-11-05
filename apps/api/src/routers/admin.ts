import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, desc, gte, sql, users, projects, workspaces, usageRecords, abuseReports, deployments, providerHealth, tasks, agentRuns } from "@forge/db";
import { router, adminProcedure, audit } from "../trpc.js";

const since = (days: number) => new Date(Date.now() - days * 86400_000);

/** Internal admin (apps/admin). Every procedure requires users.is_admin. */
export const adminRouter = router({
  stats: adminProcedure.query(async ({ ctx }) => {
    const db = ctx.deps.db;
    const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
    const n = sql<number>`count(*)`.mapWith(Number);
    return {
      users: await count(db.select({ n }).from(users)),
      workspaces: await count(db.select({ n }).from(workspaces)),
      projects: await count(db.select({ n }).from(projects)),
      tasks24h: await count(db.select({ n }).from(tasks).where(gte(tasks.createdAt, since(1)))),
      failedTasks24h: await count(db.select({ n }).from(tasks).where(and(gte(tasks.createdAt, since(1)), eq(tasks.status, "failed")))),
      agentRuns24h: await count(db.select({ n }).from(agentRuns).where(gte(agentRuns.startedAt, since(1)))),
      openAbuse: await count(db.select({ n }).from(abuseReports).where(eq(abuseReports.status, "open"))),
    };
  }),

  users: adminProcedure.input(z.object({ q: z.string().max(200).default(""), limit: z.number().int().min(1).max(200).default(50) })).query(async ({ ctx, input }) => {
    const where = input.q ? sql`${users.email} ilike ${"%" + input.q + "%"}` : undefined;
    return ctx.deps.db
      .select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin, createdAt: users.createdAt, deletedAt: users.deletedAt })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(input.limit);
  }),

  projects: adminProcedure.input(z.object({ limit: z.number().int().min(1).max(200).default(50) })).query(async ({ ctx, input }) => {
    return ctx.deps.db
      .select({ id: projects.id, name: projects.name, workspace: workspaces.name, isPublic: projects.isPublic, createdAt: projects.createdAt })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .orderBy(desc(projects.createdAt))
      .limit(input.limit);
  }),

  /** Provider cost per day for the cost dashboard and spike alerts. */
  costs: adminProcedure.input(z.object({ days: z.number().int().min(1).max(90).default(14) })).query(async ({ ctx, input }) => {
    const day = sql<string>`to_char(date_trunc('day', ${usageRecords.at}), 'YYYY-MM-DD')`;
    return ctx.deps.db
      .select({ day, provider: usageRecords.provider, costUsd: sql<number>`sum(${usageRecords.costUsd})`.mapWith(Number), quantity: sql<number>`sum(${usageRecords.quantity})`.mapWith(Number) })
      .from(usageRecords)
      .where(gte(usageRecords.at, since(input.days)))
      .groupBy(day, usageRecords.provider)
      .orderBy(day);
  }),

  providerHealth: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.deps.db.select().from(providerHealth).where(gte(providerHealth.checkedAt, since(1))).orderBy(desc(providerHealth.checkedAt));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.provider)) latest.set(r.provider, r);
    return [...latest.values()].map((r) => ({ ...r, failures24h: rows.filter((x) => x.provider === r.provider && !x.ok).length, checks24h: rows.filter((x) => x.provider === r.provider).length }));
  }),

  abuseQueue: adminProcedure.input(z.object({ status: z.enum(["open", "dismissed", "taken_down"]).default("open") })).query(async ({ ctx, input }) => {
    return ctx.deps.db.select().from(abuseReports).where(eq(abuseReports.status, input.status)).orderBy(desc(abuseReports.createdAt));
  }),

  /** Takedown: marks the report, takes every live deployment of the project offline (worker removes it). */
  resolveAbuse: adminProcedure.input(z.object({ reportId: z.string(), action: z.enum(["dismiss", "takedown"]) })).mutation(async ({ ctx, input }) => {
    const [r] = await ctx.deps.db.select().from(abuseReports).where(eq(abuseReports.id, input.reportId));
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
    await ctx.deps.db.update(abuseReports).set({ status: input.action === "takedown" ? "taken_down" : "dismissed", resolvedAt: new Date() }).where(eq(abuseReports.id, r.id));
    if (input.action === "takedown" && r.projectId) {
      await ctx.deps.db.update(deployments).set({ status: "taken_down" }).where(and(eq(deployments.projectId, r.projectId), eq(deployments.status, "live")));
      await ctx.deps.db.update(projects).set({ isPublic: false }).where(eq(projects.id, r.projectId));
      await ctx.deps.queue.add("forge-deploy", "takedown", { projectId: r.projectId, reportId: r.id });
    }
    await audit(ctx, `abuse.${input.action}`, { target: r.id, meta: { projectId: r.projectId } });
    return { ok: true };
  }),
});
