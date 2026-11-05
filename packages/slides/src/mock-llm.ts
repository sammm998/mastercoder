import { z } from "zod";
import { extractJson } from "@forge/shared";
import { registerMockHandler, type CompletionRequest } from "@forge/llm";
import { ContentDataSchema } from "./data.js";
import { ruleBasedDeckOutline, ruleBasedDocument } from "./rules.js";

/**
 * Rule-based mock handlers for @forge/slides (LLM_PROVIDER=mock). They build structured decks/documents from
 * the brief's nouns with fixed templates (pitch/report/training/general; market analysis/report) — not a model.
 * Output is tagged meta.generator = "rule-based mock (LLM_PROVIDER=mock)".
 */

function requestText(req: CompletionRequest): string {
  // The first user message carries the request (later ones are structured() retry feedback).
  const m = req.messages.find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

const DeckReq = z.object({ brief: z.string(), slideCount: z.number().int().min(1).max(40).default(10), data: ContentDataSchema.default({}) });
const DocReq = z.object({ brief: z.string(), data: ContentDataSchema.default({}) });

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, text: string, fallbackBrief: string): T {
  try {
    return schema.parse(extractJson(text));
  } catch {
    return schema.parse({ brief: fallbackBrief });
  }
}

registerMockHandler("slides.outline", (req) => {
  const text = requestText(req);
  const r = parse(DeckReq, text, text);
  return JSON.stringify(ruleBasedDeckOutline(r.brief, r.slideCount, r.data));
});

registerMockHandler("slides.document", (req) => {
  const text = requestText(req);
  const r = parse(DocReq, text, text);
  return JSON.stringify(ruleBasedDocument(r.brief, r.data));
});
