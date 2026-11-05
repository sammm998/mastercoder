import { z } from "zod";

/**
 * Wire protocol of the Forge AI gateway. Generated apps call it server-side with
 * `Authorization: Bearer $FORGE_PROJECT_TOKEN` at `$FORGE_AI_GATEWAY_URL/v1/<route>`; the kit
 * client (kit/common/ai/src/lib/forge-ai.ts) mirrors these shapes.
 */
export const GATEWAY_ROUTES = ["chat", "image", "stt", "tts"] as const;
export type GatewayRoute = (typeof GATEWAY_ROUTES)[number];

export const ChatRequestSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(100_000) }))
    .min(1)
    .max(100),
  system: z.string().max(20_000).optional(),
  maxTokens: z.number().int().min(1).max(8192).default(1024),
  /** fast = cheapest model, standard = default, smart = most capable. */
  tier: z.enum(["fast", "standard", "smart"]).default("standard"),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ImageRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).default("1024x1024"),
  n: z.number().int().min(1).max(4).default(1),
});
export type ImageRequest = z.infer<typeof ImageRequestSchema>;

/** ~25 MB of audio as base64. */
const MAX_AUDIO_B64 = 34_000_000;
export const SttRequestSchema = z.object({
  audio: z.string().min(1).max(MAX_AUDIO_B64).regex(/^[A-Za-z0-9+/=_-]+$/, "audio must be base64"),
  mediaType: z.string().regex(/^audio\/[\w.+-]+$/),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
});
export type SttRequest = z.infer<typeof SttRequestSchema>;

export const TtsRequestSchema = z.object({
  text: z.string().min(1).max(5000),
  voice: z.string().max(100).optional(),
  format: z.enum(["mp3", "wav"]).default("mp3"),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
});
export type TtsRequest = z.infer<typeof TtsRequestSchema>;

export interface ChatResponse {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
}
export interface ImageResponse {
  images: Array<{ mediaType: string; data: string }>;
  model: string;
  costUsd: number;
}
export interface SttResponse {
  text: string;
  durationSec: number;
  language?: string;
  model: string;
  costUsd: number;
}
/** TTS responds with raw audio bytes; cost and model travel in these headers. */
export const TTS_COST_HEADER = "x-forge-cost-usd";
export const TTS_MODEL_HEADER = "x-forge-model";
