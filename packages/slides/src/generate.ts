import { z } from "zod";
import { sumEstimate, type CostEstimate, type UsageSink } from "@forge/shared";
import { MeteredLLM, costFor, estimateTokens, getModels, structured, type LLMProvider, type MeterContext } from "@forge/llm";
import { DeckOutlineSchema, DeckSchema, DeckThemeSchema, DocSchema, type Deck, type DeckTheme, type Doc } from "./schema.js";
import { ContentDataSchema, type ContentData } from "./data.js";
import { DEFAULT_THEME, LIGHT_THEME, themeFromTokens } from "./theme.js";
import { resolveDeckImages, resolveDocImages, type ImageResolver } from "./images.js";

export interface GenerateDeckRequest {
  brief: string;
  slideCount?: number;
  /** A DeckTheme, or loose design tokens (see themeFromTokens). */
  theme?: DeckTheme | Record<string, unknown>;
  /** Facts to use instead of placeholders (metrics, charts, team, …). */
  data?: ContentData;
  model?: string;
  /** Meter LLM usage into this sink (wraps the provider in MeteredLLM). */
  sink?: UsageSink;
  meter?: MeterContext;
  /** Resolve image prompts to real images right away. */
  images?: ImageResolver;
}

export interface GenerateResult<T> {
  value: T;
  costUsd: number;
  model: string;
  /** True when the provider is the rule-based mock. */
  mock: boolean;
}

const RequestSchema = z.object({ brief: z.string().min(3).max(8000), slideCount: z.number().int().min(1).max(40), data: ContentDataSchema });

export const DECK_SYSTEM = `You are Forge's presentation writer. Produce a slide deck outline as JSON:
{"title": string, "slides": [{"id": kebab-case unique string, "layout": "title"|"section"|"bullets"|"two-column"|"image-left"|"image-full"|"chart"|"quote"|"stats"|"timeline"|"closing",
 "title": string, "subtitle"?: string, "bullets"?: string[] (max 6, short), "body"?: string, "columns"?: [{"heading"?, "bullets"?, "body"?}] (2 columns),
 "image"?: {"prompt": string, "alt": string}, "chart"?: {"type": "bar"|"line"|"pie"|"doughnut", "title"?, "labels": string[], "series": [{"name", "values": number[]}]},
 "stats"?: [{"value", "label"}], "quote"?: {"text", "author"}, "timeline"?: [{"label", "text"}], "notes": string (speaker notes)}]}
Rules: exactly the requested number of slides; first slide layout "title"; use the user's language; never invent statistics, prices,
customers or quotes — use the provided data, otherwise write explicit placeholders like "[add figure]"; charts only from provided data;
every slide gets useful speaker notes. Common structures: pitch deck (problem, solution, market, product, business model, traction,
competition, team, financials/ask), report deck (summary, metrics, trends, challenges, outlook, recommendations), training deck
(agenda, objectives, modules, examples, exercises, summary).`;

export const DOC_SYSTEM = `You are Forge's report writer. Produce a document as JSON:
{"title", "subtitle"?, "author"?, "sections": [{"id": kebab-case, "heading", "level": 1|2|3, "blocks": [
 {"type":"paragraph","text"} | {"type":"bullets","items"} | {"type":"numbered","items"} | {"type":"table","caption"?,"headers","rows"} |
 {"type":"image","image":{"prompt","alt"},"caption"?} | {"type":"chart","chart":{...},"caption"?} | {"type":"callout","tone":"info"|"warning"|"success"|"note","title"?,"text"}]}]}
Rules: use the user's language; never invent figures or sources — use provided data or "[add figure]"/"[add source]" placeholders;
table rows must match the header count. A market analysis has: executive summary, market size, customer segments (table),
competitive landscape (table), trends, risks, recommendations, methodology & sources.`;

function asTheme(theme: GenerateDeckRequest["theme"], fallback: DeckTheme): DeckTheme {
  if (!theme) return fallback;
  const direct = DeckThemeSchema.safeParse(theme);
  return direct.success ? direct.data : themeFromTokens(theme as Record<string, unknown>, fallback);
}

function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const n = seen.get(it.id) ?? 0;
    seen.set(it.id, n + 1);
    return n === 0 ? it : { ...it, id: `${it.id}-${n + 1}` };
  });
}

/** Generate a themed deck from a brief (LLM purpose "slides.outline", structured output validated with zod). */
export async function generateDeck(llm: LLMProvider, req: GenerateDeckRequest): Promise<GenerateResult<Deck>> {
  const input = RequestSchema.parse({ brief: req.brief, slideCount: req.slideCount ?? 10, data: req.data ?? {} });
  const model = req.model ?? getModels().builder;
  const provider = req.sink ? new MeteredLLM(llm, req.sink, req.meter) : llm;
  const { value, responses } = await structured(
    provider,
    { purpose: "slides.outline", model, system: DECK_SYSTEM, cache: true, maxTokens: 12000, messages: [{ role: "user", content: JSON.stringify(input) }] },
    DeckOutlineSchema,
  );
  let deck = DeckSchema.parse({
    title: value.title,
    theme: asTheme(req.theme, DEFAULT_THEME),
    slides: uniqueIds(value.slides),
    meta: { ...value.meta, generator: llm.isMock ? (value.meta?.generator ?? "rule-based mock") : "llm", model, brief: input.brief.slice(0, 500) },
  });
  if (req.images) deck = await resolveDeckImages(deck, req.images);
  return { value: deck, costUsd: responses.reduce((a, r) => a + r.costUsd, 0), model, mock: llm.isMock };
}

export interface GenerateDocumentRequest {
  brief: string;
  data?: ContentData;
  theme?: DeckTheme | Record<string, unknown>;
  author?: string;
  model?: string;
  sink?: UsageSink;
  meter?: MeterContext;
  images?: ImageResolver;
}

/** Generate a document/report from a brief (LLM purpose "slides.document"). */
export async function generateDocument(llm: LLMProvider, req: GenerateDocumentRequest): Promise<GenerateResult<Doc>> {
  const brief = z.string().min(3).max(8000).parse(req.brief);
  const data = ContentDataSchema.parse(req.data ?? {});
  const model = req.model ?? getModels().builder;
  const provider = req.sink ? new MeteredLLM(llm, req.sink, req.meter) : llm;
  const { value, responses } = await structured(
    provider,
    { purpose: "slides.document", model, system: DOC_SYSTEM, cache: true, maxTokens: 12000, messages: [{ role: "user", content: JSON.stringify({ brief, data }) }] },
    DocSchema,
  );
  let doc: Doc = DocSchema.parse({
    ...value,
    sections: uniqueIds(value.sections),
    author: req.author ?? value.author,
    date: value.date ?? new Date().toISOString().slice(0, 10),
    theme: req.theme ? asTheme(req.theme, LIGHT_THEME) : value.theme,
    meta: { ...value.meta, generator: llm.isMock ? (value.meta?.generator ?? "rule-based mock") : "llm", model },
  });
  if (req.images) doc = await resolveDocImages(doc, req.images);
  return { value: doc, costUsd: responses.reduce((a, r) => a + r.costUsd, 0), model, mock: llm.isMock };
}

/** Pre-run LLM cost estimate for a deck (≈220 output tokens per slide; prices from @forge/llm). */
export function estimateDeck(req: { brief: string; slideCount?: number; model?: string }): CostEstimate {
  const model = req.model ?? getModels().builder;
  const inputTokens = estimateTokens(DECK_SYSTEM + req.brief) + 200;
  const outputTokens = 220 * (req.slideCount ?? 10) + 150;
  const usd = costFor(model, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  return sumEstimate([{ label: `${model} outline (${req.slideCount ?? 10} slides)`, usd }], 0.4);
}

/** Pre-run LLM cost estimate for a document (≈3k output tokens). */
export function estimateDocument(req: { brief: string; model?: string }): CostEstimate {
  const model = req.model ?? getModels().builder;
  const inputTokens = estimateTokens(DOC_SYSTEM + req.brief) + 200;
  const usd = costFor(model, { inputTokens, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  return sumEstimate([{ label: `${model} document`, usd }], 0.4);
}
