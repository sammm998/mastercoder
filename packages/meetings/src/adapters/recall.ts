import { z } from "zod";
import { ForgeError, type CostEstimate, type UsageSink } from "@forge/shared";
import type { Transcript, TranscriptSegment } from "@forge/speech";
import { JoinOptionsSchema, type BotStatus, type BotStatusInfo, type JoinOptions, type JoinResult, type MeetingBotProvider, type MeetingEvent, type WebhookHeaders } from "../types.js";
import { consentMessage } from "../consent.js";
import { BOT_PRICES, botEstimate, recordBotHours, type BotPrice } from "../pricing.js";
import { verifyStandardWebhook } from "../webhook-sig.js";
import { bodyText, fetchJson, type FetchLike } from "./http.js";

/**
 * Recall.ai meeting bots (Zoom, Teams, Meet), EU region by default: https://eu-central-1.recall.ai/api/v1
 *   POST /bot/                      create (bot_name, meeting_url, join_at, chat.on_bot_join, recording_config, automatic_leave)
 *   GET  /bot/{id}/                 status_changes, recordings[].media_shortcuts
 *   POST /bot/{id}/leave_call/      leave
 *   POST /bot/{id}/send_chat_message/  { to: "everyone", message }
 * Auth: `Authorization: Token <RECALL_API_KEY>`. Webhooks (status + real-time endpoints) are signed with the
 * workspace verification secret using Standard Webhooks/Svix headers → verified with RECALL_WEBHOOK_SECRET.
 * Docs: https://docs.recall.ai/reference/bot_create
 */
export interface RecallOptions {
  apiKey: string;
  region?: string;
  baseUrl?: string;
  webhookSecret?: string;
  /** Dev only: accept unsigned webhooks when no secret is configured. */
  allowUnsignedWebhooks?: boolean;
  usage?: UsageSink;
  meter?: { workspaceId?: string; projectId?: string };
  price?: BotPrice;
  fetch?: FetchLike;
}

const StatusChange = z.object({ code: z.string(), sub_code: z.string().nullish(), created_at: z.string().optional() });
const Recording = z
  .object({
    id: z.string(),
    media_shortcuts: z
      .object({
        transcript: z.object({ data: z.object({ download_url: z.string().nullish() }).nullish() }).nullish(),
        video_mixed: z.object({ data: z.object({ download_url: z.string().nullish() }).nullish() }).nullish(),
        audio_mixed: z.object({ data: z.object({ download_url: z.string().nullish() }).nullish() }).nullish(),
      })
      .nullish(),
  })
  .passthrough();
const BotSchema = z
  .object({
    id: z.string(),
    status_changes: z.array(StatusChange).default([]),
    recordings: z.array(Recording).default([]),
  })
  .passthrough();

const RecallWord = z.object({
  text: z.string(),
  start_timestamp: z.object({ relative: z.number() }).nullish(),
  end_timestamp: z.object({ relative: z.number() }).nullish(),
});
const TranscriptDownload = z.array(z.object({ participant: z.object({ id: z.union([z.number(), z.string()]).optional(), name: z.string().nullish() }).nullish(), words: z.array(RecallWord) }));

const STATUS: Record<string, BotStatus> = {
  ready: "scheduled",
  joining_call: "joining",
  in_waiting_room: "waiting_room",
  in_call_not_recording: "in_call",
  recording_permission_allowed: "in_call",
  recording_permission_denied: "in_call",
  in_call_recording: "recording",
  call_ended: "left",
  done: "done",
  analysis_done: "done",
  media_expired: "done",
  fatal: "error",
};

export function mapRecallStatus(code: string): BotStatus {
  return STATUS[code] ?? "joining";
}

export class RecallMeetingBotProvider implements MeetingBotProvider {
  readonly name = "recall";
  readonly isMock = false;
  readonly postsConsentOnJoin = true;
  readonly supportsScheduledJoin = true;
  private readonly base: string;
  private readonly price: BotPrice;
  private metered = new Set<string>();
  private readonly langs = new Map<string, string>();
  constructor(private readonly o: RecallOptions) {
    if (!o.apiKey) throw new ForgeError("BAD_INPUT", "RecallMeetingBotProvider requires RECALL_API_KEY");
    this.base = (o.baseUrl ?? `https://${o.region ?? "eu-central-1"}.recall.ai/api/v1`).replace(/\/$/, "");
    this.price = o.price ?? BOT_PRICES.recall;
  }

  private req<T>(path: string, init: RequestInit, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    return fetchJson(
      "recall",
      `${this.base}${path}`,
      { ...init, headers: { Authorization: `Token ${this.o.apiKey}`, "Content-Type": "application/json", Accept: "application/json", ...(init.headers as Record<string, string> | undefined) } },
      schema,
      this.o.fetch,
    );
  }

  estimate(hours: number): CostEstimate {
    return botEstimate(this.price, hours);
  }

  async join(opts: JoinOptions): Promise<JoinResult> {
    const j = JoinOptionsSchema.parse(opts);
    const body: Record<string, unknown> = {
      meeting_url: j.meetingUrl,
      bot_name: j.botName,
      chat: { on_bot_join: { send_to: "everyone", message: j.consentMessage ?? consentMessage(j.botName) } },
      recording_config: {
        transcript: { provider: { recallai_streaming: { language_code: j.language, mode: "prioritize_accuracy" } } },
        realtime_endpoints: j.webhookUrl ? [{ type: "webhook", url: j.webhookUrl, events: ["transcript.data", "participant_events.chat_message"] }] : [],
      },
      automatic_leave: { waiting_room_timeout: 600, noone_joined_timeout: 600, everyone_left_timeout: { timeout: 30 } },
      metadata: { created_by: "forge" },
    };
    if (j.joinAt) body.join_at = new Date(j.joinAt).toISOString();
    const r = await this.req("/bot/", { method: "POST", body: JSON.stringify(body) }, BotSchema);
    this.langs.set(r.id, j.language);
    const last = r.status_changes[r.status_changes.length - 1];
    return { botId: r.id, status: last ? mapRecallStatus(last.code) : j.joinAt ? "scheduled" : "joining" };
  }

  async leave(botId: string): Promise<void> {
    await this.req(`/bot/${encodeURIComponent(botId)}/leave_call/`, { method: "POST", body: "{}" }, z.unknown());
  }

  async sendChatMessage(botId: string, text: string): Promise<void> {
    await this.req(`/bot/${encodeURIComponent(botId)}/send_chat_message/`, { method: "POST", body: JSON.stringify({ to: "everyone", message: text.slice(0, 4000) }) }, z.unknown());
  }

  private getBot(botId: string) {
    return this.req(`/bot/${encodeURIComponent(botId)}/`, { method: "GET" }, BotSchema);
  }

  async getStatus(botId: string): Promise<BotStatusInfo> {
    const b = await this.getBot(botId);
    const last = b.status_changes[b.status_changes.length - 1];
    const status = last ? mapRecallStatus(last.code) : "scheduled";
    const info: BotStatusInfo = { botId, status };
    if (last) info.rawStatus = last.sub_code ? `${last.code}:${last.sub_code}` : last.code;
    if (last?.created_at) info.updatedAt = last.created_at;
    if (status === "error") info.error = last?.sub_code ?? "fatal";
    if ((status === "done" || status === "left") && !this.metered.has(botId)) {
      // Billable time: from entering the call until it ended.
      const startC = b.status_changes.find((c) => c.code.startsWith("in_call"))?.created_at;
      const endC = (b.status_changes.find((c) => c.code === "call_ended") ?? b.status_changes.find((c) => c.code === "done"))?.created_at;
      if (startC && endC) {
        this.metered.add(botId);
        await recordBotHours(this.o.usage, this.price, Math.max(0, Date.parse(endC) - Date.parse(startC)) / 3_600_000, this.o.meter);
      }
    }
    return info;
  }

  async getTranscript(botId: string): Promise<Transcript> {
    const b = await this.getBot(botId);
    const url = b.recordings.map((r) => r.media_shortcuts?.transcript?.data?.download_url).find(Boolean);
    if (!url) throw new ForgeError("NOT_FOUND", `Recall bot ${botId} has no transcript yet`);
    const parts = await fetchJson("recall", url, { method: "GET" }, TranscriptDownload, this.o.fetch);
    const segments: TranscriptSegment[] = [];
    const words: NonNullable<Transcript["words"]> = [];
    for (const p of parts) {
      if (!p.words.length) continue;
      const speaker = p.participant?.name ?? (p.participant?.id !== undefined ? `Participant ${p.participant.id}` : undefined);
      const start = p.words[0]?.start_timestamp?.relative ?? 0;
      const end = p.words[p.words.length - 1]?.end_timestamp?.relative ?? start;
      const seg: TranscriptSegment = { start, end, text: p.words.map((w) => w.text).join(" ").replace(/\s+([.,!?])/g, "$1") };
      if (speaker) seg.speaker = speaker;
      segments.push(seg);
      for (const w of p.words) {
        const word = { text: w.text, start: w.start_timestamp?.relative ?? start, end: w.end_timestamp?.relative ?? end } as NonNullable<Transcript["words"]>[number];
        if (speaker) word.speaker = speaker;
        words.push(word);
      }
    }
    return {
      text: segments.map((s) => s.text).join(" "),
      language: this.langs.get(botId) ?? "und",
      durationSec: segments.length ? (segments[segments.length - 1]?.end ?? 0) : 0,
      segments,
      words,
      provider: "recall",
      model: "recallai_streaming",
    };
  }

  async getRecordingUrl(botId: string): Promise<string | null> {
    const b = await this.getBot(botId);
    for (const r of b.recordings) {
      const u = r.media_shortcuts?.audio_mixed?.data?.download_url ?? r.media_shortcuts?.video_mixed?.data?.download_url;
      if (u) return u;
    }
    return null;
  }

  async parseWebhook(headers: WebhookHeaders, body: string | Uint8Array): Promise<MeetingEvent[]> {
    const raw = bodyText(body);
    if (this.o.webhookSecret) verifyStandardWebhook(headers, raw, this.o.webhookSecret);
    else if (!this.o.allowUnsignedWebhooks) throw new ForgeError("UNAUTHORIZED", "RECALL_WEBHOOK_SECRET not configured; refusing unsigned webhook");
    return parseRecallPayload(JSON.parse(raw) as unknown);
  }
}

const Payload = z.object({ event: z.string(), data: z.record(z.unknown()).default({}) }).passthrough();
const Inner = z
  .object({
    bot: z.object({ id: z.string() }).nullish(),
    bot_id: z.string().nullish(),
    data: z.unknown().optional(),
    status: z.object({ code: z.string(), sub_code: z.string().nullish(), created_at: z.string().optional() }).nullish(),
    recording: z.object({ id: z.string() }).nullish(),
  })
  .passthrough();
const RtTranscript = z.object({ words: z.array(RecallWord), participant: z.object({ name: z.string().nullish() }).nullish() });
const RtChat = z.object({
  participant: z.object({ name: z.string().nullish() }).nullish(),
  data: z.object({ text: z.string() }),
  timestamp: z.object({ absolute: z.string().optional() }).nullish(),
});
const StatusData = z.object({ code: z.string(), sub_code: z.string().nullish(), updated_at: z.string().optional() });

/** Real-time payloads carry the event object at data.data; tolerate one extra level of nesting. */
function parseEither<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, v: unknown): { success: true; data: T } | { success: false } {
  const a = schema.safeParse(v);
  if (a.success) return { success: true, data: a.data };
  const b = schema.safeParse((v as { data?: unknown } | undefined)?.data);
  return b.success ? { success: true, data: b.data } : { success: false };
}

/** Normalize Recall status webhooks (bot.<code>, legacy bot.status_change) and real-time events. */
export function parseRecallPayload(json: unknown): MeetingEvent[] {
  const p = Payload.safeParse(json);
  if (!p.success) throw new ForgeError("BAD_INPUT", "Unrecognized Recall webhook payload");
  const inner = Inner.parse(p.data.data);
  const botId = inner.bot?.id ?? inner.bot_id;
  if (!botId) return [];
  const now = new Date().toISOString();
  const ev = p.data.event;
  let code: string | undefined;
  let at = now;
  let sub: string | undefined;
  if (ev === "bot.status_change" && inner.status) {
    code = inner.status.code;
    at = inner.status.created_at ?? now;
    sub = inner.status.sub_code ?? undefined;
  } else if (ev.startsWith("bot.")) {
    const d = StatusData.safeParse(inner.data);
    code = d.success ? d.data.code : ev.slice(4);
    if (d.success && d.data.updated_at) at = d.data.updated_at;
    if (d.success && d.data.sub_code) sub = d.data.sub_code;
  }
  if (code) {
    const s = mapRecallStatus(code);
    if (s === "joining") return [{ type: "bot.joining", botId, at }];
    if (s === "in_call" || s === "recording") return [{ type: "bot.in_call", botId, at, recording: s === "recording" }];
    if (s === "left" || s === "done") return [sub ? { type: "bot.left", botId, at, reason: sub } : { type: "bot.left", botId, at }];
    if (s === "error") return [{ type: "bot.error", botId, at, code: sub ?? code, message: `Recall bot fatal: ${sub ?? code}` }];
    return [];
  }
  if (ev === "transcript.data") {
    const d = parseEither(RtTranscript, inner.data);
    if (!d.success || !d.data.words.length) return [];
    const w = d.data.words;
    const segment: TranscriptSegment = {
      start: w[0]?.start_timestamp?.relative ?? 0,
      end: w[w.length - 1]?.end_timestamp?.relative ?? 0,
      text: w.map((x) => x.text).join(" "),
    };
    if (d.data.participant?.name) segment.speaker = d.data.participant.name;
    return [{ type: "transcript.segment", botId, at: now, segment }];
  }
  if (ev === "participant_events.chat_message") {
    const d = parseEither(RtChat, inner.data);
    if (!d.success) return [];
    return [{ type: "chat.message", botId, at: d.data.timestamp?.absolute ?? now, sender: d.data.participant?.name ?? "unknown", text: d.data.data.text }];
  }
  if (ev === "recording.done") {
    return [inner.recording ? { type: "recording.ready", botId, at: now, recordingId: inner.recording.id } : { type: "recording.ready", botId, at: now }];
  }
  return [];
}
