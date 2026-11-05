import { round4, sumEstimate, type CostEstimate, type UsageSink } from "@forge/shared";
import type { MeterContext } from "./types.js";

/**
 * Provider cost (to Forge) per minute of audio. List prices; override per deployment with the
 * constructor `price` option of each adapter when a negotiated rate applies.
 */
export interface SttPrice {
  provider: string;
  model: string;
  prerecordedUsdPerMin: number;
  streamingUsdPerMin: number;
  /** Extra per-minute charge when diarization is requested (0 if included). */
  diarizationUsdPerMin: number;
  source: string;
  asOf: string;
}

export const STT_PRICES = {
  /**
   * ElevenLabs Scribe: $0.40 per hour of audio for the API (batch Scribe v1/v2 and Scribe v2 Realtime,
   * pay-as-you-go/Creator-tier rate), diarization included.
   * Source: https://elevenlabs.io/pricing/api (Speech to Text), checked 2025-Q4.
   */
  elevenlabs: {
    provider: "elevenlabs",
    model: "scribe_v1",
    prerecordedUsdPerMin: 0.4 / 60,
    streamingUsdPerMin: 0.4 / 60,
    diarizationUsdPerMin: 0,
    source: "https://elevenlabs.io/pricing/api",
    asOf: "2025-Q4",
  },
  /**
   * Deepgram Nova-3 monolingual (Swedish is a monolingual Nova-3 language), Pay As You Go:
   * pre-recorded $0.0043/min, streaming $0.0077/min, speaker diarization add-on $0.0020/min.
   * Source: https://deepgram.com/pricing, checked 2025-Q4.
   */
  deepgram: {
    provider: "deepgram",
    model: "nova-3",
    prerecordedUsdPerMin: 0.0043,
    streamingUsdPerMin: 0.0077,
    diarizationUsdPerMin: 0.002,
    source: "https://deepgram.com/pricing",
    asOf: "2025-Q4",
  },
  /** Mock: no provider is called, cost is zero. */
  mock: {
    provider: "mock",
    model: "mock-stt",
    prerecordedUsdPerMin: 0,
    streamingUsdPerMin: 0,
    diarizationUsdPerMin: 0,
    source: "n/a (mock)",
    asOf: "n/a",
  },
} satisfies Record<string, SttPrice>;

/**
 * Self-hosted Whisper has no vendor price; its cost is our GPU time. cost/min = gpuUsdPerHour / 60 / realtimeFactor.
 * Defaults: a dedicated EU GPU server (Hetzner GEX44, RTX 4000 SFF Ada, €184/month ≈ $0.27/h; source:
 * https://www.hetzner.com/dedicated-rootserver/gex44, checked 2025-Q4) running kb-whisper-large with
 * faster-whisper at ~10x realtime. Override with WHISPER_GPU_USD_PER_HOUR / WHISPER_REALTIME_FACTOR.
 */
export function whisperPrice(model: string, gpuUsdPerHour = 0.27, realtimeFactor = 10): SttPrice {
  const perMin = gpuUsdPerHour / 60 / Math.max(realtimeFactor, 0.01);
  return {
    provider: "whisper",
    model,
    prerecordedUsdPerMin: perMin,
    // Windowed streaming re-uses the same GPU path.
    streamingUsdPerMin: perMin,
    diarizationUsdPerMin: 0,
    source: "self-hosted GPU cost model (https://www.hetzner.com/dedicated-rootserver/gex44)",
    asOf: "2025-Q4",
  };
}

export function sttCostUsd(price: SttPrice, durationSec: number, opts: { streaming?: boolean; diarize?: boolean } = {}): number {
  const min = Math.max(0, durationSec) / 60;
  const base = opts.streaming ? price.streamingUsdPerMin : price.prerecordedUsdPerMin;
  return min * (base + (opts.diarize ? price.diarizationUsdPerMin : 0));
}

export function sttEstimate(price: SttPrice, durationSec: number, opts: { streaming?: boolean; diarize?: boolean } = {}): CostEstimate {
  const min = Math.max(0, durationSec) / 60;
  const parts = [{ label: `${price.provider} ${price.model} transcription (${round4(min)} min${opts.streaming ? ", streaming" : ""})`, usd: min * (opts.streaming ? price.streamingUsdPerMin : price.prerecordedUsdPerMin) }];
  if (opts.diarize && price.diarizationUsdPerMin > 0) parts.push({ label: "speaker diarization", usd: min * price.diarizationUsdPerMin });
  // Duration is known up front for prerecorded audio; keep a small spread for rounding/billing granularity.
  return sumEstimate(parts, 0.1);
}

/** Record `transcription_minutes` usage for a finished transcription. */
export async function recordTranscription(
  sink: UsageSink | undefined,
  price: SttPrice,
  durationSec: number,
  opts: { streaming?: boolean; diarize?: boolean; model?: string; ctx?: MeterContext } = {},
): Promise<void> {
  if (!sink) return;
  await sink.record({
    kind: "transcription_minutes",
    quantity: Math.max(0, durationSec) / 60,
    costUsd: sttCostUsd(price, durationSec, opts),
    provider: price.provider,
    model: opts.model ?? price.model,
    ...opts.ctx,
  });
}
