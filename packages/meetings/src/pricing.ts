import { sumEstimate, type CostEstimate, type UsageSink } from "@forge/shared";

/** Meeting-bot provider cost per bot-hour (cost to Forge). */
export interface BotPrice {
  provider: string;
  usdPerHour: number;
  /** Vendor transcription add-on per hour, when the bot's own transcription is used. */
  transcriptionUsdPerHour: number;
  source: string;
}

export const BOT_PRICES = {
  /** Recall.ai pay-as-you-go: $0.50 per recording hour; Recall.ai transcription $0.15/hour. https://www.recall.ai/pricing (2025-Q4). */
  recall: { provider: "recall", usdPerHour: 0.5, transcriptionUsdPerHour: 0.15, source: "https://www.recall.ai/pricing (2025-Q4)" },
  /**
   * MeetStream pay-as-you-go list price $0.35 per bot-hour incl. transcription, https://meetstream.ai/pricing (2025-Q4,
   * not re-verified from this environment). Override with MEETSTREAM_USD_PER_HOUR.
   */
  meetstream: { provider: "meetstream", usdPerHour: 0.35, transcriptionUsdPerHour: 0, source: "https://meetstream.ai/pricing (2025-Q4)" },
  /**
   * Vexa self-hosted: our infra only. One bot ≈ 1 vCPU / 1.5 GB; a Hetzner CPX41 (8 vCPU, €28.08/month ≈ $0.042/h,
   * https://www.hetzner.com/cloud) runs ~4 bots → ≈ $0.01 per bot-hour. Override with VEXA_USD_PER_HOUR.
   */
  vexa: { provider: "vexa", usdPerHour: 0.01, transcriptionUsdPerHour: 0, source: "self-hosted cost model (Hetzner CPX41)" },
  mock: { provider: "mock", usdPerHour: 0, transcriptionUsdPerHour: 0, source: "n/a (mock)" },
} satisfies Record<string, BotPrice>;

export function botEstimate(p: BotPrice, hours: number): CostEstimate {
  const parts = [{ label: `${p.provider} meeting bot (${hours} h)`, usd: hours * p.usdPerHour }];
  if (p.transcriptionUsdPerHour) parts.push({ label: `${p.provider} transcription`, usd: hours * p.transcriptionUsdPerHour });
  // Meetings overrun or end early: wide spread.
  return sumEstimate(parts, 0.5);
}

export async function recordBotHours(sink: UsageSink | undefined, p: BotPrice, hours: number, ctx: { workspaceId?: string; projectId?: string } = {}): Promise<void> {
  if (!sink || !(hours > 0)) return;
  await sink.record({ kind: "bot_hours", quantity: hours, costUsd: hours * (p.usdPerHour + p.transcriptionUsdPerHour), provider: p.provider, ...ctx });
}
