import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, artifacts, tasks } from "@forge/db";
import { QUEUES, newId, type Intent } from "@forge/shared";
import { router, authedProcedure, publicProcedure, requireProject, audit } from "../trpc.js";
import { requireService, type MediaEstimator, type SlidesExporter } from "../services.js";

const MediaKind = z.enum(["image", "image-set", "logo", "video", "remotion"]);

/** Media (images, video) and slides/documents studio endpoints. Generation runs in agent-worker queues. */
export const mediaRouter = router({
  estimate: authedProcedure
    .input(z.object({ projectId: z.string(), kind: MediaKind, prompt: z.string().min(1).max(4000), options: z.record(z.unknown()).default({}) }))
    .query(async ({ ctx, input }) => {
      await requireProject(ctx, input.projectId, "project.read");
      return requireService<MediaEstimator>(ctx.deps.services, "media").estimate(input.kind, input.prompt, input.options);
    }),

  generate: authedProcedure
    .input(z.object({ projectId: z.string(), kind: MediaKind, prompt: z.string().min(1).max(4000), options: z.record(z.unknown()).default({}) }))
    .mutation(async ({ ctx, input }) => {
      const { project } = await requireProject(ctx, input.projectId, "project.write");
      const media = requireService<MediaEstimator>(ctx.deps.services, "media");
      const mod = await media.moderate(input.prompt);
      if (!mod.allowed) throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: `Blocked by content policy (${mod.category}): ${mod.reason}` });
      const estimate = await media.estimate(input.kind, input.prompt, input.options);
      const taskId = newId("tsk");
      const intents: Intent[] = [{ kind: input.kind === "image" || input.kind === "image-set" || input.kind === "logo" ? "image" : "video", confidence: 1, summary: input.prompt.slice(0, 120), hint: input.kind }];
      await ctx.deps.db.insert(tasks).values({ id: taskId, projectId: project.id, userId: ctx.user.id, prompt: input.prompt, intents, status: "queued", estimateLowUsd: estimate.lowUsd, estimateHighUsd: estimate.highUsd });
      await ctx.deps.events.publish({ type: "cost.estimate", projectId: project.id, taskId, ...estimate });
      await ctx.deps.queue.add(QUEUES.media, input.kind, { taskId, projectId: project.id, workspaceId: project.workspaceId, kind: input.kind, prompt: input.prompt, options: input.options });
      return { taskId, estimate };
    }),
});

async function loadJsonArtifact(ctx: Parameters<typeof requireProject>[0], projectId: string, artifactId: string, kind: "deck" | "document") {
  const [a] = await ctx.deps.db.select().from(artifacts).where(and(eq(artifacts.id, artifactId), eq(artifacts.projectId, projectId), eq(artifacts.kind, kind)));
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: `${kind} not found` });
  return { artifact: a, json: JSON.parse(Buffer.from(await ctx.deps.store.get(a.storageKey)).toString("utf8")) as unknown };
}

export const slidesRouter = router({
  generate: authedProcedure
    .input(z.object({ projectId: z.string(), kind: z.enum(["deck", "document"]), prompt: z.string().min(1).max(8000), slideCount: z.number().int().min(1).max(60).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { project } = await requireProject(ctx, input.projectId, "project.write");
      const taskId = newId("tsk");
      await ctx.deps.db.insert(tasks).values({
        id: taskId,
        projectId: project.id,
        userId: ctx.user.id,
        prompt: input.prompt,
        intents: [{ kind: input.kind === "deck" ? "slides" : "document", confidence: 1, summary: input.prompt.slice(0, 120) }],
        status: "queued",
      });
      await ctx.deps.queue.add(QUEUES.slides, input.kind, { taskId, projectId: project.id, workspaceId: project.workspaceId, kind: input.kind, prompt: input.prompt, slideCount: input.slideCount });
      return { taskId };
    }),

  get: publicProcedure.input(z.object({ projectId: z.string(), artifactId: z.string(), kind: z.enum(["deck", "document"]) })).query(async ({ ctx, input }) => {
    await requireProject(ctx, input.projectId, "project.read");
    const { artifact, json } = await loadJsonArtifact(ctx, input.projectId, input.artifactId, input.kind);
    return { id: artifact.id, kind: artifact.kind, content: json, updatedAt: artifact.createdAt };
  }),

  /** Save an edited deck/document (edits are applied client-side with @forge/slides applyDeckEdit). */
  save: authedProcedure
    .input(z.object({ projectId: z.string(), artifactId: z.string(), kind: z.enum(["deck", "document"]), content: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx, input.projectId, "project.write");
      const ex = requireService<SlidesExporter>(ctx.deps.services, "slides");
      const v = input.kind === "deck" ? ex.validateDeck(input.content) : ex.validateDocument(input.content);
      if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.error });
      const { artifact } = await loadJsonArtifact(ctx, input.projectId, input.artifactId, input.kind);
      await ctx.deps.store.put(artifact.storageKey, JSON.stringify(input.content), { contentType: "application/json" });
      return { ok: true };
    }),

  export: authedProcedure
    .input(z.object({ projectId: z.string(), artifactId: z.string(), kind: z.enum(["deck", "document"]), format: z.enum(["pptx", "pdf", "docx", "html"]) }))
    .mutation(async ({ ctx, input }) => {
      await requireProject(ctx, input.projectId, "project.read");
      const ex = requireService<SlidesExporter>(ctx.deps.services, "slides");
      const { json } = await loadJsonArtifact(ctx, input.projectId, input.artifactId, input.kind);
      let out;
      if (input.kind === "deck") {
        if (input.format === "docx") throw new TRPCError({ code: "BAD_REQUEST", message: "Decks export to pptx, pdf or html" });
        out = await ex.exportDeck(json, input.format);
      } else {
        if (input.format === "pptx") throw new TRPCError({ code: "BAD_REQUEST", message: "Documents export to docx, pdf or html" });
        out = await ex.exportDocument(json, input.format);
      }
      const key = `projects/${input.projectId}/exports/${input.artifactId}-${Date.now()}.${out.ext}`;
      await ctx.deps.store.put(key, out.bytes, { contentType: out.mimeType });
      await audit(ctx, "slides.export", { target: input.artifactId, meta: { format: input.format } });
      return { url: await ctx.deps.store.url(key, 3600), mimeType: out.mimeType };
    }),
});
