import { describe, it, expect, afterEach } from "vitest";
import { ForgeError, MemoryUsageSink } from "@forge/shared";
import { RecallMeetingBotProvider, parseRecallPayload } from "../src/adapters/recall.js";
import { MeetStreamMeetingBotProvider } from "../src/adapters/meetstream.js";
import { VexaMeetingBotProvider } from "../src/adapters/vexa.js";
import { ManualClock, MockMeetingBotProvider } from "../src/mock-bot.js";
import { createMeetingBotProvider } from "../src/factory.js";
import { URL_TOKEN_HEADER, signStandardWebhook, urlToken } from "../src/webhook-sig.js";

type Route = (url: string, init: RequestInit) => unknown;
function router(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: string; body?: unknown; headers: Record<string, string> }> = [];
  const f = (async (u: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(u);
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && url.endsWith(p as string);
    });
    if (!key) return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    return new Response(JSON.stringify(routes[key]!(url, init)), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

const SECRET = `whsec_${Buffer.from("recall-test-secret-0123456789").toString("base64")}`;

describe("RecallMeetingBotProvider", () => {
  it("creates an EU bot with visible name, chat consent notice, transcript config and auto-leave", async () => {
    const { f, calls } = router({ "POST /bot/": () => ({ id: "bot_1", status_changes: [] }) });
    const p = new RecallMeetingBotProvider({ apiKey: "rk", fetch: f, webhookSecret: SECRET });
    const r = await p.join({ meetingUrl: "https://meet.google.com/abc-defg-hij", language: "sv", webhookUrl: "https://api.forge.test/hooks/recall", joinAt: "2026-03-02T08:29:00.000Z" });
    expect(r).toEqual({ botId: "bot_1", status: "scheduled" });
    const c = calls[0]!;
    expect(c.url).toBe("https://eu-central-1.recall.ai/api/v1/bot/");
    expect(c.headers.authorization).toBe("Token rk");
    const body = c.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.bot_name).toBe("Forge notetaker");
    expect(body.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    expect(body.join_at).toBe("2026-03-02T08:29:00.000Z");
    expect(body.chat.on_bot_join.send_to).toBe("everyone");
    expect(body.chat.on_bot_join.message).toMatch(/spelar in.*\n\n.*is recording/s);
    expect(body.recording_config.transcript.provider.recallai_streaming.language_code).toBe("sv");
    expect(body.recording_config.realtime_endpoints[0]).toMatchObject({ type: "webhook", url: "https://api.forge.test/hooks/recall", events: ["transcript.data", "participant_events.chat_message"] });
    expect(body.automatic_leave.waiting_room_timeout).toBeGreaterThan(0);
  });

  it("leaves, chats, maps status, meters bot hours once and maps the transcript", async () => {
    const usage = new MemoryUsageSink();
    const bot = {
      id: "bot_1",
      status_changes: [
        { code: "joining_call", created_at: "2026-03-02T08:29:00Z" },
        { code: "in_call_recording", created_at: "2026-03-02T08:30:00Z" },
        { code: "call_ended", sub_code: "bot_received_leave_call", created_at: "2026-03-02T09:00:00Z" },
        { code: "done", created_at: "2026-03-02T09:01:00Z" },
      ],
      recordings: [{ id: "rec_1", media_shortcuts: { transcript: { data: { download_url: "https://dl.recall.test/t.json" } }, audio_mixed: { data: { download_url: "https://dl.recall.test/a.mp3" } } } }],
    };
    const { f, calls } = router({
      "POST /bot/bot_1/leave_call/": () => ({}),
      "POST /bot/bot_1/send_chat_message/": () => ({}),
      "GET /bot/bot_1/": () => bot,
      "GET /t.json": () => [
        { participant: { id: 1, name: "Maria" }, words: [{ text: "Hej", start_timestamp: { relative: 0.5 }, end_timestamp: { relative: 0.8 } }, { text: "Jonas.", start_timestamp: { relative: 0.9 }, end_timestamp: { relative: 1.3 } }] },
        { participant: { id: 2, name: "Jonas" }, words: [{ text: "Hej!", start_timestamp: { relative: 2 }, end_timestamp: { relative: 2.4 } }] },
      ],
    });
    const p = new RecallMeetingBotProvider({ apiKey: "rk", fetch: f, usage, region: "eu-central-1" });
    await p.leave("bot_1");
    await p.sendChatMessage("bot_1", "Hej");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["POST /api/v1/bot/bot_1/leave_call/", "POST /api/v1/bot/bot_1/send_chat_message/"]);
    expect(calls[1]!.body).toEqual({ to: "everyone", message: "Hej" });
    const st = await p.getStatus("bot_1");
    expect(st).toMatchObject({ status: "done", rawStatus: "done" });
    await p.getStatus("bot_1");
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({ kind: "bot_hours", quantity: 0.5, provider: "recall" });
    expect(usage.records[0]!.costUsd).toBeCloseTo(0.5 * 0.65, 9);
    const t = await p.getTranscript("bot_1");
    expect(t.segments).toEqual([
      { start: 0.5, end: 1.3, text: "Hej Jonas.", speaker: "Maria" },
      { start: 2, end: 2.4, text: "Hej!", speaker: "Jonas" },
    ]);
    expect(await p.getRecordingUrl("bot_1")).toBe("https://dl.recall.test/a.mp3");
  });

  it("verifies Standard Webhooks signatures and normalizes events", async () => {
    const p = new RecallMeetingBotProvider({ apiKey: "rk", webhookSecret: SECRET });
    const body = JSON.stringify({ event: "bot.in_call_recording", data: { bot: { id: "bot_1" }, data: { code: "in_call_recording", updated_at: "2026-03-02T08:30:00Z" } } });
    expect(await p.parseWebhook(signStandardWebhook(body, SECRET), body)).toEqual([{ type: "bot.in_call", botId: "bot_1", at: "2026-03-02T08:30:00Z", recording: true }]);
    await expect(p.parseWebhook(signStandardWebhook(body, `whsec_${Buffer.from("wrong").toString("base64")}`), body)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(p.parseWebhook(signStandardWebhook(body, SECRET, "msg", Math.floor(Date.now() / 1000) - 3600), body)).rejects.toThrow(/tolerance/);
    await expect(p.parseWebhook({}, body)).rejects.toThrow(/Missing webhook signature/);
    const tampered = body.replace("bot_1", "bot_2");
    await expect(p.parseWebhook(signStandardWebhook(body, SECRET), tampered)).rejects.toThrow(/Invalid webhook signature/);
    await expect(new RecallMeetingBotProvider({ apiKey: "rk" }).parseWebhook({}, body)).rejects.toThrow(/RECALL_WEBHOOK_SECRET/);
  });

  it("parses chat, transcript, status_change, fatal and recording events", () => {
    expect(parseRecallPayload({ event: "participant_events.chat_message", data: { bot: { id: "b" }, data: { participant: { name: "Anna" }, data: { text: "sluta spela in" }, timestamp: { absolute: "t1" } } } })).toEqual([{ type: "chat.message", botId: "b", at: "t1", sender: "Anna", text: "sluta spela in" }]);
    const tr = parseRecallPayload({ event: "transcript.data", data: { bot: { id: "b" }, data: { words: [{ text: "Hej", start_timestamp: { relative: 1 }, end_timestamp: { relative: 1.5 } }], participant: { name: "Erik" } } } });
    expect(tr[0]).toMatchObject({ type: "transcript.segment", segment: { start: 1, end: 1.5, text: "Hej", speaker: "Erik" } });
    expect(parseRecallPayload({ event: "bot.status_change", data: { bot_id: "b", status: { code: "joining_call", created_at: "t" } } })).toEqual([{ type: "bot.joining", botId: "b", at: "t" }]);
    expect(parseRecallPayload({ event: "bot.fatal", data: { bot: { id: "b" }, data: { code: "fatal", sub_code: "meeting_not_found" } } })[0]).toMatchObject({ type: "bot.error", code: "meeting_not_found" });
    expect(parseRecallPayload({ event: "recording.done", data: { bot: { id: "b" }, recording: { id: "r" } } })[0]).toMatchObject({ type: "recording.ready", recordingId: "r" });
    expect(() => parseRecallPayload({ nope: 1 })).toThrow(ForgeError);
  });
});

describe("MeetStreamMeetingBotProvider", () => {
  it("maps create/status/leave/transcript/audio and authenticates callbacks with a URL token", async () => {
    const usage = new MemoryUsageSink();
    const { f, calls } = router({
      "POST /bots/create_bot": () => ({ bot_id: "ms_1", status: "Joining" }),
      "GET /bots/ms_1/status": () => ({ status: "InMeeting" }),
      "GET /bots/ms_1/remove_bot": () => ({ ok: true }),
      "POST /bots/ms_1/send_message": () => ({ ok: true }),
      "GET /bots/ms_1/get_transcript": () => ({ transcript: [{ speaker: "Maria", text: "Hej", start: 0, end: 1 }, { speakerName: "Jonas", transcript: "Hej hej", start_time: 1, end_time: 1800 }] }),
      "GET /bots/ms_1/get_audio": () => ({ audio_url: "https://ms.test/a.wav" }),
    });
    const p = new MeetStreamMeetingBotProvider({ apiKey: "mk", fetch: f, webhookSecret: "s3cret", usage });
    expect(await p.join({ meetingUrl: "https://zoom.us/j/123456789", language: "sv", webhookUrl: "https://api.forge.test/hooks/meetstream" })).toEqual({ botId: "ms_1", status: "joining" });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(calls[0]!.url).toBe("https://api.meetstream.ai/api/v1/bots/create_bot");
    expect(calls[0]!.headers.authorization).toBe("Token mk");
    expect(body).toMatchObject({ meeting_link: "https://zoom.us/j/123456789", bot_name: "Forge notetaker", audio_required: true });
    expect(body.bot_message).toMatch(/spelar in/);
    expect(body.callback_url).toBe(`https://api.forge.test/hooks/meetstream?forge_token=${urlToken("s3cret", "meetstream")}`);
    expect((await p.getStatus("ms_1")).status).toBe("recording");
    await p.leave("ms_1");
    await p.sendChatMessage("ms_1", "hej");
    const t = await p.getTranscript("ms_1");
    expect(t.segments.map((s) => s.speaker)).toEqual(["Maria", "Jonas"]);
    expect(t.language).toBe("sv");
    expect(usage.records[0]).toMatchObject({ kind: "bot_hours", quantity: 0.5 });
    expect(await p.getRecordingUrl("ms_1")).toBe("https://ms.test/a.wav");
    await expect(p.join({ meetingUrl: "https://zoom.us/j/123456789", joinAt: new Date(Date.now() + 3600_000) })).rejects.toThrow(/joins immediately/);

    const hook = JSON.stringify({ bot_id: "ms_1", event: "bot.chat", sender: "Anna", message: "Forge leave" });
    expect(await p.parseWebhook({ [URL_TOKEN_HEADER]: urlToken("s3cret", "meetstream") }, hook)).toEqual([expect.objectContaining({ type: "chat.message", sender: "Anna", text: "Forge leave" })]);
    await expect(p.parseWebhook({ [URL_TOKEN_HEADER]: "x" }, hook)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const status = JSON.stringify({ bot_id: "ms_1", status: "Stopped" });
    expect((await p.parseWebhook({ [URL_TOKEN_HEADER]: urlToken("s3cret", "meetstream") }, status))[0]).toMatchObject({ type: "bot.left" });
  });
});

describe("VexaMeetingBotProvider", () => {
  it("joins by platform + native id, stops, reads status/transcript and meters hours", async () => {
    const usage = new MemoryUsageSink();
    const { f, calls } = router({
      "POST /bots": () => ({ id: 7, platform: "teams", native_meeting_id: "3512345678901", status: "requested" }),
      "DELETE /bots/teams/3512345678901": () => ({ message: "stopping" }),
      "POST /bots/teams/3512345678901/chat": () => ({ ok: true }),
      "GET /meetings": () => ({ meetings: [{ platform: "teams", native_meeting_id: "3512345678901", status: "completed", start_time: "2026-03-02T08:00:00Z", end_time: "2026-03-02T09:30:00Z" }] }),
      "GET /transcripts/teams/3512345678901": () => ({ segments: [{ start: 0, end: 2, text: " Hej allihop ", speaker: "Maria", language: "sv" }, { start: 2, end: 3, text: " " }] }),
    });
    const p = new VexaMeetingBotProvider({ baseUrl: "http://vexa.internal:8056/", apiKey: "vk", fetch: f, usage, webhookSecret: "vs" });
    const r = await p.join({ meetingUrl: "https://teams.microsoft.com/meet/3512345678901?p=AbCd", language: "sv", botName: "Forge notetaker" });
    expect(r).toEqual({ botId: "teams:3512345678901", status: "joining" });
    expect(calls[0]!.url).toBe("http://vexa.internal:8056/bots");
    expect(calls[0]!.headers["x-api-key"]).toBe("vk");
    expect(calls[0]!.body).toEqual({ platform: "teams", native_meeting_id: "3512345678901", bot_name: "Forge notetaker", language: "sv", passcode: "AbCd" });
    await p.sendChatMessage(r.botId, "notice");
    await p.leave(r.botId);
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(await p.getStatus(r.botId)).toMatchObject({ status: "done", rawStatus: "completed" });
    expect(usage.records[0]).toMatchObject({ kind: "bot_hours", quantity: 1.5, provider: "vexa" });
    const t = await p.getTranscript(r.botId);
    expect(t).toMatchObject({ text: "Hej allihop", language: "sv", segments: [{ start: 0, end: 2, text: "Hej allihop", speaker: "Maria" }] });
    expect(await p.getRecordingUrl()).toBeNull();
    expect(p.postsConsentOnJoin).toBe(false);
    const hook = JSON.stringify({ meeting: { platform: "teams", native_meeting_id: "3512345678901", status: "active", start_time: "t" } });
    expect(await p.parseWebhook({ [URL_TOKEN_HEADER]: urlToken("vs", "vexa") }, hook)).toEqual([{ type: "bot.in_call", botId: "teams:3512345678901", at: "t", recording: true }]);
    await expect(p.parseWebhook({}, hook)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("MockMeetingBotProvider", () => {
  it("simulates the lifecycle with an injected clock, signed webhooks and a fixture transcript", async () => {
    const clock = new ManualClock(Date.UTC(2026, 2, 2, 8, 0));
    const usage = new MemoryUsageSink();
    const transcript = { text: "Hej", language: "sv", durationSec: 1, segments: [{ start: 0, end: 1, text: "Hej", speaker: "Maria" }], provider: "fixture", model: "none" };
    const p = new MockMeetingBotProvider({ clock, admitAfterMs: 5_000, meetingDurationMs: 30 * 60_000, transcript, usage });
    const { botId, status } = await p.join({ meetingUrl: "https://zoom.us/j/123456789", joinAt: new Date(Date.UTC(2026, 2, 2, 8, 10)) });
    expect(status).toBe("scheduled");
    clock.advance(10 * 60_000);
    expect((await p.getStatus(botId)).status).toBe("joining");
    clock.advance(5_000);
    expect((await p.getStatus(botId)).status).toBe("recording");
    expect(p.chatLog(botId)[0]!.text).toMatch(/spelar in/);
    clock.advance(30 * 60_000);
    expect((await p.getStatus(botId)).status).toBe("done");
    expect(p.events.map((e) => e.type)).toEqual(["bot.joining", "bot.in_call", "chat.message", "bot.left", "recording.ready"]);
    expect(usage.records[0]).toMatchObject({ kind: "bot_hours", quantity: 0.5, costUsd: 0, provider: "mock" });
    expect(await p.getTranscript(botId)).toMatchObject({ text: "Hej", provider: "fixture" });
    expect(await p.getRecordingUrl(botId)).toMatch(/^mock:\/\//);
    const body = JSON.stringify({ events: [{ type: "chat.message", botId, at: "t", sender: "A", text: "lämna" }] });
    expect(await p.parseWebhook(p.signWebhook(body), body)).toHaveLength(1);
    await expect(p.parseWebhook({ "x-forge-mock-signature": "00" }, body)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(p.join({ meetingUrl: "https://example.com/meeting" })).rejects.toThrow(/Unsupported meeting platform/);
    await expect(p.join({ meetingUrl: "https://zoom.us/j/123456789", botName: "  " })).rejects.toThrow();
  });
});

describe("createMeetingBotProvider", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("selects by MEETING_BOT_PROVIDER (fallback mock) and requires keys for real adapters", () => {
    delete process.env.MEETING_BOT_PROVIDER;
    expect(createMeetingBotProvider()).toBeInstanceOf(MockMeetingBotProvider);
    process.env.MEETING_BOT_PROVIDER = "recall";
    delete process.env.RECALL_API_KEY;
    expect(() => createMeetingBotProvider()).toThrow(/RECALL_API_KEY/);
    process.env.RECALL_API_KEY = "x";
    expect(createMeetingBotProvider()).toBeInstanceOf(RecallMeetingBotProvider);
    process.env.MEETING_BOT_PROVIDER = "meetstream";
    process.env.MEETSTREAM_API_KEY = "x";
    process.env.MEETSTREAM_USD_PER_HOUR = "0.4";
    expect(createMeetingBotProvider().estimate(1).breakdown[0]!.usd).toBe(0.4);
    process.env.MEETING_BOT_PROVIDER = "vexa";
    process.env.VEXA_URL = "http://vexa";
    process.env.VEXA_API_KEY = "x";
    expect(createMeetingBotProvider()).toBeInstanceOf(VexaMeetingBotProvider);
  });
});
