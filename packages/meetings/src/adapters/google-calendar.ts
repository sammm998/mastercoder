import { z } from "zod";
import { resolveToken, type AccessToken, type CalendarEvent, type CalendarProvider } from "../calendar-types.js";
import { findMeetingUrl } from "../url.js";
import { fetchJson, type FetchLike } from "./http.js";

/**
 * Google Calendar API v3 events.list (https://developers.google.com/calendar/api/v3/reference/events/list):
 * GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events?timeMin&timeMax&singleEvents=true&orderBy=startTime
 * Meeting link: conferenceData.entryPoints[video] → hangoutLink → link in location → link in description.
 * Scope: https://www.googleapis.com/auth/calendar.events.readonly (token injected by the connection layer).
 */
const GEvent = z
  .object({
    id: z.string(),
    status: z.string().optional(),
    summary: z.string().optional(),
    start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
    end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
    hangoutLink: z.string().optional(),
    conferenceData: z
      .object({ entryPoints: z.array(z.object({ entryPointType: z.string().optional(), uri: z.string().optional() })).optional() })
      .optional(),
    location: z.string().optional(),
    description: z.string().optional(),
    organizer: z.object({ email: z.string().optional() }).optional(),
  })
  .passthrough();

const GList = z.object({ items: z.array(GEvent).default([]), nextPageToken: z.string().optional() });

export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google";
  readonly isMock = false;
  constructor(private readonly o: { accessToken: AccessToken; calendarId?: string; fetch?: FetchLike; baseUrl?: string }) {}

  async listEvents({ from, to }: { from: Date; to: Date }): Promise<CalendarEvent[]> {
    const base = this.o.baseUrl ?? "https://www.googleapis.com/calendar/v3";
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      if (pageToken) q.set("pageToken", pageToken);
      const token = await resolveToken(this.o.accessToken);
      const r = await fetchJson(
        "google-calendar",
        `${base}/calendars/${encodeURIComponent(this.o.calendarId ?? "primary")}/events?${q}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
        GList,
        this.o.fetch,
      );
      for (const e of r.items) {
        // All-day events (date only) are not meetings a bot can join.
        if (!e.start?.dateTime || !e.end?.dateTime) continue;
        const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
        const meetingUrl = video ?? e.hangoutLink ?? findMeetingUrl(e.location) ?? findMeetingUrl(e.description);
        const ev: CalendarEvent = {
          id: e.id,
          title: e.summary ?? "",
          start: new Date(e.start.dateTime).toISOString(),
          end: new Date(e.end.dateTime).toISOString(),
          cancelled: e.status === "cancelled",
        };
        if (meetingUrl) ev.meetingUrl = meetingUrl;
        if (e.organizer?.email) ev.organizer = e.organizer.email;
        out.push(ev);
      }
      pageToken = r.nextPageToken;
    } while (pageToken && ++pages < 20);
    return out;
  }
}
