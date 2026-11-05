import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, users, memberships, workspaces, projects, tasks, comments, auditLog, authSessions, meetings, connections, usageRecords, retentionPolicies } from "@forge/db";
import { router, authedProcedure, requireWorkspace, audit } from "../trpc.js";

export const gdprRouter = router({
  /** Article 15/20: machine-readable export of everything we hold about the user. */
  exportMyData: authedProcedure.mutation(async ({ ctx }) => {
    const db = ctx.deps.db;
    const [user] = await db.select().from(users).where(eq(users.id, ctx.user.id));
    const ms = await db.select().from(memberships).where(eq(memberships.userId, ctx.user.id));
    const wsIds = ms.map((m) => m.workspaceId);
    const ownedWs = ms.filter((m) => m.role === "owner").map((m) => m.workspaceId);
    const data = {
      exportedAt: new Date().toISOString(),
      user: user ? { ...user, passwordHash: undefined } : null,
      memberships: ms,
      workspaces: wsIds.length ? await db.select().from(workspaces).where(inArray(workspaces.id, wsIds)) : [],
      projects: ownedWs.length ? await db.select().from(projects).where(inArray(projects.workspaceId, ownedWs)) : [],
      tasks: await db.select().from(tasks).where(eq(tasks.userId, ctx.user.id)),
      comments: await db.select().from(comments).where(eq(comments.userId, ctx.user.id)),
      meetings: ownedWs.length ? await db.select().from(meetings).where(inArray(meetings.workspaceId, ownedWs)) : [],
      connections: (await db.select().from(connections).where(eq(connections.userId, ctx.user.id))).map((c) => ({ ...c, config: undefined })),
      usage: ownedWs.length ? await db.select().from(usageRecords).where(inArray(usageRecords.workspaceId, ownedWs)) : [],
      auditLog: await db.select().from(auditLog).where(eq(auditLog.actorId, ctx.user.id)),
    };
    const key = `exports/${ctx.user.id}/${Date.now()}.json`;
    await ctx.deps.store.put(key, JSON.stringify(data, null, 2), { contentType: "application/json" });
    await audit(ctx, "gdpr.export", { target: ctx.user.id });
    return { url: await ctx.deps.store.url(key, 3600), key };
  }),

  /**
   * Article 17: delete the account. Workspaces where the user is the sole owner are deleted with all
   * their data (cascades); otherwise the membership is removed. The user row is anonymised and kept only
   * as a tombstone so audit-log foreign references remain meaningful.
   */
  deleteMyAccount: authedProcedure.input(z.object({ confirmEmail: z.string().email() })).mutation(async ({ ctx, input }) => {
    if (input.confirmEmail.toLowerCase() !== ctx.user.email.toLowerCase()) throw new TRPCError({ code: "BAD_REQUEST", message: "Email confirmation does not match" });
    const db = ctx.deps.db;
    const ms = await db.select().from(memberships).where(eq(memberships.userId, ctx.user.id));
    const deletedWorkspaces: string[] = [];
    for (const m of ms) {
      const owners = await db.select().from(memberships).where(and(eq(memberships.workspaceId, m.workspaceId), eq(memberships.role, "owner")));
      if (m.role === "owner" && owners.length === 1) {
        // Remove stored objects (recordings, media) before the rows disappear.
        const objs = await ctx.deps.store.list(`workspaces/${m.workspaceId}/`);
        for (const k of objs) await ctx.deps.store.delete(k);
        await db.delete(workspaces).where(eq(workspaces.id, m.workspaceId));
        deletedWorkspaces.push(m.workspaceId);
      } else {
        await db.delete(memberships).where(and(eq(memberships.workspaceId, m.workspaceId), eq(memberships.userId, ctx.user.id)));
      }
    }
    await db.delete(comments).where(eq(comments.userId, ctx.user.id));
    await db.delete(authSessions).where(eq(authSessions.userId, ctx.user.id));
    await db.update(connections).set({ status: "revoked", revokedAt: new Date(), config: null }).where(eq(connections.userId, ctx.user.id));
    await db
      .update(users)
      .set({ email: `deleted+${ctx.user.id}@forge.invalid`, name: "", passwordHash: null, deletedAt: new Date() })
      .where(eq(users.id, ctx.user.id));
    await audit(ctx, "gdpr.delete_account", { target: ctx.user.id, meta: { deletedWorkspaces } });
    ctx.clearCookie("forge_session");
    return { deletedWorkspaces };
  }),

  retention: authedProcedure.input(z.object({ workspaceId: z.string() })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "project.read");
    const [p] = await ctx.deps.db.select().from(retentionPolicies).where(eq(retentionPolicies.workspaceId, input.workspaceId));
    return p ?? { workspaceId: input.workspaceId, recordingDays: 30, transcriptDays: 365, eventDays: 180 };
  }),

  setRetention: authedProcedure
    .input(z.object({ workspaceId: z.string(), recordingDays: z.number().int().min(1).max(3650), transcriptDays: z.number().int().min(1).max(3650), eventDays: z.number().int().min(1).max(3650) }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "members.manage");
      await ctx.deps.db
        .insert(retentionPolicies)
        .values(input)
        .onConflictDoUpdate({ target: retentionPolicies.workspaceId, set: { recordingDays: input.recordingDays, transcriptDays: input.transcriptDays, eventDays: input.eventDays } });
      await audit(ctx, "gdpr.retention_policy", { workspaceId: input.workspaceId, meta: input });
      return { ok: true };
    }),
});
