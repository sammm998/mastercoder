import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, desc, meetings, retentionPolicies } from "@forge/db";
import { QUEUES, newId } from "@forge/shared";
import { router, authedProcedure, requireWorkspace, requireProject, audit, type AuthedContext } from "../trpc.js";
import { requireService, type MeetingUrlParser, type UploadService } from "../services.js";
import { createTaskFor } from "./task.js";

async function loadMeeting(ctx: AuthedContext, meetingId: string, perm: "project.read" | "project.write") {
  const [m] = await ctx.deps.db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!m || m.status === "deleted") throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
  await requireWorkspace(ctx, m.workspaceId, perm);
  return m;
}

async function retentionDate(ctx: AuthedContext, workspaceId: string): Promise<Date> {
  const [p] = await ctx.deps.db.select().from(retentionPolicies).where(eq(retentionPolicies.workspaceId, workspaceId));
  return new Date(Date.now() + (p?.recordingDays ?? 30) * 86400_000);
}

export const meetingsRouter = router({
  list: authedProcedure.input(z.object({ workspaceId: z.string() })).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx, input.workspaceId, "project.read");
    const rows = await ctx.deps.db.select().from(meetings).where(eq(meetings.workspaceId, input.workspaceId)).orderBy(desc(meetings.createdAt));
    return rows.filter((m) => m.status !== "deleted").map((m) => ({ ...m, transcript: undefined }));
  }),

  get: authedProcedure.input(z.object({ meetingId: z.string() })).query(async ({ ctx, input }) => loadMeeting(ctx, input.meetingId, "project.read")),

  /** Invite the notetaker bot by pasted link. It joins as "Forge notetaker" and posts a recording notice. */
  inviteBot: authedProcedure
    .input(z.object({ workspaceId: z.string(), projectId: z.string().optional(), meetingUrl: z.string().url().max(2000), title: z.string().max(200).optional(), language: z.enum(["sv", "en"]).default("sv") }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "project.write");
      const parsed = requireService<MeetingUrlParser>(ctx.deps.services, "meetingUrls").parse(input.meetingUrl);
      if (!parsed) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a Zoom, Teams or Google Meet link" });
      const id = newId("mtg");
      await ctx.deps.db.insert(meetings).values({
        id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        source: "bot",
        meetingUrl: input.meetingUrl,
        title: input.title ?? `${parsed.platform} meeting`,
        language: input.language,
        status: "scheduled",
        retentionUntil: await retentionDate(ctx, input.workspaceId),
      });
      await ctx.deps.queue.add(QUEUES.meetingBot, "join", { meetingId: id, workspaceId: input.workspaceId, action: "join", meetingUrl: input.meetingUrl, language: input.language });
      await audit(ctx, "meeting.invite_bot", { workspaceId: input.workspaceId, target: id, meta: { platform: parsed.platform } });
      return { id, platform: parsed.platform };
    }),

  removeBot: authedProcedure.input(z.object({ meetingId: z.string() })).mutation(async ({ ctx, input }) => {
    const m = await loadMeeting(ctx, input.meetingId, "project.write");
    await ctx.deps.queue.add(QUEUES.meetingBot, "leave", { meetingId: m.id, workspaceId: m.workspaceId, action: "leave", language: m.language });
    return { ok: true };
  }),

  /** In-person recording: create the meeting and a resumable chunked upload. Chunks go to PUT /uploads/:uploadId/:index. */
  startRecording: authedProcedure
    .input(z.object({ workspaceId: z.string(), projectId: z.string().optional(), title: z.string().max(200).optional(), language: z.enum(["sv", "en"]).default("sv"), totalSize: z.number().int().positive().max(2_000_000_000), mimeType: z.string().max(100), chunkSize: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(4 * 1024 * 1024) }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "project.write");
      const id = newId("mtg");
      await ctx.deps.db.insert(meetings).values({ id, workspaceId: input.workspaceId, projectId: input.projectId, source: "recording", title: input.title ?? "In-person meeting", language: input.language, status: "recording", consentNoticePosted: true, retentionUntil: await retentionDate(ctx, input.workspaceId) });
      const up = await requireService<UploadService>(ctx.deps.services, "uploads").init({ meetingId: id, totalSize: input.totalSize, mimeType: input.mimeType, chunkSize: input.chunkSize });
      await ctx.deps.kv.set(`upload:${up.uploadId}`, JSON.stringify({ meetingId: id, workspaceId: input.workspaceId, userId: ctx.user.id }), 7 * 86400);
      return { meetingId: id, uploadId: up.uploadId, chunkSize: input.chunkSize };
    }),

  /** Upload a meeting transcript (text with "Name: line" speaker labels) instead of audio. */
  importTranscript: authedProcedure
    .input(z.object({ workspaceId: z.string(), projectId: z.string().optional(), title: z.string().max(200).optional(), language: z.enum(["sv", "en"]).default("sv"), transcript: z.string().min(20).max(400_000) }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId, "project.write");
      const id = newId("mtg");
      await ctx.deps.db.insert(meetings).values({ id, workspaceId: input.workspaceId, projectId: input.projectId, source: "upload", title: input.title ?? "Uploaded transcript", language: input.language, status: "processing", consentNoticePosted: true, retentionUntil: await retentionDate(ctx, input.workspaceId) });
      await ctx.deps.queue.add(QUEUES.transcription, "transcribe", { meetingId: id, workspaceId: input.workspaceId, language: input.language, transcript: input.transcript });
      return { meetingId: id };
    }),

  uploadStatus: authedProcedure.input(z.object({ uploadId: z.string() })).query(async ({ ctx, input }) => {
    const raw = await ctx.deps.kv.get(`upload:${input.uploadId}`);
    if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found" });
    await requireWorkspace(ctx, (JSON.parse(raw) as { workspaceId: string }).workspaceId, "project.write");
    return requireService<UploadService>(ctx.deps.services, "uploads").status(input.uploadId);
  }),

  completeRecording: authedProcedure.input(z.object({ uploadId: z.string() })).mutation(async ({ ctx, input }) => {
    const raw = await ctx.deps.kv.get(`upload:${input.uploadId}`);
    if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found" });
    const meta = JSON.parse(raw) as { meetingId: string; workspaceId: string };
    const m = await loadMeeting(ctx, meta.meetingId, "project.write");
    const done = await requireService<UploadService>(ctx.deps.services, "uploads").complete(input.uploadId);
    await ctx.deps.db.update(meetings).set({ status: "processing", audioKey: done.storageKey }).where(eq(meetings.id, m.id));
    await ctx.deps.queue.add(QUEUES.transcription, "transcribe", { meetingId: m.id, workspaceId: m.workspaceId, audioKey: done.storageKey, language: m.language });
    return { ok: true, size: done.size };
  }),

  /** User approves (optionally edited) spec → becomes a normal build task through the intent router. */
  approveSpec: authedProcedure.input(z.object({ meetingId: z.string(), projectId: z.string(), spec: z.record(z.unknown()).optional(), prompt: z.string().max(20000).optional() })).mutation(async ({ ctx, input }) => {
    const m = await loadMeeting(ctx, input.meetingId, "project.write");
    if (m.status !== "ready") throw new TRPCError({ code: "BAD_REQUEST", message: "Meeting is not processed yet" });
    const spec = input.spec ?? (m.spec as Record<string, unknown> | null);
    if (!spec) throw new TRPCError({ code: "BAD_REQUEST", message: "No spec to approve" });
    await ctx.deps.db.update(meetings).set({ spec }).where(eq(meetings.id, m.id));
    const prompt = input.prompt ?? String((spec as { buildPrompt?: unknown }).buildPrompt ?? JSON.stringify(spec));
    const { project } = await requireProject(ctx, input.projectId, "project.write");
    if (project.workspaceId !== m.workspaceId) throw new TRPCError({ code: "BAD_REQUEST", message: "Project is in another workspace" });
    await audit(ctx, "meeting.approve_spec", { workspaceId: m.workspaceId, target: m.id });
    return createTaskFor(ctx, project, { prompt, source: "meeting", planMode: false });
  }),

  /** GDPR delete: removes audio, transcript, extraction and spec. */
  delete: authedProcedure.input(z.object({ meetingId: z.string() })).mutation(async ({ ctx, input }) => {
    const m = await loadMeeting(ctx, input.meetingId, "project.write");
    const keys = await ctx.deps.store.list(`meetings/${m.id}/`);
    for (const k of keys) await ctx.deps.store.delete(k);
    if (m.audioKey) await ctx.deps.store.delete(m.audioKey);
    await ctx.deps.db.update(meetings).set({ status: "deleted", transcript: null, extraction: null, spec: null, audioKey: null }).where(and(eq(meetings.id, m.id)));
    await audit(ctx, "meeting.delete", { workspaceId: m.workspaceId, target: m.id });
    return { ok: true };
  }),
});
