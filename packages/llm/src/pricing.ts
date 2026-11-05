import type { TokenUsage } from "./types.js";

/** USD per 1M tokens. Cache write billed at 1.25x input (5-minute TTL). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
};

const FALLBACK: ModelPrice = { input: 4, output: 20, cacheRead: 0.4 };

export function priceFor(model: string): ModelPrice {
  return MODEL_PRICES[model] ?? FALLBACK;
}

export function costFor(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  const usd =
    (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.input * 1.25) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** Rough token estimate (4 chars/token) for estimates before a call. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
