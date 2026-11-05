/**
 * Rule-based mock handlers for every LLM purpose used by @forge/design, so LLM_PROVIDER=mock works
 * end-to-end. Outputs are deterministic, curated/heuristic and labeled as such — never model output.
 */
import { registerMockHandler, type ChatMessage, type CompletionRequest } from "@forge/llm";
import { mockCopy } from "./compose/content.js";
import { curatedDirections } from "./curated.js";
import { heuristicCritique } from "./qa/critic-heuristic.js";
import { BrandInputSchema, DesignBriefSchema } from "./types.js";

function allText(messages: ChatMessage[]): string {
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")))
    .join("\n");
}

function tagged(req: CompletionRequest, tag: string): unknown {
  const text = allText(req.messages);
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  if (!m?.[1]) return undefined;
  return JSON.parse(m[1]);
}

let registered = false;

export function registerDesignMocks(): void {
  if (registered) return;
  registered = true;
  registerMockHandler("design.directions", (req) => {
    const brief = DesignBriefSchema.parse(tagged(req, "brief"));
    const brandRaw = tagged(req, "brand");
    const brand = brandRaw ? BrandInputSchema.parse(brandRaw) : undefined;
    return JSON.stringify({ directions: curatedDirections(brief, brand) });
  });
  registerMockHandler("design.copy", (req) => {
    const brief = DesignBriefSchema.parse(tagged(req, "brief"));
    return JSON.stringify(mockCopy(brief));
  });
  registerMockHandler("design.critic", (req) => {
    const metrics = tagged(req, "heuristics");
    return JSON.stringify(heuristicCritique(metrics));
  });
}

registerDesignMocks();
