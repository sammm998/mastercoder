import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, desc, deployments, domains } from "@forge/db";
import { QUEUES, newId } from "@forge/shared";
import { router, authedProcedure, requireProject, audit } from "../trpc.js";
import { requireService, type DomainPort } from "../services.js";

const Hostname = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i, "Invalid hostname");

export const deployRouter = router({
  list: authedProcedure.input(z.object({ projectId: z.string() })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    return ctx.deps.db.select().from(deployments).where(eq(deployments.projectId, input.projectId)).orderBy(desc(deployments.createdAt));
  }),

  /** Quality gates run in the worker before anything goes live; a failing gate blocks the deploy. */
  deploy: authedProcedure.input(z.object({ projectId: z.string(), checkpointId: z.string().optional(), branch: z.string().max(100).default("main") })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx, input.projectId, "project.deploy");
    const job = await ctx.deps.queue.add(QUEUES.deploy, "deploy", { projectId: project.id, workspaceId: project.workspaceId, checkpointId: input.checkpointId, branch: input.branch });
    await audit(ctx, "deploy.request", { workspaceId: project.workspaceId, target: project.id, meta: { branch: input.branch } });
    return { jobId: job.id };
  }),

  rollback: authedProcedure.input(z.object({ projectId: z.string(), deploymentId: z.string() })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx, input.projectId, "project.deploy");
    const [d] = await ctx.deps.db.select().from(deployments).where(and(eq(deployments.id, input.deploymentId), eq(deployments.projectId, project.id)));
    if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Deployment not found" });
    const job = await ctx.deps.queue.add(QUEUES.deploy, "rollback", { projectId: project.id, workspaceId: project.workspaceId, rollbackTo: d.id, branch: d.branch });
    await audit(ctx, "deploy.rollback", { workspaceId: project.workspaceId, target: d.id });
    return { jobId: job.id };
  }),

  exportGithub: authedProcedure.input(z.object({ projectId: z.string(), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.string().max(100).default("main") })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx, input.projectId, "project.write");
    const job = await ctx.deps.queue.add(QUEUES.deploy, "export-github", { projectId: project.id, workspaceId: project.workspaceId, repo: input.repo, branch: input.branch, userId: ctx.user.id });
    return { jobId: job.id };
  }),

  domains: authedProcedure.input(z.object({ projectId: z.string() })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    return ctx.deps.db.select().from(domains).where(eq(domains.projectId, input.projectId));
  }),

  addDomain: authedProcedure.input(z.object({ projectId: z.string(), hostname: Hostname })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx, input.projectId, "project.deploy");
    const hostname = input.hostname.toLowerCase();
    const r = await requireService<DomainPort>(ctx.deps.services, "domains").addDomain(project.id, hostname);
    const token = newId("dv", 16);
    await ctx.deps.db.insert(domains).values({ id: newId("dom"), projectId: project.id, hostname, verificationToken: token, tlsStatus: r.tlsStatus });
    await audit(ctx, "domain.add", { workspaceId: project.workspaceId, target: hostname });
    return { records: [...r.records, { type: "TXT", name: `_forge-verify.${hostname}`, value: token }], tlsStatus: r.tlsStatus };
  }),

  checkDomain: authedProcedure.input(z.object({ projectId: z.string(), hostname: Hostname })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.deploy");
    const r = await requireService<DomainPort>(ctx.deps.services, "domains").checkDomain(input.projectId, input.hostname.toLowerCase());
    await ctx.deps.db.update(domains).set({ verified: r.verified, tlsStatus: r.tlsStatus }).where(and(eq(domains.projectId, input.projectId), eq(domains.hostname, input.hostname.toLowerCase())));
    return r;
  }),

  removeDomain: authedProcedure.input(z.object({ projectId: z.string(), hostname: Hostname })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx, input.projectId, "project.deploy");
    await requireService<DomainPort>(ctx.deps.services, "domains").removeDomain(project.id, input.hostname.toLowerCase());
    await ctx.deps.db.delete(domains).where(and(eq(domains.projectId, project.id), eq(domains.hostname, input.hostname.toLowerCase())));
    await audit(ctx, "domain.remove", { workspaceId: project.workspaceId, target: input.hostname });
    return { ok: true };
  }),
});
