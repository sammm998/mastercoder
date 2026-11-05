import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { and, eq, memberships, projects, auditLog } from "@forge/db";
import { ForgeError, newId } from "@forge/shared";
import type { ApiDeps } from "./deps.js";
import { can, type Permission, type Role } from "./lib/rbac.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  locale: string;
  isAdmin: boolean;
}

export interface Context {
  deps: ApiDeps;
  user: SessionUser | null;
  sessionToken: string | null;
  ip: string;
  userAgent: string;
  setCookie(name: string, value: string, maxAgeSec: number): void;
  clearCookie(name: string): void;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    return { ...shape, data: { ...shape.data, forgeCode: cause instanceof ForgeError ? cause.code : undefined } };
  },
});

const FORGE_TO_TRPC: Record<string, TRPCError["code"]> = {
  BAD_INPUT: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  SPEND_CAP: "PRECONDITION_FAILED",
  MODERATION_BLOCKED: "UNPROCESSABLE_CONTENT",
  GATE_FAILED: "PRECONDITION_FAILED",
  APPROVAL_REQUIRED: "PRECONDITION_FAILED",
};

/** Map domain errors to tRPC errors so clients get proper codes. */
const errorMapper = t.middleware(async ({ next }) => {
  const res = await next();
  if (!res.ok && res.error.cause instanceof ForgeError) {
    const fe = res.error.cause;
    throw new TRPCError({ code: FORGE_TO_TRPC[fe.code] ?? "INTERNAL_SERVER_ERROR", message: fe.message, cause: fe });
  }
  return res;
});

const ipLimit = t.middleware(async ({ ctx, next }) => {
  const r = await ctx.deps.rateLimiter.hit(`ip:${ctx.ip}`, ctx.deps.config.rateLimitPerMinIp, 60);
  if (!r.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Rate limit exceeded; retry in ${r.resetSec}s` });
  return next();
});

const requireUser = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required" });
  const r = await ctx.deps.rateLimiter.hit(`user:${ctx.user.id}`, ctx.deps.config.rateLimitPerMinUser, 60);
  if (!r.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Rate limit exceeded; retry in ${r.resetSec}s` });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const requireAdmin = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user?.isAdmin) throw new TRPCError({ code: "FORBIDDEN", message: "Admin only" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure.use(errorMapper).use(ipLimit);
export const authedProcedure = publicProcedure.use(requireUser);
export const adminProcedure = authedProcedure.use(requireAdmin);

export type AuthedContext = Context & { user: SessionUser };

export async function workspaceRole(ctx: Context, workspaceId: string): Promise<Role | null> {
  if (!ctx.user) return null;
  const [m] = await ctx.deps.db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, ctx.user.id)));
  return (m?.role as Role | undefined) ?? null;
}

export async function requireWorkspace(ctx: Context, workspaceId: string, perm: Permission): Promise<Role> {
  const role = await workspaceRole(ctx, workspaceId);
  if (!can(role, perm)) throw new TRPCError({ code: role ? "FORBIDDEN" : "NOT_FOUND", message: role ? `Requires ${perm}` : "Workspace not found" });
  return role as Role;
}

export type ProjectRow = typeof projects.$inferSelect;

/** Load a project and enforce access. Public projects are readable by anyone (for remixing). */
export async function requireProject(ctx: Context, projectId: string, perm: Permission): Promise<{ project: ProjectRow; role: Role | null }> {
  const [project] = await ctx.deps.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.deletedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  const role = await workspaceRole(ctx, project.workspaceId);
  if (perm === "project.read" && project.isPublic) return { project, role };
  if (!can(role, perm)) throw new TRPCError({ code: role ? "FORBIDDEN" : "NOT_FOUND", message: role ? `Requires ${perm}` : "Project not found" });
  return { project, role };
}

export async function audit(ctx: Context, action: string, opts: { workspaceId?: string | null; target?: string; meta?: unknown } = {}): Promise<void> {
  await ctx.deps.db.insert(auditLog).values({
    id: newId("aud"),
    workspaceId: opts.workspaceId ?? null,
    actorId: ctx.user?.id ?? null,
    action,
    target: opts.target ?? null,
    meta: opts.meta ?? null,
    ip: ctx.ip,
  });
}
