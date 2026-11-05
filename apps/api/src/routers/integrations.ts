import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, desc, isNull, or, connections } from "@forge/db";
import { newId } from "@forge/shared";
import { router, authedProcedure, requireWorkspace, requireProject, audit } from "../trpc.js";
import { requireService, type ConnectorPort, type OpenApiImporter, type VaultPort } from "../services.js";

const SecretName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "Use UPPER_SNAKE_CASE");

export const integrationsRouter = router({
  /** Catalog with human-readable scopes, shown before connecting. */
  apps: authedProcedure.input(z.object({ locale: z.enum(["en", "sv"]).default("en") })).query(async ({ ctx, input }) => {
    return requireService<ConnectorPort>(ctx.deps.services, "connectors").listApps(input.locale);
  }),

  /**
   * Connections. With `projectId`: that project's own connections plus workspace-wide ones (each tagged
   * with its scope). Without: every connection in the workspace.
   */
  connections: authedProcedure.input(z.object({ workspaceId: z.string(), projectId: z.string().optional() })).query(async ({ ctx, input }) => {
    if (input.projectId) {
      const { project } = await requireProject(ctx, input.projectId, "project.read");
      if (project.workspaceId !== input.workspaceId) throw new TRPCError({ code: "BAD_REQUEST", message: "Project is not in this workspace" });
    } else await requireWorkspace(ctx, input.workspaceId, "project.read");
    const where = input.projectId
      ? and(eq(connections.workspaceId, input.workspaceId), or(eq(connections.projectId, input.projectId), isNull(connections.projectId)))
      : eq(connections.workspaceId, input.workspaceId);
    const rows = await ctx.deps.db.select().from(connections).where(where).orderBy(desc(connections.createdAt));
    return rows.map((r) => ({ ...r, scope: r.projectId ? ("project" as const) : ("workspace" as const), config: r.provider === "openapi" || r.provider === "mcp" ? r.config : undefined }));
  }),

  /**
   * Start an OAuth / API-key connection. With `projectId` the connection belongs to that project only
   * (project editors may connect); without it, it is shared by the workspace (admins only).
   */
  connect: authedProcedure
    .input(z.object({ workspaceId: z.string(), projectId: z.string().optional(), app: z.string().max(60), scopes: z.array(z.string().max(200)).max(50) }))
    .mutation(async ({ ctx, input }) => {
      if (input.projectId) {
        const { project } = await requireProject(ctx, input.projectId, "project.write");
        if (project.workspaceId !== input.workspaceId) throw new TRPCError({ code: "BAD_REQUEST", message: "Project is not in this workspace" });
      } else await requireWorkspace(ctx, input.workspaceId, "integrations.manage");
      const port = requireService<ConnectorPort>(ctx.deps.services, "connectors");
      const id = newId("con");
      const back = input.projectId ? `${ctx.deps.config.appUrl}/app/p/${input.projectId}?tab=integrations&connected=${id}` : `${ctx.deps.config.appUrl}/app/integrations?connected=${id}`;
      const r = await port.initiate({ workspaceId: input.workspaceId, projectId: input.projectId, userId: ctx.user.id, app: input.app, scopes: input.scopes, redirectUrl: back });
      await ctx.deps.db.insert(connections).values({ id, workspaceId: input.workspaceId, projectId: input.projectId ?? null, userId: ctx.user.id, provider: port.provider, app: input.app, scopes: input.scopes, externalId: r.externalId ?? r.connectionId, status: "pending" });
      await audit(ctx, "integration.connect", { workspaceId: input.workspaceId, target: id, meta: { app: input.app, scopes: input.scopes, projectId: input.projectId } });
      return { connectionId: id, redirectUrl: r.redirectUrl };
    }),

  refresh: authedProcedure.input(z.object({ connectionId: z.string() })).mutation(async ({ ctx, input }) => {
    const [c] = await ctx.deps.db.select().from(connections).where(eq(connections.id, input.connectionId));
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
    if (c.projectId) await requireProject(ctx, c.projectId, "project.read");
    else await requireWorkspace(ctx, c.workspaceId, "project.read");
    if (!c.externalId || c.provider === "openapi" || c.provider === "mcp") return { status: c.status };
    const s = await requireService<ConnectorPort>(ctx.deps.services, "connectors").status(c.externalId);
    await ctx.deps.db.update(connections).set({ status: s.status, scopes: s.scopes.length ? s.scopes : c.scopes }).where(eq(connections.id, c.id));
    return { status: s.status };
  }),

  revoke: authedProcedure.input(z.object({ connectionId: z.string() })).mutation(async ({ ctx, input }) => {
    const [c] = await ctx.deps.db.select().from(connections).where(eq(connections.id, input.connectionId));
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
    if (c.projectId) await requireProject(ctx, c.projectId, "project.write");
    else await requireWorkspace(ctx, c.workspaceId, "integrations.manage");
    if (c.externalId && c.provider !== "openapi" && c.provider !== "mcp") await requireService<ConnectorPort>(ctx.deps.services, "connectors").revoke(c.externalId);
    await ctx.deps.db.update(connections).set({ status: "revoked", revokedAt: new Date() }).where(eq(connections.id, c.id));
    await audit(ctx, "integration.revoke", { workspaceId: c.workspaceId, target: c.id });
    return { ok: true };
  }),

  importOpenApi: authedProcedure
    .input(z.object({ workspaceId: z.string(), source: z.union([z.string().url(), z.record(z.unknown())]), name: z.string().max(80).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "integrations.manage");
      const api = await requireService<OpenApiImporter>(ctx.deps.services, "openapi").import(input.source);
      const id = newId("con");
      await ctx.deps.db.insert(connections).values({
        id,
        workspaceId: input.workspaceId,
        userId: ctx.user.id,
        provider: "openapi",
        app: input.name ?? api.title,
        status: "active",
        config: { title: api.title, operations: api.operations, source: typeof input.source === "string" ? input.source : "inline", spec: api.spec },
      });
      await audit(ctx, "integration.openapi_import", { workspaceId: input.workspaceId, target: id, meta: { operations: api.operations.length } });
      return { connectionId: id, title: api.title, operations: api.operations };
    }),

  addMcpServer: authedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        name: z.string().min(1).max(80),
        transport: z.enum(["http", "stdio"]),
        url: z.string().url().optional(),
        command: z.string().max(200).optional(),
        args: z.array(z.string().max(200)).max(20).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "integrations.manage");
      if (input.transport === "http" && !input.url) throw new TRPCError({ code: "BAD_REQUEST", message: "HTTP MCP servers need a url" });
      if (input.transport === "stdio" && !input.command) throw new TRPCError({ code: "BAD_REQUEST", message: "stdio MCP servers need a command" });
      const id = newId("con");
      await ctx.deps.db.insert(connections).values({ id, workspaceId: input.workspaceId, userId: ctx.user.id, provider: "mcp", app: input.name, status: "active", config: { transport: input.transport, url: input.url, command: input.command, args: input.args } });
      await audit(ctx, "integration.mcp_add", { workspaceId: input.workspaceId, target: id });
      return { connectionId: id };
    }),

  secretNames: authedProcedure.input(z.object({ workspaceId: z.string(), projectId: z.string().optional() })).query(async ({ ctx, input }) => {
    if (input.projectId) await requireProject(ctx, input.projectId, "project.read");
    else await requireWorkspace(ctx, input.workspaceId, "project.read");
    return requireService<VaultPort>(ctx.deps.services, "vault").listNames({ workspaceId: input.workspaceId, projectId: input.projectId });
  }),

  /** Write-only: secret values never leave the server once stored. */
  setSecret: authedProcedure
    .input(z.object({ workspaceId: z.string(), projectId: z.string().optional(), name: SecretName, value: z.string().min(1).max(10_000) }))
    .mutation(async ({ ctx, input }) => {
      if (input.projectId) {
        const { project } = await requireProject(ctx, input.projectId, "project.write");
        if (project.workspaceId !== input.workspaceId) throw new TRPCError({ code: "BAD_REQUEST", message: "Project is not in this workspace" });
      } else await requireWorkspace(ctx, input.workspaceId, "integrations.manage");
      await requireService<VaultPort>(ctx.deps.services, "vault").put({ workspaceId: input.workspaceId, projectId: input.projectId }, input.name, input.value);
      await audit(ctx, "secret.set", { workspaceId: input.workspaceId, target: input.name, meta: { projectId: input.projectId } });
      return { ok: true };
    }),

  deleteSecret: authedProcedure.input(z.object({ workspaceId: z.string(), projectId: z.string().optional(), name: SecretName })).mutation(async ({ ctx, input }) => {
    if (input.projectId) await requireProject(ctx, input.projectId, "project.write");
    else await requireWorkspace(ctx, input.workspaceId, "integrations.manage");
    await requireService<VaultPort>(ctx.deps.services, "vault").delete({ workspaceId: input.workspaceId, projectId: input.projectId }, input.name);
    await audit(ctx, "secret.delete", { workspaceId: input.workspaceId, target: input.name });
    return { ok: true };
  }),

  getConnection: authedProcedure.input(z.object({ connectionId: z.string() })).query(async ({ ctx, input }) => {
    const [c] = await ctx.deps.db.select().from(connections).where(and(eq(connections.id, input.connectionId)));
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
    await requireWorkspace(ctx, c.workspaceId, "project.read");
    return c;
  }),
});
