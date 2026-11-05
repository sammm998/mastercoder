import { z } from "zod";
import { ForgeError, type CostEstimate, type UsageSink } from "@forge/shared";
import type { Transcript, TranscriptSegment } from "@forge/speech";
import { JoinOptionsSchema, type BotStatus, type BotStatusInfo, type JoinOptions, type JoinResult, type MeetingBotProvider, type MeetingEvent, type MeetingPlatform, type WebhookHeaders } from "../types.js";
import { parseMeetingUrl } from "../url.js";
import { BOT_PRICES, botEstimate, recordBotHours, type BotPrice } from "../pricing.js";
import { verifyUrlToken } from "../webhook-sig.js";
import { bodyText, fetchJson, type FetchLike } from "./http.js";

/**
 * Vexa (self-hosted, open source; https://github.com/Vexa-ai/vexa) — keeps meeting audio on Forge's EU servers.
 *   POST   {VEXA_URL}/bots                                 { platform, native_meeting_id, bot_name, language, passcode? }
 *   DELETE {VEXA_URL}/bots/{platform}/{native_meeting_id}  stop
 *   GET    {VEXA_URL}/meetings                             → { meetings: [{ platform, native_meeting_id, status, start_time, end_time }] }
 *   GET    {VEXA_URL}/transcripts/{platform}/{native_meeting_id} → { segments: [{ start, end, text, speaker, language }] }
 *   POST   {VEXA_URL}/bots/{platform}/{native_meeting_id}/chat   { text }   (assumed; Vexa ≥ 0.6 chat API)
 *   PUT    {VEXA_URL}/user/webhook                         { webhook_url }  (account-level status webhook)
 * Auth header: X-API-Key. Bot id = "<platform>:<native_meeting_id>". Vexa does not post the consent notice itself,
 * so ConsentGuard posts it via sendChatMessage once the bot is in the call. No scheduled joins; no stored recording.
 */
export interface VexaOptions {
  baseUrl: string;
  apiKey: string;
  webhookSecret?: string;
  allowUnsignedWebhooks?: boolean;
  usage?: UsageSink;
  meter?: { workspaceId?: string; projectId?: string };
  price?: BotPrice;
  fetch?: FetchLike;
}

const MeetingSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    platform: z.string(),
    native_meeting_id: z.string(),
    status: z.string(),
    start_time: z.string().nullish(),
    end_time: z.string().nullish(),
  })
  .passthrough();
const MeetingsResp = z.object({ meetings: z.array(MeetingSchema) });
const TranscriptResp = z
  .object({
    segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string(), speaker: z.string().nullish(), language: z.string().nullish() }).passthrough()),
  })
  .passthrough();

export function mapVexaStatus(s: string): BotStatus {
  switch (s.toLowerCase()) {
    case "requested":
    case "joining":
      return "joining";
    case "awaiting_admission":
      return "waiting_room";
    case "active":
      return "recording";
    case "stopping":
      return "left";
    case "completed":
      return "done";
    case "failed":
      return "error";
    default:
      return "joining";
  }
}

export function vexaBotId(platform: MeetingPlatform, nativeId: string): string {
  return `${platform}:${nativeId}`;
}

function splitBotId(botId: string): { platform: string; nativeId: string } {
  const i = botId.indexOf(":");
  if (i <= 0) throw new ForgeError("BAD_INPUT", `Invalid Vexa bot id ${botId}`);
  return { platform: botId.slice(0, i), nativeId: botId.slice(i + 1) };
}

export class VexaMeetingBotProvider implements MeetingBotProvider {
  readonly name = "vexa";
  readonly isMock = false;
  readonly postsConsentOnJoin = false;
  readonly supportsScheduledJoin = false;
  private readonly base: string;
  private readonly price: BotPrice;
  private metered = new Set<string>();
  constructor(private readonly o: VexaOptions) {
    if (!o.baseUrl) throw new ForgeError("BAD_INPUT", "VexaMeetingBotProvider requires VEXA_URL");
    if (!o.apiKey) throw new ForgeError("BAD_INPUT", "VexaMeetingBotProvider requires VEXA_API_KEY");
    this.base = o.baseUrl.replace(/\/$/, "");
    this.price = o.price ?? BOT_PRICES.vexa;
  }

  private req<T>(path: string, init: RequestInit, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    return fetchJson("vexa", `${this.base}${path}`, { ...init, headers: { "X-API-Key": this.o.apiKey, "Content-Type": "application/json" } }, schema, this.o.fetch);
  }

  private path(botId: string): string {
    const { platform, nativeId } = splitBotId(botId);
    return `${encodeURIComponent(platform)}/${encodeURIComponent(nativeId)}`;
  }

  estimate(hours: number): CostEstimate {
    return botEstimate(this.price, hours);
  }

  async join(opts: JoinOptions): Promise<JoinResult> {
    const j = JoinOptionsSchema.parse(opts);
    if (j.joinAt && new Date(j.joinAt).getTime() > Date.now() + 5_000) {
      throw new ForgeError("BAD_INPUT", "Vexa joins immediately; enqueue the join for joinAt instead");
    }
    const m = parseMeetingUrl(j.meetingUrl);
    const body: Record<string, unknown> = { platform: m.platform, native_meeting_id: m.nativeId, bot_name: j.botName, language: j.language };
    if (m.passcode) body.passcode = m.passcode;
    const r = await this.req("/bots", { method: "POST", body: JSON.stringify(body) }, MeetingSchema);
    return { botId: vexaBotId(m.platform, m.nativeId), status: mapVexaStatus(r.status) };
  }

  /** Register the account-level status webhook (call once per deployment). */
  async setWebhook(url: string): Promise<void> {
    await this.req("/user/webhook", { method: "PUT", body: JSON.stringify({ webhook_url: url }) }, z.unknown());
  }

  async leave(botId: string): Promise<void> {
    await this.req(`/bots/${this.path(botId)}`, { method: "DELETE" }, z.unknown());
  }

  async sendChatMessage(botId: string, text: string): Promise<void> {
    await this.req(`/bots/${this.path(botId)}/chat`, { method: "POST", body: JSON.stringify({ text }) }, z.unknown());
  }

  async getStatus(botId: string): Promise<BotStatusInfo> {
    const { platform, nativeId } = splitBotId(botId);
    const r = await this.req("/meetings", { method: "GET" }, MeetingsResp);
    // Latest meeting row for this native id.
    const m = r.meetings.filter((x) => x.platform === platform && x.native_meeting_id === nativeId).pop();
    if (!m) throw new ForgeError("NOT_FOUND", `Vexa has no meeting ${botId}`);
    const status = mapVexaStatus(m.status);
    if (status === "done" && m.start_time && m.end_time && !this.metered.has(botId)) {
      this.metered.add(botId);
      await recordBotHours(this.o.usage, this.price, Math.max(0, Date.parse(m.end_time) - Date.parse(m.start_time)) / 3_600_000, this.o.meter);
    }
    const info: BotStatusInfo = { botId, status, rawStatus: m.status };
    if (m.end_time ?? m.start_time) info.updatedAt = (m.end_time ?? m.start_time) as string;
    return info;
  }

  async getTranscript(botId: string): Promise<Transcript> {
    const r = await this.req(`/transcripts/${this.path(botId)}`, { method: "GET" }, TranscriptResp);
    const segments: TranscriptSegment[] = r.segments
      .filter((s) => s.text.trim())
      .map((s) => (s.speaker ? { start: s.start, end: s.end, text: s.text.trim(), speaker: s.speaker } : { start: s.start, end: s.end, text: s.text.trim() }));
    return {
      text: segments.map((s) => s.text).join(" "),
      language: r.segments.find((s) => s.language)?.language ?? "und",
      durationSec: segments.reduce((a, s) => Math.max(a, s.end), 0),
      segments,
      provider: "vexa",
      model: "whisper",
    };
  }

  async getRecordingUrl(): Promise<string | null> {
    return null; // Vexa streams audio to its transcriber and does not keep a recording.
  }

  async parseWebhook(headers: WebhookHeaders, body: string | Uint8Array): Promise<MeetingEvent[]> {
    if (this.o.webhookSecret) verifyUrlToken(headers, this.o.webhookSecret, "vexa");
    else if (!this.o.allowUnsignedWebhooks) throw new ForgeError("UNAUTHORIZED", "VEXA_WEBHOOK_SECRET not configured; refusing unauthenticated webhook");
    const json = JSON.parse(bodyText(body)) as { meeting?: unknown } & Record<string, unknown>;
    const m = MeetingSchema.safeParse(json.meeting ?? json);
    if (!m.success) throw new ForgeError("BAD_INPUT", "Unrecognized Vexa webhook payload");
    const botId = `${m.data.platform}:${m.data.native_meeting_id}`;
    const at = m.data.end_time ?? m.data.start_time ?? new Date().toISOString();
    const s = mapVexaStatus(m.data.status);
    if (s === "joining" || s === "waiting_room") return [{ type: "bot.joining", botId, at }];
    if (s === "recording") return [{ type: "bot.in_call", botId, at, recording: true }];
    if (s === "left" || s === "done") return [{ type: "bot.left", botId, at, reason: m.data.status }];
    return [{ type: "bot.error", botId, at, code: m.data.status, message: `Vexa meeting ${m.data.status}` }];
  }
}
