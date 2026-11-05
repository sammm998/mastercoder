import { createLogger, selectAdapter } from "@forge/shared";
import type { MeetingBotProvider } from "./types.js";
import type { CalendarEvent, CalendarProvider, AccessToken } from "./calendar-types.js";
import { parseMeetingUrl } from "./url.js";
import { GoogleCalendarProvider } from "./adapters/google-calendar.js";
import { MicrosoftCalendarProvider } from "./adapters/microsoft-calendar.js";

export * from "./calendar-types.js";

export class MockCalendarProvider implements CalendarProvider {
  readonly name = "mock";
  readonly isMock = true;
  constructor(private readonly events: CalendarEvent[] = []) {}
  add(e: CalendarEvent): void {
    this.events.push(e);
  }
  async listEvents({ from, to }: { from: Date; to: Date }): Promise<CalendarEvent[]> {
    return this.events
      .filter((e) => Date.parse(e.end) > from.getTime() && Date.parse(e.start) < to.getTime())
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .map((e) => ({ ...e }));
  }
}

/** CALENDAR_PROVIDER=google|microsoft|mock (fallback mock). The token belongs to the user whose calendar is synced. */
export function createCalendarProvider(o: { accessToken: AccessToken; calendarId?: string }): CalendarProvider {
  return selectAdapter<CalendarProvider>(
    "CALENDAR_PROVIDER",
    {
      google: () => new GoogleCalendarProvider({ accessToken: o.accessToken, calendarId: o.calendarId }),
      microsoft: () => new MicrosoftCalendarProvider({ accessToken: o.accessToken }),
      mock: () => new MockCalendarProvider(),
    },
    "mock",
  ).instance;
}

export interface ScheduledBot {
  eventId: string;
  key: string;
  botId: string;
  meetingUrl: string;
  joinAt: string;
}

export interface ScheduleOptions {
  calendar: CalendarProvider;
  bots: MeetingBotProvider;
  /** Look-ahead window (minutes). */
  windowMinutes: number;
  /** Dedupe keys already scheduled (a Set is updated in place), or a lookup (e.g. DB query). */
  alreadyScheduled: Set<string> | ((key: string) => boolean | Promise<boolean>);
  now?: Date;
  botName?: string;
  consentMessage?: string;
  language?: string;
  webhookUrl?: string;
  /** Join this many seconds before start (default 60). */
  joinLeadSeconds?: number;
}

/** Stable dedupe key: same meeting at the same start time (calendars often contain duplicates). */
export function scheduleKey(meetingUrl: string, start: string): string {
  const p = parseMeetingUrl(meetingUrl);
  return `${p.platform}:${p.nativeId}:${new Date(start).toISOString()}`;
}

export async function scheduleBotsForUpcoming(o: ScheduleOptions): Promise<{ scheduled: ScheduledBot[]; skipped: Array<{ eventId: string; reason: string }> }> {
  const log = createLogger({ component: "meetings.calendar" });
  const now = o.now ?? new Date();
  const to = new Date(now.getTime() + o.windowMinutes * 60_000);
  const lead = (o.joinLeadSeconds ?? 60) * 1000;
  const events = await o.calendar.listEvents({ from: now, to });
  const scheduled: ScheduledBot[] = [];
  const skipped: Array<{ eventId: string; reason: string }> = [];
  const seen = new Set<string>();
  const isScheduled = async (k: string) => (o.alreadyScheduled instanceof Set ? o.alreadyScheduled.has(k) : o.alreadyScheduled(k));
  for (const e of events) {
    if (e.cancelled) {
      skipped.push({ eventId: e.id, reason: "cancelled" });
      continue;
    }
    if (!e.meetingUrl) {
      skipped.push({ eventId: e.id, reason: "no meeting link" });
      continue;
    }
    if (Date.parse(e.end) <= now.getTime()) {
      skipped.push({ eventId: e.id, reason: "already ended" });
      continue;
    }
    if (Date.parse(e.start) > to.getTime()) {
      skipped.push({ eventId: e.id, reason: "outside window" });
      continue;
    }
    let key: string;
    try {
      key = scheduleKey(e.meetingUrl, e.start);
    } catch {
      skipped.push({ eventId: e.id, reason: "unsupported meeting link" });
      continue;
    }
    if (seen.has(key) || (await isScheduled(key))) {
      skipped.push({ eventId: e.id, reason: "already scheduled" });
      continue;
    }
    seen.add(key);
    const joinAt = new Date(Math.max(now.getTime(), Date.parse(e.start) - lead));
    const immediate = joinAt.getTime() <= now.getTime();
    if (!immediate && !o.bots.supportsScheduledJoin) {
      // Provider joins immediately only: leave it for a later run inside the lead time.
      skipped.push({ eventId: e.id, reason: "deferred: provider has no scheduled join" });
      continue;
    }
    try {
      const r = await o.bots.join({
        meetingUrl: e.meetingUrl,
        botName: o.botName,
        consentMessage: o.consentMessage,
        language: o.language,
        webhookUrl: o.webhookUrl,
        joinAt: immediate ? undefined : joinAt,
      });
      if (o.alreadyScheduled instanceof Set) o.alreadyScheduled.add(key);
      scheduled.push({ eventId: e.id, key, botId: r.botId, meetingUrl: e.meetingUrl, joinAt: joinAt.toISOString() });
    } catch (err) {
      log.warn("bot scheduling failed", { eventId: e.id, error: (err as Error).message });
      skipped.push({ eventId: e.id, reason: `join failed: ${(err as Error).message.slice(0, 200)}` });
    }
  }
  return { scheduled, skipped };
}
