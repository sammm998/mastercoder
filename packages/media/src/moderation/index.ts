import { ForgeError } from "@forge/shared";
import { moderate, type ModerateOptions, type ModerationInput, type ModerationResult } from "./moderate.js";

export * from "./moderate.js";
export { normalizeForModeration } from "./normalize.js";

/** Moderate and throw ForgeError("MODERATION_BLOCKED") when not allowed. */
export async function assertAllowed(input: ModerationInput, opts: ModerateOptions = {}): Promise<ModerationResult> {
  const r = await moderate(input, opts);
  if (!r.allowed) {
    throw new ForgeError("MODERATION_BLOCKED", r.reason, { category: r.category, source: r.source, matched: r.matched });
  }
  return r;
}
