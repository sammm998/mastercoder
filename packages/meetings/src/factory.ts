import { env, selectAdapter, type UsageSink } from "@forge/shared";
import type { MeetingBotProvider } from "./types.js";
import { MockMeetingBotProvider, type MockMeetingBotOptions } from "./mock-bot.js";
import { RecallMeetingBotProvider } from "./adapters/recall.js";
import { MeetStreamMeetingBotProvider } from "./adapters/meetstream.js";
import { VexaMeetingBotProvider } from "./adapters/vexa.js";
import { BOT_PRICES } from "./pricing.js";

export interface CreateMeetingBotOptions {
  usage?: UsageSink;
  meter?: { workspaceId?: string; projectId?: string };
  mock?: MockMeetingBotOptions;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
/** Unsigned webhooks are only accepted outside production when explicitly enabled. */
const allowUnsigned = () => process.env.NODE_ENV !== "production" && process.env.MEETINGS_ALLOW_UNSIGNED_WEBHOOKS === "true";

/** MEETING_BOT_PROVIDER=recall|meetstream|vexa|mock (fallback mock). */
export function createMeetingBotProvider(o: CreateMeetingBotOptions = {}): MeetingBotProvider {
  return selectAdapter<MeetingBotProvider>(
    "MEETING_BOT_PROVIDER",
    {
      recall: () =>
        new RecallMeetingBotProvider({
          apiKey: env("RECALL_API_KEY"),
          region: env("RECALL_REGION", "eu-central-1"),
          webhookSecret: process.env.RECALL_WEBHOOK_SECRET || undefined,
          allowUnsignedWebhooks: allowUnsigned(),
          usage: o.usage,
          meter: o.meter,
        }),
      meetstream: () =>
        new MeetStreamMeetingBotProvider({
          apiKey: env("MEETSTREAM_API_KEY"),
          baseUrl: process.env.MEETSTREAM_BASE_URL || undefined,
          webhookSecret: process.env.MEETSTREAM_WEBHOOK_SECRET || undefined,
          allowUnsignedWebhooks: allowUnsigned(),
          price: { ...BOT_PRICES.meetstream, usdPerHour: num(process.env.MEETSTREAM_USD_PER_HOUR, BOT_PRICES.meetstream.usdPerHour) },
          usage: o.usage,
          meter: o.meter,
        }),
      vexa: () =>
        new VexaMeetingBotProvider({
          baseUrl: env("VEXA_URL"),
          apiKey: env("VEXA_API_KEY"),
          webhookSecret: process.env.VEXA_WEBHOOK_SECRET || undefined,
          allowUnsignedWebhooks: allowUnsigned(),
          price: { ...BOT_PRICES.vexa, usdPerHour: num(process.env.VEXA_USD_PER_HOUR, BOT_PRICES.vexa.usdPerHour) },
          usage: o.usage,
          meter: o.meter,
        }),
      mock: () => new MockMeetingBotProvider({ ...o.mock, usage: o.mock?.usage ?? o.usage }),
    },
    "mock",
  ).instance;
}
