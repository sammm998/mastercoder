import { createLogger, type Logger } from "@forge/shared";
import type { MeetingBotProvider, MeetingEvent, MeetingRepo } from "./types.js";

/**
 * GDPR / consent: the bot always joins under a visible name, posts a bilingual recording notice in the meeting
 * chat on join, and leaves as soon as a participant asks it to in chat.
 */
export const DEFAULT_BOT_NAME = "Forge notetaker";

export function consentMessage(botName = DEFAULT_BOT_NAME): string {
  return [
    `🔴 ${botName} spelar in och transkriberar det här mötet för att ta fram anteckningar och krav. ` +
      `Skriv "sluta spela in" eller "Forge lämna" i chatten så lämnar jag direkt och inspelningen stoppas.`,
    `🔴 ${botName} is recording and transcribing this meeting to produce notes and requirements. ` +
      `Type "stop recording" or "Forge leave" in the chat and I will leave immediately and stop recording.`,
  ].join("\n\n");
}

export function leaveAcknowledgement(botName = DEFAULT_BOT_NAME): string {
  return `${botName} lämnar mötet och slutar spela in. / ${botName} is leaving and has stopped recording.`;
}

const STOP_PATTERNS: RegExp[] = [
  /\bforge\b[\s,:!-]*(leave|lämna|stop|stopp|stoppa|sluta|gå|go away|quit)\b/,
  /\b(sluta|slutar) (att )?(spela in|transkribera|anteckna)\b/,
  /\bstoppa (inspelningen|inspelning)\b/,
  /\bspela inte in\b/,
  /\bstop(p)? (the )?recording\b/,
  /\b(don't|do not) record\b/,
  /\b(bot|boten|notetaker),? (leave|lämna|stop)\b/,
  /\b(leave|lämna) (the )?(meeting|mötet|samtalet|call)\b/,
];
/** Single-word requests are only honoured when they are the whole message ("lämna!"), not inside a sentence. */
const WHOLE_MESSAGE = /^(lämna|leave|stopp|stop)$/;

/** Does a chat message ask the bot to stop recording / leave? (sv + en) */
export function isStopRequest(text: string): boolean {
  const t = text.toLocaleLowerCase("sv-SE").normalize("NFC").replace(/[“”"'!.?]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (WHOLE_MESSAGE.test(t)) return true;
  return STOP_PATTERNS.some((re) => re.test(t));
}

export type ConsentAction =
  | { type: "consent.posted"; botId: string }
  | { type: "stop.requested"; botId: string; by: string; text: string }
  | { type: "ignored"; botId: string };

export interface ConsentGuardOptions {
  bots: MeetingBotProvider;
  repo?: MeetingRepo;
  botName?: string;
  /** Custom notice; defaults to consentMessage(botName). */
  notice?: string;
  now?: () => Date;
  logger?: Logger;
}

/**
 * Feed every normalized MeetingEvent through `handle`. It posts the notice once the bot is in the call (unless the
 * vendor already posted it on join), and on a stop request acknowledges in chat, leaves, and records who asked.
 */
export class ConsentGuard {
  private posted = new Set<string>();
  private stopped = new Set<string>();
  private readonly log: Logger;
  constructor(private readonly o: ConsentGuardOptions) {
    this.log = o.logger ?? createLogger({ component: "meetings.consent" });
  }

  private now(): Date {
    return this.o.now ? this.o.now() : new Date();
  }

  async handle(e: MeetingEvent): Promise<ConsentAction> {
    const name = this.o.botName ?? DEFAULT_BOT_NAME;
    if (e.type === "bot.in_call") {
      if (this.posted.has(e.botId)) return { type: "ignored", botId: e.botId };
      this.posted.add(e.botId);
      if (!this.o.bots.postsConsentOnJoin) await this.o.bots.sendChatMessage(e.botId, this.o.notice ?? consentMessage(name));
      await this.markMeeting(e.botId, { consentNoticePosted: true });
      return { type: "consent.posted", botId: e.botId };
    }
    if (e.type === "chat.message" && isStopRequest(e.text) && !this.stopped.has(e.botId)) {
      if (e.sender === name) return { type: "ignored", botId: e.botId }; // our own notice quotes the stop words
      this.stopped.add(e.botId);
      try {
        await this.o.bots.sendChatMessage(e.botId, leaveAcknowledgement(name));
      } catch (err) {
        this.log.warn("could not post leave acknowledgement", { botId: e.botId, error: (err as Error).message });
      }
      await this.o.bots.leave(e.botId);
      await this.markMeeting(e.botId, { stopRequest: { by: e.sender, text: e.text.slice(0, 500), at: this.now().toISOString() } });
      return { type: "stop.requested", botId: e.botId, by: e.sender, text: e.text };
    }
    return { type: "ignored", botId: e.botId };
  }

  private async markMeeting(botId: string, patch: Parameters<MeetingRepo["update"]>[1]): Promise<void> {
    if (!this.o.repo) return;
    const m = await this.o.repo.findByBotId(botId);
    if (m) await this.o.repo.update(m.id, patch);
  }
}
