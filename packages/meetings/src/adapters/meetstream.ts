import { z } from "zod";
import { ForgeError, type CostEstimate, type UsageSink } from "@forge/shared";
import type { Transcript, TranscriptSegment } from "@forge/speech";
import { JoinOptionsSchema, type BotStatus, type BotStatusInfo, type JoinOptions, type JoinResult, type MeetingBotProvider, type MeetingEvent, type WebhookHeaders } from "../types.js";
import { consentMessage } from "../consent.js";
import { BOT_PRICES, botEstimate, recordBotHours, type BotPrice } from "../pricing.js";
import { verifyUrlToken, withUrlToken } from "../webhook-sig.js";
import { bodyText, fetchJson, type FetchLike } from "./http.js";

/**
 * MeetStream.ai meeting bots (https://docs.meetstream.ai). Endpoints as documented publicly; the ones marked
 * (assumed) were not verifiable from this environment and are isolated here:
 *   POST {base}/bots/create_bot        { meeting_link, bot_name, bot_message, audio_required, video_required, callback_url,
 *                                        live_transcription_required: { webhook_url } }  → { bot_id }
 *   GET  {base}/bots/{id}/status       → { status }
 *   GET  {base}/bots/{id}/remove_bot   leave
 *   GET  {base}/bots/{id}/get_transcript → transcript entries (shape parsed leniently)
 *   GET  {base}/bots/{id}/get_audio    → { audio_url } (assumed field name)
 *   POST {base}/bots/{id}/send_message { message }  (assumed)
 * base = https://api.meetstream.ai/api/v1, `Authorization: Token <MEETSTREAM_API_KEY>`.
 * MeetStream does not sign callbacks: Forge adds `forge_token` to callback URLs (see webhook-sig.ts).
 * `bot_message` makes MeetStream post the consent notice when the bot joins.
 */
export interface MeetStreamOptions {
  apiKey: string;
  baseUrl?: string;
  webhookSecret?: string;
  allowUnsignedWebhooks?: boolean;
  usage?: UsageSink;
  meter?: { workspaceId?: string; projectId?: string };
  price?: BotPrice;
  fetch?: FetchLike;
}

const CreateResp = z.object({ bot_id: z.string() }).passthrough();
const StatusResp = z.object({ status: z.string() }).passthrough();
const Entry = z
  .object({
    speaker: z.string().nullish(),
    speakerName: z.string().nullish(),
    text: z.string().nullish(),
    transcript: z.string().nullish(),
    start: z.number().nullish(),
    end: z.number().nullish(),
    start_time: z.number().nullish(),
    end_time: z.number().nullish(),
  })
  .passthrough();
const TranscriptResp = z
  .union([z.array(Entry), z.object({ transcript: z.array(Entry) }), z.object({ segments: z.array(Entry) })])
  .transform((r): Array<z.infer<typeof Entry>> => (Array.isArray(r) ? r : "transcript" in r ? r.transcript : r.segments));
const AudioResp = z.object({ audio_url: z.string().nullish(), url: z.string().nullish() }).passthrough();

export function mapMeetStreamStatus(s: string): BotStatus {
  const k = s.toLowerCase().replace(/[\s_-]/g, "");
  if (/^(joining|starting|created|queued)$/.test(k)) return "joining";
  if (/^(waiting|waitingroom|lobby)$/.test(k)) return "waiting_room";
  if (/^(inmeeting|joined|recording|active|incall)$/.test(k)) return "recording";
  if (/^(stopped|left|ended|completed|removed|done)$/.test(k)) return "done";
  if (/^(denied|notallowed|failed|error|kicked)$/.test(k)) return "error";
  return "joining";
}

export class MeetStreamMeetingBotProvider implements MeetingBotProvider {
  readonly name = "meetstream";
  readonly isMock = false;
  readonly postsConsentOnJoin = true;
  readonly supportsScheduledJoin = false;
  private readonly base: string;
  private readonly price: BotPrice;
  private readonly langs = new Map<string, string>();
  private metered = new Set<string>();
  constructor(private readonly o: MeetStreamOptions) {
    if (!o.apiKey) throw new ForgeError("BAD_INPUT", "MeetStreamMeetingBotProvider requires MEETSTREAM_API_KEY");
    this.base = (o.baseUrl ?? "https://api.meetstream.ai/api/v1").replace(/\/$/, "");
    this.price = o.price ?? BOT_PRICES.meetstream;
  }

  private req<T>(path: string, init: RequestInit, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    return fetchJson("meetstream", `${this.base}${path}`, { ...init, headers: { Authorization: `Token ${this.o.apiKey}`, "Content-Type": "application/json" } }, schema, this.o.fetch);
  }

  estimate(hours: number): CostEstimate {
    return botEstimate(this.price, hours);
  }

  async join(opts: JoinOptions): Promise<JoinResult> {
    const j = JoinOptionsSchema.parse(opts);
    if (j.joinAt && new Date(j.joinAt).getTime() > Date.now() + 5_000) {
      throw new ForgeError("BAD_INPUT", "MeetStream joins immediately; enqueue the join for joinAt instead");
    }
    const body: Record<string, unknown> = {
      meeting_link: j.meetingUrl,
      bot_name: j.botName,
      bot_message: j.consentMessage ?? consentMessage(j.botName),
      audio_required: true,
      video_required: false,
    };
    if (j.webhookUrl) {
      const cb = withUrlToken(j.webhookUrl, this.o.webhookSecret, "meetstream");
      body.callback_url = cb;
      body.live_transcription_required = { webhook_url: cb };
    }
    const r = await this.req("/bots/create_bot", { method: "POST", body: JSON.stringify(body) }, CreateResp);
    this.langs.set(r.bot_id, j.language);
    return { botId: r.bot_id, status: "joining" };
  }

  async leave(botId: string): Promise<void> {
    await this.req(`/bots/${encodeURIComponent(botId)}/remove_bot`, { method: "GET" }, z.unknown());
  }

  async sendChatMessage(botId: string, text: string): Promise<void> {
    await this.req(`/bots/${encodeURIComponent(botId)}/send_message`, { method: "POST", body: JSON.stringify({ message: text }) }, z.unknown());
  }

  async getStatus(botId: string): Promise<BotStatusInfo> {
    const r = await this.req(`/bots/${encodeURIComponent(botId)}/status`, { method: "GET" }, StatusResp);
    return { botId, status: mapMeetStreamStatus(r.status), rawStatus: r.status };
  }

  async getTranscript(botId: string): Promise<Transcript> {
    const entries = await this.req(`/bots/${encodeURIComponent(botId)}/get_transcript`, { method: "GET" }, TranscriptResp);
    const segments: TranscriptSegment[] = [];
    for (const e of entries) {
      const text = (e.text ?? e.transcript ?? "").trim();
      if (!text) continue;
      const start = e.start ?? e.start_time ?? 0;
      const seg: TranscriptSegment = { start, end: e.end ?? e.end_time ?? start, text };
      const sp = e.speaker ?? e.speakerName;
      if (sp) seg.speaker = sp;
      segments.push(seg);
    }
    const durationSec = segments.reduce((a, s) => Math.max(a, s.end), 0);
    if (!this.metered.has(botId) && durationSec > 0) {
      // MeetStream's status API has no timestamps; bill the transcript span (≈ time in call).
      this.metered.add(botId);
      await recordBotHours(this.o.usage, this.price, durationSec / 3600, this.o.meter);
    }
    return { text: segments.map((s) => s.text).join(" "), language: this.langs.get(botId) ?? "und", durationSec, segments, provider: "meetstream", model: "meetstream" };
  }

  async getRecordingUrl(botId: string): Promise<string | null> {
    const r = await this.req(`/bots/${encodeURIComponent(botId)}/get_audio`, { method: "GET" }, AudioResp);
    return r.audio_url ?? r.url ?? null;
  }

  async parseWebhook(headers: WebhookHeaders, body: string | Uint8Array): Promise<MeetingEvent[]> {
    if (this.o.webhookSecret) verifyUrlToken(headers, this.o.webhookSecret, "meetstream");
    else if (!this.o.allowUnsignedWebhooks) throw new ForgeError("UNAUTHORIZED", "MEETSTREAM_WEBHOOK_SECRET not configured; refusing unauthenticated webhook");
    return parseMeetStreamPayload(JSON.parse(bodyText(body)) as unknown);
  }
}

const Hook = z
  .object({
    bot_id: z.string(),
    event: z.string().optional(),
    status: z.string().optional(),
    message: z.string().nullish(),
    sender: z.string().nullish(),
    speaker: z.string().nullish(),
    transcript: z.string().nullish(),
    text: z.string().nullish(),
    start: z.number().nullish(),
    end: z.number().nullish(),
    timestamp: z.string().nullish(),
  })
  .passthrough();

export function parseMeetStreamPayload(json: unknown): MeetingEvent[] {
  const h = Hook.safeParse(json);
  if (!h.success) throw new ForgeError("BAD_INPUT", "Unrecognized MeetStream webhook payload");
  const d = h.data;
  const at = d.timestamp ?? new Date().toISOString();
  const ev = (d.event ?? "").toLowerCase();
  if (ev.includes("chat") && (d.message || d.text)) return [{ type: "chat.message", botId: d.bot_id, at, sender: d.sender ?? d.speaker ?? "unknown", text: (d.message ?? d.text) as string }];
  const text = d.transcript ?? (ev.includes("transcri") ? d.text : undefined);
  if (text) {
    const seg: TranscriptSegment = { start: d.start ?? 0, end: d.end ?? d.start ?? 0, text };
    if (d.speaker) seg.speaker = d.speaker;
    return [{ type: "transcript.segment", botId: d.bot_id, at, segment: seg }];
  }
  if (ev.includes("audio") || ev.includes("recording")) return [{ type: "recording.ready", botId: d.bot_id, at }];
  const status = d.status ?? ev.replace(/^bot\./, "");
  if (!status) return [];
  const s = mapMeetStreamStatus(status);
  if (s === "joining" || s === "waiting_room") return [{ type: "bot.joining", botId: d.bot_id, at }];
  if (s === "recording" || s === "in_call") return [{ type: "bot.in_call", botId: d.bot_id, at, recording: true }];
  if (s === "done" || s === "left") return [{ type: "bot.left", botId: d.bot_id, at, reason: status }];
  return [{ type: "bot.error", botId: d.bot_id, at, code: status, message: d.message ?? `MeetStream bot ${status}` }];
}
