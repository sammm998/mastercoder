import { z } from "zod";

export const UsageKind = z.enum([
  "llm_input_tokens",
  "llm_output_tokens",
  "llm_cache_read_tokens",
  "llm_cache_write_tokens",
  "sandbox_minutes",
  "media_seconds",
  "image_count",
  "transcription_minutes",
  "bot_hours",
  "hosting_hours",
  "agent_run",
]);
export type UsageKind = z.infer<typeof UsageKind>;

export const UsageRecordSchema = z.object({
  kind: UsageKind,
  quantity: z.number().nonnegative(),
  /** Cost to Forge in USD (provider cost). */
  costUsd: z.number().nonnegative(),
  provider: z.string(),
  model: z.string().optional(),
  workspaceId: z.string().optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  at: z.string().datetime().optional(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export interface CostEstimate {
  /** Expected price charged to the user in USD. */
  lowUsd: number;
  highUsd: number;
  breakdown: Array<{ label: string; usd: number }>;
}

/** Anything that records metered usage (billing, tracing, tests). */
export interface UsageSink {
  record(r: UsageRecord): void | Promise<void>;
}

export class MemoryUsageSink implements UsageSink {
  readonly records: UsageRecord[] = [];
  record(r: UsageRecord): void {
    this.records.push({ ...r, at: r.at ?? new Date().toISOString() });
  }
  totalUsd(filter?: (r: UsageRecord) => boolean): number {
    return this.records.filter(filter ?? (() => true)).reduce((a, r) => a + r.costUsd, 0);
  }
}

export function sumEstimate(parts: Array<{ label: string; usd: number }>, spread = 0.3): CostEstimate {
  const total = parts.reduce((a, p) => a + p.usd, 0);
  return {
    lowUsd: round4(total * (1 - spread)),
    highUsd: round4(total * (1 + spread)),
    breakdown: parts.map((p) => ({ ...p, usd: round4(p.usd) })),
  };
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
