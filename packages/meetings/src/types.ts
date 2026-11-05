import { z } from "zod";
import type { CostEstimate } from "@forge/shared";
import { TranscriptSegmentSchema, type Transcript } from "@forge/speech";
import type { Extraction, MeetingSpec } from "./schemas.js";

export type MeetingPlatform = "zoom" | "teams" | "google_meet";

export interface ParsedMeetingUrl {
  platform: MeetingPlatform;
  /** Zoom meeting number / personal link name, Meet code (abc-defg-hij), Teams thread id or numeric meeting id. */
  nativeId: string;
  passcode?: string;
  /** Normalized https URL. */
  url: string;
}

export type BotStatus = "scheduled" | "joining" | "waiting_room" | "in_call" | "recording" | "left" | "done" | "error";

export const JoinOptionsSchema = z.object({
  meetingUrl: z.string().url(),
  /** Always visible to participants. Never empty. */
  botName: z.string().trim().min(1).max(100).default("Forge notetaker"),
  /** Posted in the meeting chat on join. Defaults to the bilingual sv+en recording notice. */
  consentMessage: z.string().trim().min(1).max(4000).optional(),
  language: z.string().min(2).max(16).default("sv"),
  webhookUrl: z.string().url().optional(),
  joinAt: z.union([z.date(), z.string().datetime()]).optional(),
});
export type JoinOptions = z.input<typeof JoinOptionsSchema>;
export type ResolvedJoinOptions = z.output<typeof JoinOptionsSchema>;

export interface JoinResult {
  botId: string;
  status: BotStatus;
}

export interface BotStatusInfo {
  botId: string;
  status: BotStatus;
  /** Vendor's raw status code. */
  rawStatus?: string;
  updatedAt?: string;
  error?: string;
}

const at = z.string();
export const MeetingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bot.joining"), botId: z.string(), at }),
  z.object({ type: z.literal("bot.in_call"), botId: z.string(), at, recording: z.boolean() }),
  z.object({ type: z.literal("bot.left"), botId: z.string(), at, reason: z.string().optional() }),
  z.object({ type: z.literal("transcript.segment"), botId: z.string(), at, segment: TranscriptSegmentSchema }),
  z.object({ type: z.literal("chat.message"), botId: z.string(), at, sender: z.string(), text: z.string() }),
  z.object({ type: z.literal("recording.ready"), botId: z.string(), at, recordingId: z.string().optional() }),
  z.object({ type: z.literal("bot.error"), botId: z.string(), at, code: z.string().optional(), message: z.string() }),
]);
export type MeetingEvent = z.infer<typeof MeetingEventSchema>;

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface MeetingBotProvider {
  readonly name: string;
  readonly isMock: boolean;
  /** True when the vendor posts `consentMessage` in chat itself on join (otherwise ConsentGuard posts it). */
  readonly postsConsentOnJoin: boolean;
  /** True when join({ joinAt }) schedules a future join at the vendor; otherwise callers join at joinAt themselves. */
  readonly supportsScheduledJoin: boolean;
  join(opts: JoinOptions): Promise<JoinResult>;
  leave(botId: string): Promise<void>;
  getStatus(botId: string): Promise<BotStatusInfo>;
  sendChatMessage(botId: string, text: string): Promise<void>;
  getTranscript(botId: string): Promise<Transcript>;
  getRecordingUrl(botId: string): Promise<string | null>;
  /** Verify (where the vendor signs) and normalize a webhook delivery. Throws ForgeError(UNAUTHORIZED) on a bad signature. */
  parseWebhook(headers: WebhookHeaders, body: string | Uint8Array): Promise<MeetingEvent[]>;
  estimate(hours: number): CostEstimate;
}

export type MeetingStatus = "scheduled" | "joining" | "recording" | "processing" | "awaiting_approval" | "approved" | "ready" | "failed" | "deleted";

export interface MeetingRecord {
  id: string;
  workspaceId: string;
  projectId?: string;
  source: "bot" | "recording" | "upload";
  provider?: string;
  externalBotId?: string;
  meetingUrl?: string;
  title?: string;
  language: string;
  status: MeetingStatus;
  consentNoticePosted: boolean;
  /** Set when a participant asked the bot to stop/leave. */
  stopRequest?: { by: string; text: string; at: string };
  transcript?: Transcript;
  extraction?: Extraction;
  spec?: MeetingSpec;
  audioKey?: string;
  /** Per-kind retention deadlines (ISO). */
  retention: { audio?: string; transcript?: string; extraction?: string };
  createdAt: string;
  deletedAt?: string;
}

export interface MeetingRepo {
  create(m: MeetingRecord): Promise<MeetingRecord>;
  get(id: string): Promise<MeetingRecord | null>;
  update(id: string, patch: Partial<MeetingRecord>): Promise<MeetingRecord>;
  findByBotId(botId: string): Promise<MeetingRecord | null>;
  /** Meetings with at least one retention deadline <= now that still hold that data. */
  listExpired(now: Date): Promise<MeetingRecord[]>;
}
