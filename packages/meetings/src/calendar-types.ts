export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601 UTC. */
  start: string;
  end: string;
  meetingUrl?: string;
  organizer?: string;
  cancelled?: boolean;
}

export interface CalendarProvider {
  readonly name: string;
  readonly isMock: boolean;
  listEvents(range: { from: Date; to: Date }): Promise<CalendarEvent[]>;
}

/** OAuth access token (string) or a refresher returning a fresh one. Tokens come from the user's connected account. */
export type AccessToken = string | (() => Promise<string>);

export async function resolveToken(t: AccessToken): Promise<string> {
  return typeof t === "string" ? t : t();
}
