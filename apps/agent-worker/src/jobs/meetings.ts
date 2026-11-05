import { eq, meetings, type Db } from "@forge/db";
import { ForgeError, type EventSink, type ObjectStore, type UsageSink } from "@forge/shared";
import type { LLMProvider } from "@forge/llm";
import type { SttProvider } from "@forge/speech";
import { processMeeting, approveSpec, consentMessage, type MeetingBotProvider } from "@forge/meetings";

export interface MeetingJobDeps {
  db: Db;
  llm: LLMProvider;
  stt: SttProvider;
  bots: MeetingBotProvider;
  store: ObjectStore;
  usage: UsageSink;
  events: EventSink;
  /** Public webhook URL for bot vendors (API: /hooks/meetings/:provider). */
  webhookUrl?: string;
}

async function load(db: Db, id: string) {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, id));
  if (!m || m.status === "deleted") throw new ForgeError("NOT_FOUND", `Meeting ${id} not found`);
  return m;
}

function emitStatus(d: MeetingJobDeps, m: { id: string; projectId: string | null }, status: string) {
  if (m.projectId) d.events.emit({ type: "meeting.status", projectId: m.projectId, meetingId: m.id, status });
}

/** audio (or vendor transcript) → transcript → summary/decisions/requirements/questions → spec → awaiting approval. */
export async function runTranscription(input: { meetingId: string; audioKey?: string; language: string; transcript?: string }, d: MeetingJobDeps) {
  const m = await load(d.db, input.meetingId);
  await d.db.update(meetings).set({ status: "processing" }).where(eq(meetings.id, m.id));
  emitStatus(d, m, "processing");
  try {
    const audioKey = input.audioKey ?? m.audioKey ?? undefined;
    const audio = audioKey ? { bytes: await d.store.get(audioKey), mimeType: audioKey.endsWith(".webm") ? "audio/webm" : audioKey.endsWith(".m4a") ? "audio/mp4" : "audio/wav" } : undefined;
    if (!audio && !input.transcript) throw new ForgeError("BAD_INPUT", "Meeting has neither audio nor transcript");
    const r = await processMeeting(
      { meetingId: m.id, audio, transcript: input.transcript, language: input.language || m.language, diarize: true },
      { llm: d.llm, stt: d.stt, usage: d.usage, events: d.events, projectId: m.projectId ?? undefined },
    );
    const spec = { ...r.spec, buildPrompt: approveSpec(r.spec) };
    await d.db.update(meetings).set({ status: "ready", transcript: r.transcript as object, extraction: r.extraction as object, spec }).where(eq(meetings.id, m.id));
    emitStatus(d, m, "ready");
    return { ...r, spec };
  } catch (e) {
    await d.db.update(meetings).set({ status: "failed" }).where(eq(meetings.id, m.id));
    emitStatus(d, m, "failed");
    throw e;
  }
}

/** Bot lifecycle: join (visible name + recording notice), leave, poll (fetch transcript when done). */
export async function runMeetingBot(input: { meetingId: string; action: "join" | "leave" | "poll"; meetingUrl?: string; language: string }, d: MeetingJobDeps): Promise<{ status: string }> {
  const m = await load(d.db, input.meetingId);
  if (input.action === "join") {
    const url = input.meetingUrl ?? m.meetingUrl;
    if (!url) throw new ForgeError("BAD_INPUT", "No meeting URL");
    const j = await d.bots.join({ meetingUrl: url, botName: "Forge notetaker", consentMessage: consentMessage("Forge notetaker"), language: input.language, webhookUrl: d.webhookUrl });
    if (!d.bots.postsConsentOnJoin) await d.bots.sendChatMessage(j.botId, consentMessage("Forge notetaker"));
    await d.db.update(meetings).set({ externalBotId: j.botId, provider: d.bots.name, status: "joining", consentNoticePosted: true }).where(eq(meetings.id, m.id));
    emitStatus(d, m, "joining");
    return { status: j.status };
  }
  if (!m.externalBotId) throw new ForgeError("BAD_INPUT", "No bot for this meeting");
  if (input.action === "leave") {
    await d.bots.leave(m.externalBotId);
    return { status: "left" };
  }
  const s = await d.bots.getStatus(m.externalBotId);
  if (s.status === "done" || s.status === "left") {
    const t = await d.bots.getTranscript(m.externalBotId);
    await runTranscription({ meetingId: m.id, language: m.language, transcript: t.segments.map((x) => `${x.speaker ?? "Speaker"}: ${x.text}`).join("\n") || t.text }, d);
    return { status: "ready" };
  }
  if (s.status === "in_call" || s.status === "recording") {
    await d.db.update(meetings).set({ status: "recording" }).where(eq(meetings.id, m.id));
    emitStatus(d, m, "recording");
  }
  if (s.status === "error") {
    await d.db.update(meetings).set({ status: "failed" }).where(eq(meetings.id, m.id));
    emitStatus(d, m, "failed");
  }
  return { status: s.status };
}
