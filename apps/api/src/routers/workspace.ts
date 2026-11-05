import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, isNull, desc, memberships, workspaces, users, invites, auditLog } from "@forge/db";
import { newId } from "@forge/shared";
import { router, authedProcedure, requireWorkspace, audit } from "../trpc.js";
import { ROLES, canAssign, type Role } from "../lib/rbac.js";
import { newToken, sha256 } from "../auth/password.js";

const RoleSchema = z.enum(ROLES);

export const workspaceRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    return ctx.deps.db
      .select({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan, role: memberships.role, region: workspaces.region })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, ctx.user.id));
  }),

  create: authedProcedure.input(z.object({ name: z.string().min(1).max(80) })).mutation(async ({ ctx, input }) => {
    const id = newId("ws");
    await ctx.deps.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({ id, name: input.name });
      await tx.insert(memberships).values({ workspaceId: id, userId: ctx.user.id, role: "owner" });
    });
    await audit(ctx, "workspace.create", { workspaceId: id, target: id });
    return { id };
  }),

  members: authedProcedure.input(z.object({ workspaceId: z.string() })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "project.read");
    return ctx.deps.db
      .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, input.workspaceId));
  }),

  invite: authedProcedure
    .input(z.object({ workspaceId: z.string(), email: z.string().email(), role: RoleSchema }))
    .mutation(async ({ ctx, input }) => {
      const actor = await requireWorkspace(ctx, input.workspaceId, "members.manage");
      if (!canAssign(actor, input.role)) throw new TRPCError({ code: "FORBIDDEN", message: `A ${actor} cannot invite a ${input.role}` });
      const token = newToken();
      const id = newId("inv");
      await ctx.deps.db.insert(invites).values({
        id,
        workspaceId: input.workspaceId,
        email: input.email.toLowerCase(),
        role: input.role,
        tokenHash: sha256(token),
        invitedBy: ctx.user.id,
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      });
      const link = `${ctx.deps.config.appUrl}/invite?token=${encodeURIComponent(token)}`;
      await ctx.deps.email.send({ to: input.email, subject: "You're invited to a Forge workspace", text: `${ctx.user.name || ctx.user.email} invited you: ${link}` });
      await audit(ctx, "workspace.invite", { workspaceId: input.workspaceId, target: input.email, meta: { role: input.role } });
      return { id };
    }),

  acceptInvite: authedProcedure.input(z.object({ token: z.string().min(10) })).mutation(async ({ ctx, input }) => {
    const [inv] = await ctx.deps.db
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, sha256(input.token)), isNull(invites.acceptedAt), gte(invites.expiresAt, new Date())));
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found or expired" });
    if (inv.email !== ctx.user.email.toLowerCase()) throw new TRPCError({ code: "FORBIDDEN", message: "This invite was sent to a different email" });
    await ctx.deps.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ workspaceId: inv.workspaceId, userId: ctx.user.id, role: inv.role }).onConflictDoNothing();
      await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));
    });
    await audit(ctx, "workspace.join", { workspaceId: inv.workspaceId, target: ctx.user.id });
    return { workspaceId: inv.workspaceId };
  }),

  changeRole: authedProcedure
    .input(z.object({ workspaceId: z.string(), userId: z.string(), role: RoleSchema }))
    .mutation(async ({ ctx, input }) => {
      const actor = await requireWorkspace(ctx, input.workspaceId, "members.manage");
      const [target] = await ctx.deps.db
        .select()
        .from(memberships)
        .where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)));
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      if (!canAssign(actor, input.role) || !canAssign(actor, target.role as Role)) throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient role" });
      if (target.role === "owner" && input.role !== "owner") {
        const owners = await ctx.deps.db.select().from(memberships).where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.role, "owner")));
        if (owners.length <= 1) throw new TRPCError({ code: "BAD_REQUEST", message: "A workspace needs at least one owner" });
      }
      await ctx.deps.db.update(memberships).set({ role: input.role }).where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)));
      await audit(ctx, "workspace.role_change", { workspaceId: input.workspaceId, target: input.userId, meta: { from: target.role, to: input.role } });
      return { ok: true };
    }),

  removeMember: authedProcedure.input(z.object({ workspaceId: z.string(), userId: z.string() })).mutation(async ({ ctx, input }) => {
    const actor = await requireWorkspace(ctx, input.workspaceId, "members.manage");
    const [target] = await ctx.deps.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)));
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    if (!canAssign(actor, target.role as Role)) throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient role" });
    await ctx.deps.db.delete(memberships).where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)));
    await audit(ctx, "workspace.remove_member", { workspaceId: input.workspaceId, target: input.userId });
    return { ok: true };
  }),

  auditLog: authedProcedure.input(z.object({ workspaceId: z.string(), limit: z.number().int().min(1).max(500).default(100) })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "members.manage");
    return ctx.deps.db.select().from(auditLog).where(eq(auditLog.workspaceId, input.workspaceId)).orderBy(desc(auditLog.at)).limit(input.limit);
  }),

  setSpendCap: authedProcedure
    .input(z.object({ workspaceId: z.string(), capUsd: z.number().min(0).max(1_000_000).nullable() }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "billing.manage");
      await ctx.deps.db.update(workspaces).set({ spendCapUsd: input.capUsd }).where(eq(workspaces.id, input.workspaceId));
      await audit(ctx, "workspace.spend_cap", { workspaceId: input.workspaceId, meta: { capUsd: input.capUsd } });
      return { ok: true };
    }),
});
