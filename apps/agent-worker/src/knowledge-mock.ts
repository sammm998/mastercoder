import { registerMockHandler } from "@forge/llm";

/**
 * LLM_PROVIDER=mock handler for "knowledge.profile": a rule-based extract (first sentences of the
 * first pages), clearly labelled — not a model summary.
 */
registerMockHandler("knowledge.profile", (req) => {
  const last = req.messages[req.messages.length - 1];
  const text = typeof last?.content === "string" ? last.content : "";
  const titles = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!).slice(0, 5);
  const firsts = text.split(/^## .+$/m).map((b) => b.trim().split(/(?<=[.!?])\s/)[0] ?? "").filter((s) => s.length > 20).slice(0, 6);
  return `[mock profile — rule-based extract, not a model summary]\nPages: ${titles.join("; ")}\n${firsts.map((f) => `- ${f}`).join("\n")}`;
});
