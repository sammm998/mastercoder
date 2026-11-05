import { z } from "zod";

export type PriceUnit = "megapixel" | "image" | "second";
export type MediaTask = "text-to-image" | "edit-image" | "remove-background" | "upscale" | "text-to-video" | "image-to-video";

export interface ModelPrice {
  provider: "fal" | "replicate" | "mock";
  model: string;
  task: MediaTask;
  unit: PriceUnit;
  /** USD per unit (after any base block). */
  usd: number;
  /** Optional base block: `baseUsd` covers the first `baseUnits` units (e.g. Kling: $0.35 for the first 5 s). */
  baseUsd?: number;
  baseUnits?: number;
  /** Where the number comes from. */
  source: string;
}

/**
 * Provider price table (provider cost, no Forge markup).
 *
 * Sources: vendor model pages (fal.ai/models/<id>, replicate.com/<owner>/<model>) as summarised by public
 * pricing aggregators, checked 2026-11. fal bills image models per output megapixel rounded UP per image.
 * fal's own pricing API is authoritative; these values can be overridden at runtime with
 * MEDIA_PRICE_OVERRIDES='{"fal-ai/flux/dev":0.025}' (USD per unit) without a code change.
 * Entries marked "compute-billed" are billed by GPU time upstream; the number is a per-call estimate.
 */
export const PRICE_TABLE: ModelPrice[] = [
  // ---- fal.ai ----
  { provider: "fal", model: "fal-ai/flux/schnell", task: "text-to-image", unit: "megapixel", usd: 0.003, source: "fal.ai/models/fal-ai/flux/schnell — $0.003/MP (checked 2026-09/11)" },
  { provider: "fal", model: "fal-ai/flux/dev", task: "text-to-image", unit: "megapixel", usd: 0.025, source: "fal.ai/models/fal-ai/flux/dev — $0.025/MP" },
  { provider: "fal", model: "fal-ai/flux-pro/v1.1", task: "text-to-image", unit: "megapixel", usd: 0.04, source: "fal.ai/models/fal-ai/flux-pro/v1.1 — $0.04/MP (checked 2026-09)" },
  { provider: "fal", model: "fal-ai/flux-pro/kontext", task: "edit-image", unit: "image", usd: 0.04, source: "fal.ai/models/fal-ai/flux-pro/kontext — $0.04/image" },
  { provider: "fal", model: "fal-ai/flux-pro/v1/fill", task: "edit-image", unit: "megapixel", usd: 0.05, source: "fal.ai/models/fal-ai/flux-pro/v1/fill — $0.05/MP" },
  { provider: "fal", model: "fal-ai/bria/background/remove", task: "remove-background", unit: "image", usd: 0.018, source: "fal.ai/models/fal-ai/bria/background/remove — $0.018/generation" },
  { provider: "fal", model: "fal-ai/esrgan", task: "upscale", unit: "image", usd: 0.002, source: "fal.ai/models/fal-ai/esrgan — compute-billed (~$0.00111/s GPU); ~2 s per call estimate" },
  { provider: "fal", model: "fal-ai/veo3.1", task: "text-to-video", unit: "second", usd: 0.2, source: "fal.ai/models/fal-ai/veo3.1 — $0.20/s audio off ($0.40/s audio on); Forge sends generate_audio=false" },
  { provider: "fal", model: "fal-ai/veo3.1/fast", task: "text-to-video", unit: "second", usd: 0.1, source: "fal.ai/models/fal-ai/veo3.1/fast — $0.10/s audio off" },
  { provider: "fal", model: "fal-ai/veo3.1/image-to-video", task: "image-to-video", unit: "second", usd: 0.2, source: "fal.ai/models/fal-ai/veo3.1/image-to-video — $0.20/s audio off" },
  { provider: "fal", model: "fal-ai/veo3.1/fast/image-to-video", task: "image-to-video", unit: "second", usd: 0.1, source: "fal.ai/models/fal-ai/veo3.1/fast/image-to-video — $0.10/s audio off" },
  { provider: "fal", model: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video", task: "text-to-video", unit: "second", usd: 0.07, baseUsd: 0.35, baseUnits: 5, source: "fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/text-to-video — $0.35 per 5 s + $0.07/extra s" },
  { provider: "fal", model: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video", task: "image-to-video", unit: "second", usd: 0.07, baseUsd: 0.35, baseUnits: 5, source: "fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video — $0.35 per 5 s + $0.07/extra s" },
  // ---- Replicate ----
  { provider: "replicate", model: "black-forest-labs/flux-schnell", task: "text-to-image", unit: "image", usd: 0.003, source: "replicate.com/black-forest-labs/flux-schnell — $0.003/image" },
  { provider: "replicate", model: "black-forest-labs/flux-dev", task: "text-to-image", unit: "image", usd: 0.025, source: "replicate.com/black-forest-labs/flux-dev — $0.025/image" },
  { provider: "replicate", model: "black-forest-labs/flux-1.1-pro", task: "text-to-image", unit: "image", usd: 0.04, source: "replicate.com/black-forest-labs/flux-1.1-pro — $0.04/image" },
  { provider: "replicate", model: "black-forest-labs/flux-kontext-pro", task: "edit-image", unit: "image", usd: 0.04, source: "replicate.com/black-forest-labs/flux-kontext-pro — $0.04/image" },
  { provider: "replicate", model: "black-forest-labs/flux-fill-pro", task: "edit-image", unit: "image", usd: 0.05, source: "replicate.com/black-forest-labs/flux-fill-pro — $0.05/image" },
  { provider: "replicate", model: "recraft-ai/recraft-remove-background", task: "remove-background", unit: "image", usd: 0.01, source: "replicate.com/recraft-ai/recraft-remove-background — $0.01/image" },
  { provider: "replicate", model: "recraft-ai/recraft-crisp-upscale", task: "upscale", unit: "image", usd: 0.006, source: "replicate.com/recraft-ai/recraft-crisp-upscale — $0.006/image" },
  { provider: "replicate", model: "kwaivgi/kling-v2.5-turbo-pro", task: "text-to-video", unit: "second", usd: 0.07, source: "replicate.com/kwaivgi/kling-v2.5-turbo-pro — $0.07/s" },
  { provider: "replicate", model: "google/veo-3.1-fast", task: "text-to-video", unit: "second", usd: 0.1, source: "replicate.com/google/veo-3.1-fast — $0.10/s without audio" },
  { provider: "replicate", model: "kwaivgi/kling-v2.5-turbo-pro#i2v", task: "image-to-video", unit: "second", usd: 0.07, source: "replicate.com/kwaivgi/kling-v2.5-turbo-pro (start_image) — $0.07/s" },
];

const OverridesSchema = z.record(z.number().nonnegative());

function overrides(): Record<string, number> {
  const raw = process.env.MEDIA_PRICE_OVERRIDES;
  if (!raw) return {};
  const parsed = OverridesSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`MEDIA_PRICE_OVERRIDES must be a JSON object of model -> USD per unit`);
  return parsed.data;
}

export function priceFor(model: string): ModelPrice {
  const p = PRICE_TABLE.find((x) => x.model === model);
  if (!p) throw new Error(`No media price for model "${model}" — add it to PRICE_TABLE in pricing.ts`);
  const o = overrides()[model];
  return o === undefined ? p : { ...p, usd: o, source: `${p.source} (overridden by MEDIA_PRICE_OVERRIDES)` };
}

/** Billable megapixels for n images as fal bills them (rounded up per image). */
export function megapixels(width: number, height: number, n = 1): number {
  return Math.ceil((width * height) / 1_000_000) * n;
}

/** Cost for `units` units of a model (megapixels, images or seconds). */
export function costForUnits(price: ModelPrice, units: number): number {
  let usd: number;
  if (price.baseUsd !== undefined && price.baseUnits !== undefined) {
    usd = price.baseUsd + Math.max(0, units - price.baseUnits) * price.usd;
  } else {
    usd = units * price.usd;
  }
  return Math.round(usd * 1e6) / 1e6;
}
