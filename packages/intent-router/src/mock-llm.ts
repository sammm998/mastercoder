import { registerMockHandler } from "@forge/llm";
import { CLASSIFY_PURPOSE, type LlmClassification } from "./classify.js";
import { classifyByRules, type Attachment } from "./rules.js";

/**
 * LLM_PROVIDER=mock handler for "intent.classify": the rule-based sv/en multi-label classifier.
 * Deterministic and rule-based (results are labelled engine "mock-rules"), not a model.
 */
registerMockHandler(CLASSIFY_PURPOSE, (req) => {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  const content = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
  let payload: { prompt?: string; source?: "typed" | "voice" | "meeting" | "api"; attachments?: Attachment[] } = {};
  try {
    payload = JSON.parse(content) as typeof payload;
  } catch {
    payload = { prompt: content };
  }
  const r = classifyByRules(payload.prompt ?? "", { ...(payload.source ? { source: payload.source } : {}), ...(payload.attachments ? { attachments: payload.attachments } : {}) });
  const out: LlmClassification = {
    language: r.language,
    intents: r.intents,
    ambiguous: r.ambiguous,
    ...(r.ambiguityReason ? { ambiguityReason: r.ambiguityReason } : {}),
    ...(r.question ? { question: r.question } : {}),
    ...(r.options ? { options: r.options } : {}),
    complexity: r.complexity,
    quantities: r.quantities,
  };
  return JSON.stringify(out);
});
