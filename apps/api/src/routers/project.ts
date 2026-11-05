import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, desc, isNull, projects, projectFiles, comments, events, checkpoints, artifacts } from "@forge/db";
import { QUEUES, newId } from "@forge/shared";
import { router, authedProcedure, publicProcedure, requireProject, requireWorkspace, audit } from "../trpc.js";

const FilePath = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !p.includes("..") && !p.startsWith("/") && !p.includes("\0"), "Invalid path");

export const projectRouter = router({
  list: authedProcedure.input(z.object({ workspaceId: z.string() })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "project.read");
    return ctx.deps.db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt)))
      .orderBy(desc(projects.createdAt));
  }),

  gallery: publicProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(30) })).query(async ({ ctx, input }) => {
    return ctx.deps.db
      .select({ id: projects.id, name: projects.name, template: projects.template, createdAt: projects.createdAt, remixOf: projects.remixOf })
      .from(projects)
      .where(and(eq(projects.isPublic, true), isNull(projects.deletedAt)))
      .orderBy(desc(projects.createdAt))
      .limit(input.limit);
  }),

  create: authedProcedure
    .input(z.object({ workspaceId: z.string(), name: z.string().min(1).max(100), template: z.string().max(50).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "project.write");
      const id = newId("prj");
      await ctx.deps.db.insert(projects).values({ id, workspaceId: input.workspaceId, name: input.name, template: input.template, createdBy: ctx.user.id });
      await audit(ctx, "project.create", { workspaceId: input.workspaceId, target: id });
      return { id };
    }),

  get: publicProcedure.input(z.object({ projectId: z.string() })).query(async ({ ctx, input }) => {
    const { project, role } = await requireProject(ctx, input.projectId, "project.read");
    return { ...project, role };
  }),

  update: authedProcedure
    .input(z.object({ projectId: z.string(), name: z.string().min(1).max(100).optional(), brand: z.record(z.unknown()).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx, input.projectId, "project.write");
      await ctx.deps.db
        .update(projects)
        .set({ ...(input.name ? { name: input.name } : {}), ...(input.brand ? { brand: input.brand } : {}) })
        .where(eq(projects.id, input.projectId));
      return { ok: true };
    }),

  delete: authedProcedure.input(z.object({ projectId: z.string() })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx, input.projectId, "project.delete");
    await ctx.deps.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, input.projectId));
    await audit(ctx, "project.delete", { workspaceId: project.workspaceId, target: project.id });
    return { ok: true };
  }),

  setPublic: authedProcedure.input(z.object({ projectId: z.string(), isPublic: z.boolean() })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx, input.projectId, "project.write");
    await ctx.deps.db.update(projects).set({ isPublic: input.isPublic }).where(eq(projects.id, input.projectId));
    await audit(ctx, input.isPublic ? "project.share" : "project.unshare", { workspaceId: project.workspaceId, target: project.id });
    return { ok: true };
  }),

  /** Copy a public (or own) project's files into a new project in the caller's workspace. */
  remix: authedProcedure.input(z.object({ projectId: z.string(), workspaceId: z.string() })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx, input.projectId, "project.read");
    await requireWorkspace(ctx, input.workspaceId, "project.write");
    const id = newId("prj");
    const files = await ctx.deps.db.select().from(projectFiles).where(eq(projectFiles.projectId, project.id));
    await ctx.deps.db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id,
        workspaceId: input.workspaceId,
        name: `${project.name} (remix)`,
        template: project.template,
        brand: project.brand,
        artDirection: project.artDirection,
        remixOf: project.id,
        createdBy: ctx.user.id,
      });
      if (files.length) await tx.insert(projectFiles).values(files.map((f) => ({ projectId: id, path: f.path, content: f.content })));
    });
    await audit(ctx, "project.remix", { workspaceId: input.workspaceId, target: id, meta: { from: project.id } });
    return { id };
  }),

  importGithub: authedProcedure
    .input(z.object({ workspaceId: z.string(), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.string().max(100).default("main") }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "project.write");
      const id = newId("prj");
      await ctx.deps.db.insert(projects).values({ id, workspaceId: input.workspaceId, name: input.repo.split("/")[1] ?? input.repo, githubRepo: input.repo, createdBy: ctx.user.id });
      await ctx.deps.queue.add(QUEUES.build, "import-github", { projectId: id, workspaceId: input.workspaceId, repo: input.repo, branch: input.branch, userId: ctx.user.id });
      await audit(ctx, "project.import_github", { workspaceId: input.workspaceId, target: id, meta: { repo: input.repo } });
      return { id };
    }),

  files: publicProcedure.input(z.object({ projectId: z.string() })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    const rows = await ctx.deps.db.select({ path: projectFiles.path, updatedAt: projectFiles.updatedAt }).from(projectFiles).where(eq(projectFiles.projectId, input.projectId));
    return rows.sort((a, b) => a.path.localeCompare(b.path));
  }),

  readFile: publicProcedure.input(z.object({ projectId: z.string(), path: FilePath })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    const [f] = await ctx.deps.db.select().from(projectFiles).where(and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.path, input.path)));
    if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
    return f;
  }),

  /** Direct edit (editor or visual edit overlay). No LLM call. */
  writeFile: authedProcedure
    .input(z.object({ projectId: z.string(), path: FilePath, content: z.string().max(2_000_000) }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx, input.projectId, "project.write");
      await ctx.deps.db
        .insert(projectFiles)
        .values({ projectId: input.projectId, path: input.path, content: input.content })
        .onConflictDoUpdate({ target: [projectFiles.projectId, projectFiles.path], set: { content: input.content, updatedAt: new Date() } });
      const collab = ctx.deps.services.collab as { replaceText(p: string, path: string, c: string): Promise<void> } | undefined;
      await collab?.replaceText(input.projectId, input.path, input.content);
      await ctx.deps.events.publish({ type: "file.changed", projectId: input.projectId, path: input.path, change: "modified" });
      return { ok: true };
    }),

  events: publicProcedure.input(z.object({ projectId: z.string(), limit: z.number().int().min(1).max(1000).default(200) })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    const rows = await ctx.deps.db.select().from(events).where(eq(events.projectId, input.projectId)).orderBy(desc(events.at)).limit(input.limit);
    return rows.reverse();
  }),

  checkpoints: authedProcedure.input(z.object({ projectId: z.string() })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    return ctx.deps.db.select().from(checkpoints).where(eq(checkpoints.projectId, input.projectId)).orderBy(desc(checkpoints.createdAt));
  }),

  restoreCheckpoint: authedProcedure.input(z.object({ projectId: z.string(), checkpointId: z.string() })).mutation(async ({ ctx, input }) => {
    const { project } = await requireProject(ctx, input.projectId, "project.write");
    const [cp] = await ctx.deps.db.select().from(checkpoints).where(and(eq(checkpoints.id, input.checkpointId), eq(checkpoints.projectId, input.projectId)));
    if (!cp) throw new TRPCError({ code: "NOT_FOUND", message: "Checkpoint not found" });
    const job = await ctx.deps.queue.add(QUEUES.build, "restore-checkpoint", { projectId: project.id, workspaceId: project.workspaceId, checkpointId: cp.id, userId: ctx.user.id });
    await audit(ctx, "project.restore_checkpoint", { workspaceId: project.workspaceId, target: cp.id });
    return { jobId: job.id };
  }),

  artifacts: publicProcedure.input(z.object({ projectId: z.string(), kind: z.string().optional() })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    const rows = await ctx.deps.db
      .select()
      .from(artifacts)
      .where(input.kind ? and(eq(artifacts.projectId, input.projectId), eq(artifacts.kind, input.kind)) : eq(artifacts.projectId, input.projectId))
      .orderBy(desc(artifacts.createdAt));
    return Promise.all(rows.map(async (a) => ({ ...a, url: await ctx.deps.store.url(a.storageKey) })));
  }),

  comments: publicProcedure.input(z.object({ projectId: z.string() })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    return ctx.deps.db.select().from(comments).where(eq(comments.projectId, input.projectId)).orderBy(desc(comments.createdAt));
  }),

  addComment: authedProcedure
    .input(z.object({ projectId: z.string(), body: z.string().min(1).max(5000), selector: z.string().max(500).optional(), path: FilePath.optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx, input.projectId, "project.read");
      const id = newId("cmt");
      await ctx.deps.db.insert(comments).values({ id, projectId: input.projectId, userId: ctx.user.id, body: input.body, selector: input.selector, path: input.path });
      await ctx.deps.events.publish({ type: "message", projectId: input.projectId, role: "system", text: `💬 ${ctx.user.name || ctx.user.email}: ${input.body.slice(0, 200)}` });
      return { id };
    }),

  resolveComment: authedProcedure.input(z.object({ projectId: z.string(), commentId: z.string() })).mutation(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.write");
    await ctx.deps.db.update(comments).set({ resolved: true }).where(and(eq(comments.id, input.commentId), eq(comments.projectId, input.projectId)));
    return { ok: true };
  }),
});
