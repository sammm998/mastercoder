import { z } from "zod";
import { getModels, structured, StructuredOutputError, type LLMProvider } from "@forge/llm";
import { DesignBriefSchema, type ArtDirection, type DesignBriefInput } from "./types.js";
import { hashString } from "./curated.js";

/**
 * A bespoke layout concept for one brief: the page structure, hero idea and signature interaction are
 * designed for this business instead of reusing a fixed section sequence.
 */
export const DesignConceptSchema = z.object({
  name: z.string().min(1).max(80),
  /** One paragraph: the big idea of the layout and why it fits this business. */
  idea: z.string().min(1).max(800),
  hero: z.string().min(1).max(600),
  sections: z
    .array(z.object({ id: z.string().min(1).max(40), purpose: z.string().min(1).max(300), layout: z.string().min(1).max(500) }))
    .min(3)
    .max(10),
  signature: z.string().min(1).max(500),
  imagery: z.string().min(1).max(500),
  typography: z.string().min(1).max(400),
  motion: z.string().min(1).max(400),
  /** Things this design deliberately avoids (generic patterns that would not fit). */
  avoid: z.array(z.string().max(160)).max(8).default([]),
  generatedBy: z.string().default("llm"),
});
export type DesignConcept = z.infer<typeof DesignConceptSchema>;

export const CONCEPT_SYSTEM = `You are a creative director at a top web studio (Awwwards Site of the Day calibre).
Design ONE bespoke website concept for the brief and the chosen art direction. It must feel made for this
specific business — its customers, offer, tone and industry — not a template.
Rules:
- Choose the page structure yourself: which sections exist, their order and their layout (asymmetric grids,
  full-bleed media, editorial columns, interactive tools, maps, menus, galleries, timelines …) as the business needs.
- Avoid the generic SaaS sequence (centered hero → three feature cards → testimonials → CTA) and the stock
  "bento grid + sticky story + horizontal scroll + marquee" combo unless it truly fits.
- Give the hero a concrete, distinctive idea (composition, type treatment, imagery, interaction).
- Name one signature interaction that makes the site memorable and is feasible in the browser.
- Describe imagery (what is photographed/illustrated), typography treatment and motion in concrete terms.
- Write in the brief's language for content ideas; keep it implementable in React + CSS in one build.
Return JSON: {name, idea, hero, sections:[{id, purpose, layout}], signature, imagery, typography, motion, avoid[]}.`;

export function conceptPrompt(briefIn: DesignBriefInput, direction: ArtDirection): string {
  const brief = DesignBriefSchema.parse(briefIn);
  return `<brief>${JSON.stringify(brief)}</brief>\n<art_direction>${JSON.stringify({ name: direction.name, mood: direction.mood, palette: direction.palette, typography: { display: direction.typography.display.family, body: direction.typography.body.family }, motion: direction.motion })}</art_direction>`;
}

/** Generate a bespoke concept (purpose "design.concept", MODEL_BUILDER); falls back to a rule-based one. */
export async function generateConcept(llm: LLMProvider, briefIn: DesignBriefInput, direction: ArtDirection, opts: { model?: string } = {}): Promise<DesignConcept> {
  try {
    const { value } = await structured(
      llm,
      { purpose: "design.concept", model: opts.model ?? getModels().builder, system: CONCEPT_SYSTEM, messages: [{ role: "user", content: conceptPrompt(briefIn, direction) }], maxTokens: 3000 },
      DesignConceptSchema,
      { retries: 2 },
    );
    return value;
  } catch (e) {
    if (!(e instanceof StructuredOutputError)) throw e;
    return ruleConcept(briefIn, direction);
  }
}

const LAYOUTS = [
  { name: "Editorial", hero: "oversized serif headline set across an asymmetric 12-column grid with one full-bleed photograph cropped off the right edge", signature: "images reveal through a clip-path wipe as they scroll into view" },
  { name: "Gallery", hero: "a horizontally draggable strip of large images with the name set small and precise in a corner", signature: "drag-to-explore gallery with inertia and a live counter" },
  { name: "Poster", hero: "a bold typographic poster: the headline fills the viewport, words staggered on separate lines with a colour block behind one word", signature: "the headline letters respond to the pointer with a subtle magnetic offset" },
  { name: "Split", hero: "a 50/50 split screen: sticky imagery on one side, scrolling narrative on the other", signature: "the sticky image cross-fades in sync with the chapter being read" },
];

/** Deterministic concept from the brief (used by the mock LLM and when the model output stays invalid). */
export function ruleConcept(briefIn: DesignBriefInput, direction: ArtDirection): DesignConcept {
  const brief = DesignBriefSchema.parse(briefIn);
  const l = LAYOUTS[hashString(brief.name + brief.description) % LAYOUTS.length]!;
  return {
    name: `${l.name} — ${direction.name}`,
    idea: `${l.name} layout for ${brief.name}: built around what visitors of this business need first, in the "${direction.mood}" mood.`,
    hero: l.hero,
    sections: [
      { id: "offer", purpose: `What ${brief.name} offers`, layout: "asymmetric two-column list with large numerals" },
      { id: "proof", purpose: "Why trust them", layout: "full-bleed quote with a portrait photograph" },
      { id: "visit", purpose: "How to buy, book or visit", layout: "practical details beside a clear primary action" },
    ],
    signature: l.signature,
    imagery: "real-looking photography of the product, place and people; no stock clichés",
    typography: `${direction.typography.display.family} for display at extreme sizes, ${direction.typography.body.family} for body`,
    motion: `${direction.motion.language}: ${direction.motion.description || "calm reveals"}`,
    avoid: ["centered hero with three feature cards"],
    generatedBy: "rules (fallback concept)",
  };
}

export function conceptToText(c: DesignConcept): string {
  return [
    `Design concept "${c.name}": ${c.idea}`,
    `Hero: ${c.hero}`,
    `Sections (in this order — this replaces the scaffold's default sections):`,
    ...c.sections.map((s, i) => `  ${i + 1}. ${s.id} — ${s.purpose}. Layout: ${s.layout}`),
    `Signature interaction: ${c.signature}`,
    `Imagery: ${c.imagery}`,
    `Typography: ${c.typography}`,
    `Motion: ${c.motion}`,
    c.avoid.length ? `Avoid: ${c.avoid.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
