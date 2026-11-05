import { createHash } from "node:crypto";

export type GuardDecision =
  | { action: "continue" }
  | { action: "change_strategy"; reason: string; strategy: "reread_files" | "search_docs" | "replan" }
  | { action: "stop"; reason: string };

/** Normalise an error so the same failure with different line numbers/paths/timings still matches. */
export function errorSignature(error: string): string {
  const norm = error
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "<t>")
    .replace(/:\d+:\d+/g, ":<l>")
    .replace(/\(\d+,\d+\)/g, "(<l>)")
    .replace(/\/tmp\/[^\s:]+/g, "<tmp>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  return createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

/**
 * Loop guard for one task: at most `maxIterations` fix iterations; after `sameErrorLimit` identical
 * errors in a row the agent must change strategy (re-read files → search docs → re-plan); if the same
 * error persists after every strategy, stop.
 */
export class LoopGuard {
  private iterations = 0;
  private lastSig: string | null = null;
  private streak = 0;
  private strategiesTried: Array<"reread_files" | "search_docs" | "replan"> = [];
  readonly history: Array<{ iteration: number; signature: string }> = [];

  constructor(
    private readonly maxIterations = 8,
    private readonly sameErrorLimit = 3,
  ) {}

  get count(): number {
    return this.iterations;
  }

  recordFailure(error: string): GuardDecision {
    this.iterations++;
    const sig = errorSignature(error);
    this.history.push({ iteration: this.iterations, signature: sig });
    this.streak = sig === this.lastSig ? this.streak + 1 : 1;
    this.lastSig = sig;
    if (this.iterations >= this.maxIterations) {
      return { action: "stop", reason: `Reached the limit of ${this.maxIterations} fix iterations` };
    }
    if (this.streak >= this.sameErrorLimit) {
      const next = (["reread_files", "search_docs", "replan"] as const).find((s) => !this.strategiesTried.includes(s));
      if (!next) return { action: "stop", reason: `The same error repeated ${this.streak} times after trying every strategy` };
      this.strategiesTried.push(next);
      this.streak = 0;
      return { action: "change_strategy", reason: `The same error occurred ${this.sameErrorLimit} times in a row`, strategy: next };
    }
    return { action: "continue" };
  }
}
