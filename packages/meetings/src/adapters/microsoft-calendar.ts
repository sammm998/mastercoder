import { z } from "zod";
import { resolveToken, type AccessToken, type CalendarEvent, type CalendarProvider } from "../calendar-types.js";
import { findMeetingUrl } from "../url.js";
import { fetchJson, type FetchLike } from "./http.js";

/**
 * Microsoft Graph calendarView (https://learn.microsoft.com/graph/api/user-list-calendarview):
 * GET https://graph.microsoft.com/v1.0/me/calendarView?startDateTime&endDateTime&$select=…  (Prefer: outlook.timezone="UTC")
 * Meeting link: onlineMeeting.joinUrl → onlineMeetingUrl → link in location / bodyPreview. Paged via @odata.nextLink.
 * Scope: Calendars.Read (delegated token injected by the connection layer).
 */
const DT = z.object({ dateTime: z.string(), timeZone: z.string().optional() });
const MsEvent = z
  .object({
    id: z.string(),
    subject: z.string().nullish(),
    start: DT,
    end: DT,
    isCancelled: z.boolean().optional(),
    isAllDay: z.boolean().optional(),
    onlineMeeting: z.object({ joinUrl: z.string().nullish() }).nullish(),
    onlineMeetingUrl: z.string().nullish(),
    location: z.object({ displayName: z.string().nullish() }).nullish(),
    bodyPreview: z.string().nullish(),
    organizer: z.object({ emailAddress: z.object({ address: z.string().nullish() }).nullish() }).nullish(),
  })
  .passthrough();
const MsList = z.object({ value: z.array(MsEvent).default([]), "@odata.nextLink": z.string().optional() });

/** Graph returns UTC wall time without an offset when Prefer: outlook.timezone="UTC". */
function utc(dt: z.infer<typeof DT>): string {
  const s = /[zZ]|[+-]\d\d:\d\d$/.test(dt.dateTime) ? dt.dateTime : `${dt.dateTime}Z`;
  return new Date(s).toISOString();
}

export class MicrosoftCalendarProvider implements CalendarProvider {
  readonly name = "microsoft";
  readonly isMock = false;
  constructor(private readonly o: { accessToken: AccessToken; fetch?: FetchLike; baseUrl?: string }) {}

  async listEvents({ from, to }: { from: Date; to: Date }): Promise<CalendarEvent[]> {
    const base = this.o.baseUrl ?? "https://graph.microsoft.com/v1.0";
    const q = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: to.toISOString(),
      $select: "id,subject,start,end,isCancelled,isAllDay,onlineMeeting,onlineMeetingUrl,location,bodyPreview,organizer",
      $orderby: "start/dateTime",
      $top: "100",
    });
    let url: string | undefined = `${base}/me/calendarView?${q}`;
    const out: CalendarEvent[] = [];
    let pages = 0;
    while (url && pages++ < 20) {
      const token = await resolveToken(this.o.accessToken);
      const r: z.infer<typeof MsList> = await fetchJson(
        "microsoft-graph",
        url,
        { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"', Accept: "application/json" } },
        MsList,
        this.o.fetch,
      );
      for (const e of r.value) {
        if (e.isAllDay) continue;
        const meetingUrl = e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? findMeetingUrl(e.location?.displayName) ?? findMeetingUrl(e.bodyPreview);
        const ev: CalendarEvent = { id: e.id, title: e.subject ?? "", start: utc(e.start), end: utc(e.end), cancelled: Boolean(e.isCancelled) };
        if (meetingUrl) ev.meetingUrl = meetingUrl;
        const org = e.organizer?.emailAddress?.address;
        if (org) ev.organizer = org;
        out.push(ev);
      }
      url = r["@odata.nextLink"];
    }
    return out;
  }
}
