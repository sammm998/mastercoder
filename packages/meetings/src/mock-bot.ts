import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ForgeError, newId, type CostEstimate, type UsageSink } from "@forge/shared";
import type { Transcript } from "@forge/speech";
import { JoinOptionsSchema, MeetingEventSchema, type BotStatus, type BotStatusInfo, type JoinOptions, type JoinResult, type MeetingBotProvider, type MeetingEvent, type WebhookHeaders } from "./types.js";
import { consentMessage } from "./consent.js";
import { parseMeetingUrl } from "./url.js";
import { BOT_PRICES, botEstimate, recordBotHours } from "./pricing.js";

export interface Clock {
  now(): number;
}

/** Manually advanced clock for deterministic tests and demos. */
export class ManualClock implements Clock {
  constructor(private t = Date.UTC(2026, 0, 1, 9, 0, 0)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(t: number | Date): void {
    this.t = typeof t === "number" ? t : t.getTime();
  }
}

interface MockBot {
  id: string;
  meetingUrl: string;
  botName: string;
  language: string;
  consent: string;
  joinAt: number;
  status: BotStatus;
  inCallAt?: number;
  leftAt?: number;
  chat: Array<{ sender: string; text: string; at: string }>;
}

export interface MockMeetingBotOptions {
  clock?: Clock;
  /** Returned by getTranscript (e.g. a fixture). Default: a clearly labelled placeholder. */
  transcript?: Transcript;
  /** ms from joinAt until "joining" → "in_call" (default 15 s). */
  admitAfterMs?: number;
  /** Auto-leave after this many ms in the call (default: never). */
  meetingDurationMs?: number;
  webhookSecret?: string;
  usage?: UsageSink;
}

const MOCK_SIG_HEADER = "x-forge-mock-signature";
const MockWebhookBody = z.object({ events: z.array(MeetingEventSchema) });

/**
 * Simulated meeting bot. Nothing joins a real meeting: the lifecycle (scheduled → joining → in_call/recording →
 * left → done) is driven by an injectable clock via `tick()`, events go to `onEvent` listeners, and the transcript is
 * whatever fixture was injected. Use `simulateChat` to play a participant typing in the meeting chat.
 */
export class MockMeetingBotProvider implements MeetingBotProvider {
  readonly name = "mock";
  readonly isMock = true;
  readonly postsConsentOnJoin = true;
  readonly supportsScheduledJoin = true;
  readonly clock: Clock;
  readonly events: MeetingEvent[] = [];
  private bots = new Map<string, MockBot>();
  private listeners = new Set<(e: MeetingEvent) => void | Promise<void>>();
  private readonly secret: string;
  constructor(private readonly o: MockMeetingBotOptions = {}) {
    this.clock = o.clock ?? { now: () => Date.now() };
    this.secret = o.webhookSecret ?? "mock-webhook-secret";
  }

  onEvent(cb: (e: MeetingEvent) => void | Promise<void>): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private iso(t = this.clock.now()): string {
    return new Date(t).toISOString();
  }

  private async emit(e: MeetingEvent): Promise<void> {
    this.events.push(e);
    for (const l of this.listeners) await l(e);
  }

  private bot(id: string): MockBot {
    const b = this.bots.get(id);
    if (!b) throw new ForgeError("NOT_FOUND", `Mock bot ${id} not found`);
    return b;
  }

  estimate(hours: number): CostEstimate {
    return botEstimate(BOT_PRICES.mock, hours);
  }

  async join(opts: JoinOptions): Promise<JoinResult> {
    const j = JoinOptionsSchema.parse(opts);
    parseMeetingUrl(j.meetingUrl); // validates platform like the real adapters
    const id = newId("mockbot");
    const joinAt = j.joinAt ? new Date(j.joinAt).getTime() : this.clock.now();
    const b: MockBot = {
      id,
      meetingUrl: j.meetingUrl,
      botName: j.botName,
      language: j.language,
      consent: j.consentMessage ?? consentMessage(j.botName),
      joinAt,
      status: "scheduled",
      chat: [],
    };
    this.bots.set(id, b);
    await this.tick();
    return { botId: id, status: b.status };
  }

  /** Advance every bot's state machine to the clock's current time, emitting events. */
  async tick(): Promise<void> {
    const now = this.clock.now();
    for (const b of this.bots.values()) {
      if (b.status === "scheduled" && now >= b.joinAt) {
        b.status = "joining";
        await this.emit({ type: "bot.joining", botId: b.id, at: this.iso() });
      }
      if (b.status === "joining" && now >= b.joinAt + (this.o.admitAfterMs ?? 15_000)) {
        b.status = "recording";
        b.inCallAt = now;
        await this.emit({ type: "bot.in_call", botId: b.id, at: this.iso(), recording: true });
        // Like Recall's chat.on_bot_join: the notice is posted as soon as the bot is admitted.
        await this.postChat(b, b.botName, b.consent);
      }
      if (b.status === "recording" && this.o.meetingDurationMs !== undefined && b.inCallAt !== undefined && now >= b.inCallAt + this.o.meetingDurationMs) {
        await this.finish(b, "meeting_ended");
      }
    }
  }

  private async postChat(b: MockBot, sender: string, text: string): Promise<void> {
    const at = this.iso();
    b.chat.push({ sender, text, at });
    await this.emit({ type: "chat.message", botId: b.id, at, sender, text });
  }

  private async finish(b: MockBot, reason: string): Promise<void> {
    if (b.status === "left" || b.status === "done") return;
    b.status = "left";
    b.leftAt = this.clock.now();
    await this.emit({ type: "bot.left", botId: b.id, at: this.iso(), reason });
    if (b.inCallAt !== undefined) {
      await recordBotHours(this.o.usage, BOT_PRICES.mock, (b.leftAt - b.inCallAt) / 3_600_000);
      await this.emit({ type: "recording.ready", botId: b.id, at: this.iso(), recordingId: `rec_${b.id}` });
    }
    b.status = "done";
  }

  /** A participant types in the meeting chat. */
  async simulateChat(botId: string, sender: string, text: string): Promise<void> {
    const b = this.bot(botId);
    if (b.status !== "recording" && b.status !== "in_call") throw new ForgeError("BAD_INPUT", "Bot is not in the call");
    await this.postChat(b, sender, text);
  }

  chatLog(botId: string): ReadonlyArray<{ sender: string; text: string; at: string }> {
    return this.bot(botId).chat;
  }

  async leave(botId: string): Promise<void> {
    const b = this.bot(botId);
    if (b.status === "scheduled" || b.status === "joining") {
      b.status = "done";
      await this.emit({ type: "bot.left", botId, at: this.iso(), reason: "cancelled" });
      return;
    }
    await this.finish(b, "requested");
  }

  async getStatus(botId: string): Promise<BotStatusInfo> {
    await this.tick();
    const b = this.bot(botId);
    return { botId, status: b.status, rawStatus: b.status, updatedAt: this.iso() };
  }

  async sendChatMessage(botId: string, text: string): Promise<void> {
    const b = this.bot(botId);
    if (b.status !== "recording" && b.status !== "in_call") throw new ForgeError("BAD_INPUT", "Bot is not in the call");
    await this.postChat(b, b.botName, text);
  }

  async getTranscript(botId: string): Promise<Transcript> {
    const b = this.bot(botId);
    if (this.o.transcript) return { ...this.o.transcript, language: this.o.transcript.language || b.language };
    const text = "[mock meeting transcript: no fixture injected]";
    return { text, language: b.language, durationSec: 0, segments: [{ start: 0, end: 0, text }], provider: "mock", model: "mock-bot" };
  }

  async getRecordingUrl(botId: string): Promise<string | null> {
    const b = this.bot(botId);
    return b.status === "done" ? `mock://recordings/${b.id}.webm` : null;
  }

  /** Sign a mock webhook body (HMAC-SHA256 hex) — what a test harness / local simulator sends. */
  signWebhook(body: string): Record<string, string> {
    return { [MOCK_SIG_HEADER]: createHmac("sha256", this.secret).update(body).digest("hex") };
  }

  async parseWebhook(headers: WebhookHeaders, body: string | Uint8Array): Promise<MeetingEvent[]> {
    const raw = typeof body === "string" ? body : new TextDecoder().decode(body);
    const k = Object.keys(headers).find((h) => h.toLowerCase() === MOCK_SIG_HEADER);
    const got = k ? headers[k] : undefined;
    const sig = Array.isArray(got) ? got[0] : got;
    const expected = createHmac("sha256", this.secret).update(raw).digest("hex");
    if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new ForgeError("UNAUTHORIZED", "Invalid mock webhook signature");
    }
    return MockWebhookBody.parse(JSON.parse(raw)).events;
  }
}
