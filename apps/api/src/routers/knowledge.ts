import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, knowledgeSources, knowledgeChunks, knowledgeProfiles, chunkText } from "@forge/db";
import { QUEUES, newId } from "@forge/shared";
import { router, authedProcedure, requireWorkspace, audit } from "../trpc.js";

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?|.*\.internal$|.*\.local$)/i;

/** Company knowledge base: website crawls and pasted text, summarised into a profile used as build context. */
export const knowledgeRouter = router({
  overview: authedProcedure.input(z.object({ workspaceId: z.string() })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "project.read");
    const sources = await ctx.deps.db.select().from(knowledgeSources).where(eq(knowledgeSources.workspaceId, input.workspaceId)).orderBy(desc(knowledgeSources.createdAt));
    const [profile] = await ctx.deps.db.select().from(knowledgeProfiles).where(eq(knowledgeProfiles.workspaceId, input.workspaceId));
    return { sources, profile: profile ?? null };
  }),

  addUrl: authedProcedure.input(z.object({ workspaceId: z.string(), url: z.string().url().max(2000) })).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "integrations.manage");
    const u = new URL(input.url);
    if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) throw new TRPCError({ code: "BAD_REQUEST", message: "Use a public website address" });
    const id = newId("ks");
    await ctx.deps.db.insert(knowledgeSources).values({ id, workspaceId: input.workspaceId, kind: "url", title: u.hostname, url: u.href, createdBy: ctx.user.id });
    await ctx.deps.queue.add(QUEUES.knowledge, "ingest", { sourceId: id, workspaceId: input.workspaceId });
    await audit(ctx, "knowledge.add_url", { workspaceId: input.workspaceId, target: id, meta: { host: u.hostname } });
    return { id };
  }),

  addText: authedProcedure.input(z.object({ workspaceId: z.string(), title: z.string().min(1).max(120), text: z.string().min(20).max(200_000) })).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "integrations.manage");
    const id = newId("ks");
    const chunks = chunkText(input.text);
    await ctx.deps.db.insert(knowledgeSources).values({ id, workspaceId: input.workspaceId, kind: "text", title: input.title, pages: 1, status: "queued", createdBy: ctx.user.id });
    if (chunks.length) await ctx.deps.db.insert(knowledgeChunks).values(chunks.map((content) => ({ id: newId("kc"), sourceId: id, workspaceId: input.workspaceId, title: input.title, content })));
    await ctx.deps.queue.add(QUEUES.knowledge, "ingest", { sourceId: id, workspaceId: input.workspaceId });
    await audit(ctx, "knowledge.add_text", { workspaceId: input.workspaceId, target: id });
    return { id, chunks: chunks.length };
  }),

  recrawl: authedProcedure.input(z.object({ sourceId: z.string() })).mutation(async ({ ctx, input }) => {
    const [s] = await ctx.deps.db.select().from(knowledgeSources).where(eq(knowledgeSources.id, input.sourceId));
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Source not found" });
    await requireWorkspace(ctx, s.workspaceId, "integrations.manage");
    await ctx.deps.db.update(knowledgeSources).set({ status: "queued", error: null }).where(eq(knowledgeSources.id, s.id));
    await ctx.deps.queue.add(QUEUES.knowledge, "ingest", { sourceId: s.id, workspaceId: s.workspaceId });
    return { ok: true };
  }),

  remove: authedProcedure.input(z.object({ sourceId: z.string() })).mutation(async ({ ctx, input }) => {
    const [s] = await ctx.deps.db.select().from(knowledgeSources).where(eq(knowledgeSources.id, input.sourceId));
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Source not found" });
    await requireWorkspace(ctx, s.workspaceId, "integrations.manage");
    await ctx.deps.db.delete(knowledgeSources).where(and(eq(knowledgeSources.id, s.id), eq(knowledgeSources.workspaceId, s.workspaceId)));
    // Rebuild the profile from what is left (an ingest job with no source just refreshes it).
    const [other] = await ctx.deps.db.select({ id: knowledgeSources.id }).from(knowledgeSources).where(eq(knowledgeSources.workspaceId, s.workspaceId)).limit(1);
    if (other) await ctx.deps.queue.add(QUEUES.knowledge, "ingest", { sourceId: other.id, workspaceId: s.workspaceId });
    else await ctx.deps.db.delete(knowledgeProfiles).where(eq(knowledgeProfiles.workspaceId, s.workspaceId));
    await audit(ctx, "knowledge.remove", { workspaceId: s.workspaceId, target: s.id });
    return { ok: true };
  }),

  /** The profile is editable: what the user writes here is what Scoutr uses. */
  updateProfile: authedProcedure.input(z.object({ workspaceId: z.string(), profile: z.string().max(12_000) })).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "integrations.manage");
    await ctx.deps.db
      .insert(knowledgeProfiles)
      .values({ workspaceId: input.workspaceId, profile: input.profile, generatedBy: "user" })
      .onConflictDoUpdate({ target: knowledgeProfiles.workspaceId, set: { profile: input.profile, generatedBy: "user", updatedAt: new Date() } });
    return { ok: true };
  }),
});
