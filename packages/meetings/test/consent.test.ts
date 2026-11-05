import { describe, it, expect } from "vitest";
import { ConsentGuard, consentMessage, isStopRequest } from "../src/consent.js";
import { ManualClock, MockMeetingBotProvider } from "../src/mock-bot.js";
import { InMemoryMeetingRepo } from "../src/repo.js";
import type { MeetingBotProvider, MeetingEvent } from "../src/types.js";

describe("isStopRequest", () => {
  it("detects sv + en stop requests", () => {
    for (const t of ["Forge leave", "forge, leave please", "Forge lämna!", "Kan du sluta spela in?", "SLUTA SPELA IN", "lämna", "Lämna!", "stop recording", "Please stop the recording.", "Stoppa inspelningen", "spela inte in det här", "botten? nej: notetaker, leave", "lämna mötet tack"]) {
      expect(isStopRequest(t), t).toBe(true);
    }
  });
  it("does not trigger on ordinary chat", () => {
    for (const t of ["Jag ska lämna in rapporten på fredag", "Vi kan lämna det till nästa möte", "Hej alla!", "Can we record the decisions?", "the recording quality is good", ""]) {
      expect(isStopRequest(t), t).toBe(false);
    }
  });
});

describe("consentMessage", () => {
  it("is bilingual and names the bot", () => {
    const m = consentMessage("Forge notetaker");
    expect(m).toMatch(/spelar in/);
    expect(m).toMatch(/is recording/);
    expect(m).toMatch(/sluta spela in/);
    expect(m).toMatch(/Forge notetaker/);
  });
});

async function setup(bots: MeetingBotProvider & { onEvent?: MockMeetingBotProvider["onEvent"] }) {
  const repo = new InMemoryMeetingRepo();
  const guard = new ConsentGuard({ bots, repo, now: () => new Date("2026-01-01T09:00:00Z") });
  return { repo, guard };
}

describe("ConsentGuard with the mock bot", () => {
  it("joins with a visible name, posts the notice once, and leaves when a participant asks", async () => {
    const clock = new ManualClock();
    const bots = new MockMeetingBotProvider({ clock, admitAfterMs: 10_000 });
    const { repo, guard } = await setup(bots);
    const actions: string[] = [];
    bots.onEvent(async (e) => {
      actions.push((await guard.handle(e)).type);
    });
    const { botId, status } = await bots.join({ meetingUrl: "https://meet.google.com/abc-defg-hij", language: "sv" });
    expect(status).toBe("joining");
    await repo.create({ id: "mtg_1", workspaceId: "ws", source: "bot", provider: "mock", externalBotId: botId, language: "sv", status: "joining", consentNoticePosted: false, retention: {}, createdAt: new Date().toISOString() });
    clock.advance(10_000);
    await bots.tick();
    const log = bots.chatLog(botId);
    expect(log[0]).toMatchObject({ sender: "Forge notetaker" });
    expect(log[0]!.text).toContain("spelar in");
    // The bot's own notice quotes the stop words but must not trigger a leave.
    expect((await bots.getStatus(botId)).status).toBe("recording");
    expect((await repo.get("mtg_1"))!.consentNoticePosted).toBe(true);

    await bots.simulateChat(botId, "Anna", "Hej! Kan du sluta spela in?");
    expect((await bots.getStatus(botId)).status).toBe("done");
    const m = await repo.get("mtg_1");
    expect(m!.stopRequest).toMatchObject({ by: "Anna", text: "Hej! Kan du sluta spela in?" });
    expect(bots.chatLog(botId).some((c) => /lämnar mötet/.test(c.text))).toBe(true);
    expect(actions).toContain("consent.posted");
    expect(actions).toContain("stop.requested");
    expect(bots.events.map((e) => e.type)).toEqual(["bot.joining", "bot.in_call", "chat.message", "chat.message", "chat.message", "bot.left", "recording.ready"]);
  });

  it("posts the notice itself for providers that cannot post on join", async () => {
    const sent: string[] = [];
    const left: string[] = [];
    const fake = {
      name: "fake",
      isMock: true,
      postsConsentOnJoin: false,
      supportsScheduledJoin: false,
      sendChatMessage: async (_id: string, t: string) => void sent.push(t),
      leave: async (id: string) => void left.push(id),
    } as unknown as MeetingBotProvider;
    const guard = new ConsentGuard({ bots: fake, botName: "Forge notetaker" });
    const inCall: MeetingEvent = { type: "bot.in_call", botId: "b1", at: "x", recording: true };
    expect((await guard.handle(inCall)).type).toBe("consent.posted");
    expect((await guard.handle(inCall)).type).toBe("ignored");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Forge notetaker");
    await guard.handle({ type: "chat.message", botId: "b1", at: "x", sender: "Erik", text: "stop recording" });
    await guard.handle({ type: "chat.message", botId: "b1", at: "x", sender: "Erik", text: "stop recording!!" });
    expect(left).toEqual(["b1"]);
  });
});
