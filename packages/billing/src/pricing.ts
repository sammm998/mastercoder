import { round4, type UsageKind, type UsageRecord } from "@forge/shared";

/**
 * User-facing price formula (linear, so it can be applied to aggregates exactly):
 *
 *   priceUsd = providerCostUsd × (1 + MARKUP[kind]) + quantity × PLATFORM_FEE[kind]
 *
 * - `providerCostUsd` is the real cost recorded on each UsageRecord (token prices from @forge/llm
 *   MODEL_PRICES, vendor prices below for other kinds).
 * - MARKUP covers payment fees (~3%), retries/failed work Forge absorbs (no charge for agent errors),
 *   infra and margin. Compute-heavy kinds (sandbox, hosting) carry a higher markup because the provider
 *   price excludes our orchestration, snapshots and egress.
 * - PLATFORM_FEE is a flat per-unit fee where provider cost is ~0 (e.g. agent runs: scheduling, logs).
 */
export const MARKUP: Record<UsageKind, number> = {
  llm_input_tokens: 0.5,
  llm_output_tokens: 0.5,
  llm_cache_read_tokens: 0.5,
  llm_cache_write_tokens: 0.5,
  sandbox_minutes: 1.0,
  media_seconds: 0.3,
  image_count: 0.3,
  transcription_minutes: 0.5,
  bot_hours: 0.5,
  hosting_hours: 1.0,
  agent_run: 0,
};

export const PLATFORM_FEE: Record<UsageKind, number> = {
  llm_input_tokens: 0,
  llm_output_tokens: 0,
  llm_cache_read_tokens: 0,
  llm_cache_write_tokens: 0,
  sandbox_minutes: 0,
  media_seconds: 0,
  image_count: 0,
  transcription_minutes: 0,
  bot_hours: 0,
  hosting_hours: 0,
  agent_run: 0.002,
};

/**
 * Reference provider cost per unit (USD) for non-token kinds, used for estimates before work starts.
 * Actual charges always use the recorded `costUsd`. Sources (list prices, Nov 2026 snapshot):
 * - sandbox_minutes: E2B $0.000014/vCPU-s + $0.0000045/GiB-s, default sandbox 2 vCPU / 4 GiB
 *   = $0.000046/s = $0.00276/min (e2b.dev/pricing)
 * - media_seconds: fal.ai text-to-video (Kling / Veo class) ~$0.10 per generated second (fal.ai/pricing)
 * - image_count: fal.ai FLUX.1 [dev] $0.025/megapixel, ~1.2 MP per image = $0.03 (fal.ai/pricing)
 * - transcription_minutes: ElevenLabs Scribe $0.40/hour = $0.0067/min (elevenlabs.io/pricing/api)
 * - bot_hours: Recall.ai $0.50 per recording hour (recall.ai/pricing)
 * - hosting_hours: Fly.io shared-cpu-1x 256 MB $1.94/month = $0.0027/hour (fly.io/docs/about/pricing)
 * - agent_run: no direct provider cost (LLM/tool usage is metered separately)
 */
export const PROVIDER_UNIT_COST: Record<Exclude<UsageKind, `llm_${string}`>, number> = {
  sandbox_minutes: 0.00276,
  media_seconds: 0.1,
  image_count: 0.03,
  transcription_minutes: 0.0067,
  bot_hours: 0.5,
  hosting_hours: 0.0027,
  agent_run: 0,
};

/** 1 billing credit = $0.001 of user-facing price (Stripe meter values are integers). */
export const USD_PER_CREDIT = 0.001;

export function priceFor(kind: UsageKind, costUsd: number, quantity: number): number {
  return costUsd * (1 + MARKUP[kind]) + quantity * PLATFORM_FEE[kind];
}

/** User-facing price of one usage record, USD (4 decimals). */
export function priceUsage(r: Pick<UsageRecord, "kind" | "costUsd" | "quantity">): number {
  return round4(priceFor(r.kind, r.costUsd, r.quantity));
}

/** Sum of user-facing prices (computed unrounded, rounded once). */
export function priceRecords(rs: Array<Pick<UsageRecord, "kind" | "costUsd" | "quantity">>): number {
  return round4(rs.reduce((a, r) => a + priceFor(r.kind, r.costUsd, r.quantity), 0));
}

/** User-facing unit price for display (non-token kinds), e.g. "Sandbox $0.0055/min". */
export function userUnitPrice(kind: Exclude<UsageKind, `llm_${string}`>): number {
  return Math.round((PROVIDER_UNIT_COST[kind] * (1 + MARKUP[kind]) + PLATFORM_FEE[kind]) * 1e6) / 1e6;
}

export function usdToCredits(usd: number): number {
  return Math.round(usd / USD_PER_CREDIT);
}
