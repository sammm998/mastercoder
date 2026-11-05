import { describe, it, expect } from "vitest";
import { GoogleCalendarProvider } from "../src/adapters/google-calendar.js";
import { MicrosoftCalendarProvider } from "../src/adapters/microsoft-calendar.js";
import { MockCalendarProvider, createCalendarProvider, scheduleBotsForUpcoming, scheduleKey, type CalendarEvent } from "../src/calendar.js";
import { ManualClock, MockMeetingBotProvider } from "../src/mock-bot.js";
import type { JoinOptions, MeetingBotProvider } from "../src/types.js";

function stub(pages: unknown[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(u), headers });
    return new Response(JSON.stringify(pages[i++] ?? {}), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

const from = new Date("2026-03-02T08:00:00Z");
const to = new Date("2026-03-02T10:00:00Z");

describe("GoogleCalendarProvider", () => {
  it("lists events with conferenceData/hangoutLink/location links and pages", async () => {
    const { f, calls } = stub([
      {
        items: [
          { id: "g1", status: "confirmed", summary: "Kundmöte", start: { dateTime: "2026-03-02T09:00:00+01:00" }, end: { dateTime: "2026-03-02T09:30:00+01:00" }, hangoutLink: "https://meet.google.com/abc-defg-hij", conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+46" }, { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] }, organizer: { email: "a@x.se" } },
          { id: "g2", summary: "Heldag", start: { date: "2026-03-02" }, end: { date: "2026-03-03" } },
        ],
        nextPageToken: "p2",
      },
      { items: [{ id: "g3", status: "cancelled", summary: "Zoom", start: { dateTime: "2026-03-02T08:30:00Z" }, end: { dateTime: "2026-03-02T09:00:00Z" }, location: "https://us02web.zoom.us/j/85012345678?pwd=abc" }] },
    ]);
    const g = new GoogleCalendarProvider({ accessToken: async () => "tok", fetch: f });
    const ev = await g.listEvents({ from, to });
    expect(ev).toEqual([
      { id: "g1", title: "Kundmöte", start: "2026-03-02T08:00:00.000Z", end: "2026-03-02T08:30:00.000Z", cancelled: false, meetingUrl: "https://meet.google.com/abc-defg-hij", organizer: "a@x.se" },
      { id: "g3", title: "Zoom", start: "2026-03-02T08:30:00.000Z", end: "2026-03-02T09:00:00.000Z", cancelled: true, meetingUrl: "https://us02web.zoom.us/j/85012345678?pwd=abc" },
    ]);
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime" });
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(new URL(calls[1]!.url).searchParams.get("pageToken")).toBe("p2");
  });
});

describe("MicrosoftCalendarProvider", () => {
  it("reads calendarView with onlineMeeting.joinUrl and follows @odata.nextLink", async () => {
    const { f, calls } = stub([
      {
        value: [{ id: "m1", subject: "Teams sync", start: { dateTime: "2026-03-02T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-03-02T09:45:00.0000000", timeZone: "UTC" }, isCancelled: false, onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123%40thread.v2/0?context=%7b%7d" }, organizer: { emailAddress: { address: "b@x.se" } } }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=2",
      },
      { value: [{ id: "m2", subject: "Lunch", start: { dateTime: "2026-03-02T11:00:00" }, end: { dateTime: "2026-03-02T12:00:00" }, isAllDay: false, location: { displayName: "Restaurang" } }] },
    ]);
    const ms = new MicrosoftCalendarProvider({ accessToken: "t", fetch: f });
    const ev = await ms.listEvents({ from, to });
    expect(ev[0]).toEqual({ id: "m1", title: "Teams sync", start: "2026-03-02T09:00:00.000Z", end: "2026-03-02T09:45:00.000Z", cancelled: false, meetingUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123%40thread.v2/0?context=%7b%7d", organizer: "b@x.se" });
    expect(ev[1]!.meetingUrl).toBeUndefined();
    expect(calls[0]!.url).toContain("https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=");
    expect(calls[0]!.headers.prefer).toBe('outlook.timezone="UTC"');
    expect(calls[1]!.url).toBe("https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=2");
  });
});

describe("scheduleBotsForUpcoming", () => {
  const now = new Date("2026-03-02T08:00:00Z");
  const events: CalendarEvent[] = [
    { id: "e1", title: "Säljmöte", start: "2026-03-02T08:30:00Z", end: "2026-03-02T09:00:00Z", meetingUrl: "https://meet.google.com/abc-defg-hij" },
    // same meeting in a second calendar → deduped
    { id: "e1-copy", title: "Säljmöte", start: "2026-03-02T08:30:00Z", end: "2026-03-02T09:00:00Z", meetingUrl: "https://meet.google.com/abc-defg-hij?authuser=1" },
    { id: "e2", title: "Pågående", start: "2026-03-02T07:45:00Z", end: "2026-03-02T08:15:00Z", meetingUrl: "https://zoom.us/j/123456789" },
    { id: "e3", title: "Inget länk", start: "2026-03-02T08:40:00Z", end: "2026-03-02T09:00:00Z" },
    { id: "e4", title: "Inställt", start: "2026-03-02T08:40:00Z", end: "2026-03-02T09:00:00Z", meetingUrl: "https://zoom.us/j/987654321", cancelled: true },
    { id: "e5", title: "Webex", start: "2026-03-02T08:40:00Z", end: "2026-03-02T09:00:00Z", meetingUrl: "https://acme.webex.com/meet/x" },
    { id: "e6", title: "Senare", start: "2026-03-02T12:00:00Z", end: "2026-03-02T13:00:00Z", meetingUrl: "https://meet.google.com/zzz-zzzz-zzz" },
  ];

  it("schedules each upcoming meeting once and skips the rest with reasons", async () => {
    const clock = new ManualClock(now.getTime());
    const bots = new MockMeetingBotProvider({ clock });
    const scheduledKeys = new Set<string>();
    const r = await scheduleBotsForUpcoming({ calendar: new MockCalendarProvider(events), bots, windowMinutes: 60, alreadyScheduled: scheduledKeys, now, language: "sv" });
    expect(r.scheduled.map((s) => [s.eventId, s.joinAt])).toEqual([
      ["e2", "2026-03-02T08:00:00.000Z"], // in progress → join now
      ["e1", "2026-03-02T08:29:00.000Z"], // 60 s lead
    ]);
    expect(Object.fromEntries(r.skipped.map((s) => [s.eventId, s.reason]))).toEqual({ "e1-copy": "already scheduled", e3: "no meeting link", e4: "cancelled", e5: "unsupported meeting link" });
    expect(scheduledKeys).toEqual(new Set([scheduleKey("https://zoom.us/j/123456789", "2026-03-02T07:45:00Z"), scheduleKey("https://meet.google.com/abc-defg-hij", "2026-03-02T08:30:00Z")]));
    // second run: nothing new
    const again = await scheduleBotsForUpcoming({ calendar: new MockCalendarProvider(events), bots, windowMinutes: 60, alreadyScheduled: scheduledKeys, now });
    expect(again.scheduled).toEqual([]);
  });

  it("defers future joins for providers without scheduled join and accepts a lookup function", async () => {
    const joins: JoinOptions[] = [];
    const bots = { supportsScheduledJoin: false, join: async (o: JoinOptions) => (joins.push(o), { botId: `b${joins.length}`, status: "joining" as const }) } as unknown as MeetingBotProvider;
    const r = await scheduleBotsForUpcoming({ calendar: new MockCalendarProvider(events), bots, windowMinutes: 60, alreadyScheduled: async () => false, now });
    expect(r.scheduled.map((s) => s.eventId)).toEqual(["e2"]);
    expect(joins[0]!.joinAt).toBeUndefined();
    expect(r.skipped.find((s) => s.eventId === "e1")!.reason).toMatch(/deferred/);
  });

  it("factory falls back to the mock calendar", () => {
    delete process.env.CALENDAR_PROVIDER;
    expect(createCalendarProvider({ accessToken: "x" }).isMock).toBe(true);
  });
});
