import { extractJson } from "@forge/shared";
import { registerMockHandler, type ContentBlock } from "@forge/llm";
import { moderateRules } from "./moderation/moderate.js";

/**
 * Rule-based mock handlers for the LLM purposes used by @forge/media (LLM_PROVIDER=mock).
 * "media.moderate": re-runs the deterministic lexicon rules on the prompt in the request — it is NOT a model
 * judgement and says so in its reason.
 */
registerMockHandler("media.moderate", (req) => {
  const last = req.messages[req.messages.length - 1];
  const text = typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
  let prompt = text;
  try {
    const parsed = extractJson(text) as { prompt?: unknown };
    if (typeof parsed.prompt === "string") prompt = parsed.prompt;
  } catch {
    // plain-text prompt
  }
  const r = moderateRules({ prompt });
  return JSON.stringify({ allowed: r.allowed, category: r.category ?? null, reason: `[mock rule-based check] ${r.reason}` });
});
