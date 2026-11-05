import { ForgeError, sumEstimate, type CostEstimate, type Intent, type IntentKind, type UsageKind } from "@forge/shared";
import { costFor, getModels, type ModelConfig, type StepComplexity } from "@forge/llm";
import { PROVIDER_UNIT_COST, priceFor } from "./pricing.js";

type Role = keyof ModelConfig;

interface Step {
  label: string;
  role: Role;
  /** Input tokens at "normal" complexity. */
  input: number;
  output: number;
  /** Share of input served from the prompt cache (agent loops re-send the same prefix). */
  cached?: number;
}

interface KindBudget {
  steps: Step[];
  sandboxMinutes: number;
}

/**
 * Heuristic token budgets per intent kind at "normal" complexity, calibrated from typical agent runs
 * (plan -> build loop with tool calls -> review). Build loops are dominated by cached context reads.
 */
export const BUDGETS: Record<IntentKind, KindBudget> = {
  app: {
    steps: [
      { label: "plan & spec", role: "planner", input: 40_000, output: 8_000 },
      { label: "build", role: "builder", input: 900_000, output: 60_000, cached: 0.8 },
      { label: "review & fixes", role: "fast", input: 120_000, output: 8_000, cached: 0.5 },
    ],
    sandboxMinutes: 25,
  },
  website: {
    steps: [
      { label: "plan & art direction", role: "planner", input: 40_000, output: 10_000 },
      { label: "build", role: "builder", input: 600_000, output: 45_000, cached: 0.8 },
      { label: "visual QA", role: "vision", input: 60_000, output: 4_000 },
    ],
    sandboxMinutes: 15,
  },
  mobile: {
    steps: [
      { label: "plan & spec", role: "planner", input: 40_000, output: 8_000 },
      { label: "build", role: "builder", input: 800_000, output: 60_000, cached: 0.8 },
      { label: "review & fixes", role: "fast", input: 100_000, output: 6_000, cached: 0.5 },
    ],
    sandboxMinutes: 25,
  },
  backend: {
    steps: [
      { label: "plan & API design", role: "planner", input: 25_000, output: 5_000 },
      { label: "build", role: "builder", input: 400_000, output: 30_000, cached: 0.8 },
      { label: "review & fixes", role: "fast", input: 60_000, output: 4_000, cached: 0.5 },
    ],
    sandboxMinutes: 12,
  },
  image: {
    steps: [{ label: "prompting & moderation", role: "fast", input: 6_000, output: 1_500 }],
    sandboxMinutes: 0,
  },
  video: {
    steps: [{ label: "script & shot list", role: "planner", input: 8_000, output: 2_000 }],
    sandboxMinutes: 0,
  },
  slides: {
    steps: [{ label: "outline", role: "planner", input: 10_000, output: 3_000 }],
    sandboxMinutes: 2,
  },
  document: {
    steps: [
      { label: "outline & research", role: "planner", input: 15_000, output: 4_000 },
      { label: "writing", role: "builder", input: 60_000, output: 20_000, cached: 0.5 },
    ],
    sandboxMinutes: 2,
  },
  agent: {
    steps: [
      { label: "agent design", role: "planner", input: 20_000, output: 5_000 },
      { label: "tools & triggers", role: "builder", input: 120_000, output: 12_000, cached: 0.6 },
      { label: "evals", role: "fast", input: 40_000, output: 4_000 },
    ],
    sandboxMinutes: 3,
  },
  integration: {
    steps: [
      { label: "connector / API wiring", role: "builder", input: 80_000, output: 8_000, cached: 0.6 },
      { label: "contract checks", role: "fast", input: 20_000, output: 2_000 },
    ],
    sandboxMinutes: 2,
  },
  question: {
    steps: [{ label: "answer", role: "fast", input: 6_000, output: 1_000 }],
    sandboxMinutes: 0,
  },
};

export const COMPLEXITY_FACTOR: Record<StepComplexity, number> = { trivial: 0.4, normal: 1, complex: 2.5 };
/** Uncertainty band of the estimate (low = total × (1 − s), high = total × (1 + s)). */
export const COMPLEXITY_SPREAD: Record<StepComplexity, number> = { trivial: 0.25, normal: 0.35, complex: 0.5 };

export const DEFAULTS = { mediaSeconds: 10, images: 4, slides: 10 } as const;

export interface EstimateInput {
  intents: Array<IntentKind | Pick<Intent, "kind" | "hint">>;
  complexity?: StepComplexity;
  /** Total seconds of generated/rendered video. */
  mediaSeconds?: number;
  images?: number;
  slides?: number;
  models?: ModelConfig;
}

function stepUsd(step: Step, factor: number, models: ModelConfig): number {
  const input = Math.round(step.input * factor);
  const cached = Math.round(input * (step.cached ?? 0));
  const usage = { inputTokens: step.cached ? 0 : input, cacheReadTokens: cached, cacheWriteTokens: step.cached ? input - cached : 0, outputTokens: Math.round(step.output * factor) };
  return priceFor("llm_input_tokens", costFor(models[step.role], usage), 0);
}

function unitUsd(kind: Exclude<UsageKind, `llm_${string}`>, quantity: number): number {
  return priceFor(kind, PROVIDER_UNIT_COST[kind] * quantity, quantity);
}

/**
 * User-facing cost estimate shown before work starts: per-intent token budgets × model prices
 * (`costFor` from @forge/llm, models from env) × markup, plus sandbox minutes and media units.
 */
export function estimateTask(input: EstimateInput): CostEstimate {
  const complexity = input.complexity ?? "normal";
  const factor = COMPLEXITY_FACTOR[complexity];
  const models = input.models ?? getModels();
  const seen = new Set<IntentKind>();
  const intents = input.intents.map((i) => (typeof i === "string" ? { kind: i } : i)).filter((i) => (seen.has(i.kind) ? false : (seen.add(i.kind), true)));
  if (intents.length === 0) throw new ForgeError("BAD_INPUT", "estimateTask needs at least one intent");
  for (const n of [input.mediaSeconds, input.images, input.slides]) if (n !== undefined && (!Number.isFinite(n) || n < 0 || n > 10_000)) throw new ForgeError("BAD_INPUT", "Invalid media quantity");
  const parts: Array<{ label: string; usd: number }> = [];
  for (const intent of intents) {
    const b = BUDGETS[intent.kind];
    for (const s of b.steps) parts.push({ label: `${intent.kind}: ${s.label} (${models[s.role]})`, usd: stepUsd(s, factor, models) });
    const minutes = b.sandboxMinutes * factor;
    if (minutes > 0) parts.push({ label: `${intent.kind}: sandbox ~${Math.round(minutes)} min`, usd: unitUsd("sandbox_minutes", minutes) });
    if (intent.kind === "image") {
      const n = input.images ?? DEFAULTS.images;
      parts.push({ label: `image: ${n} image${n === 1 ? "" : "s"}`, usd: unitUsd("image_count", n) });
    }
    if (intent.kind === "video") {
      const secs = input.mediaSeconds ?? DEFAULTS.mediaSeconds;
      if (intent.hint === "remotion") {
        // Programmatic video: composition code + local render in the sandbox (~0.15 min per output second).
        parts.push({ label: `video: composition code (${models.builder})`, usd: stepUsd({ label: "", role: "builder", input: 200_000, output: 20_000, cached: 0.7 }, factor, models) });
        parts.push({ label: `video: render ${secs} s (sandbox)`, usd: unitUsd("sandbox_minutes", 2 + secs * 0.15) });
      } else {
        parts.push({ label: `video: ${secs} s generation`, usd: unitUsd("media_seconds", secs) });
      }
    }
    if (intent.kind === "slides") {
      const n = input.slides ?? DEFAULTS.slides;
      parts.push({ label: `slides: ${n} slides (${models.builder})`, usd: stepUsd({ label: "", role: "builder", input: 6_000 * n, output: 1_500 * n, cached: 0.5 }, factor, models) });
    }
  }
  return sumEstimate(parts, COMPLEXITY_SPREAD[complexity]);
}
