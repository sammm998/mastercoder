import { registerMockHandler } from "@forge/llm";
import { DOCS_PURPOSE, heuristicDocsSpec } from "./openapi/docs.js";

/**
 * LLM_PROVIDER=mock handler for "integrations.docs_to_openapi": the rule-based docs heuristic
 * (METHOD /path patterns + parameter tables). Rule-based, not a model.
 */
registerMockHandler(DOCS_PURPOSE, (req) => {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  const content = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const docs = /<docs>\n?([\s\S]*?)\n?<\/docs>/.exec(content)?.[1] ?? content;
  return JSON.stringify(heuristicDocsSpec(docs));
});
