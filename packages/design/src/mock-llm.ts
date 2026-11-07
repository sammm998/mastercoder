/**
 * Rule-based mock handlers for every LLM purpose used by @forge/design, so LLM_PROVIDER=mock works
 * end-to-end. Outputs are deterministic, curated/heuristic and labeled as such — never model output.
 */
import { ruleConcept } from "./concept.js";
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
  registerMockHandler("design.concept", (req) => {
    const brief = DesignBriefSchema.parse(tagged(req, "brief"));
    const dir = tagged(req, "art_direction") as { name?: string; mood?: string; typography?: { display?: string; body?: string }; motion?: { language?: string; description?: string } };
    const direction = { name: dir.name ?? "Direction", mood: dir.mood ?? "", typography: { display: { family: dir.typography?.display ?? "Inter" }, body: { family: dir.typography?.body ?? "Inter" } }, motion: { language: dir.motion?.language ?? "calm", description: dir.motion?.description ?? "" } };
    return JSON.stringify({ ...ruleConcept(brief, direction as never), generatedBy: "mock-designer (rule-based)" });
  });
  registerMockHandler("design.critic", (req) => {
    const metrics = tagged(req, "heuristics");
    return JSON.stringify(heuristicCritique(metrics));
  });
}

registerDesignMocks();
