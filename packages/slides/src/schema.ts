import { z } from "zod";

const Hex = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "expected a hex colour like #1a2b3c");

export const DeckThemeSchema = z.object({
  colors: z.object({
    bg: Hex,
    surface: Hex,
    text: Hex,
    muted: Hex,
    accent: Hex,
    accent2: Hex,
    border: Hex.optional(),
  }),
  fonts: z.object({ display: z.string().min(1), body: z.string().min(1) }),
});
export type DeckTheme = z.infer<typeof DeckThemeSchema>;

export const ImageRefSchema = z
  .object({
    url: z.string().optional(),
    artifactId: z.string().optional(),
    prompt: z.string().optional(),
    alt: z.string().min(1),
  })
  .refine((i) => Boolean(i.url || i.artifactId || i.prompt), "image needs url, artifactId or prompt");
export type ImageRef = z.infer<typeof ImageRefSchema>;

export const ChartTypeSchema = z.enum(["bar", "line", "pie", "doughnut"]);
export const ChartSchema = z
  .object({
    type: ChartTypeSchema,
    title: z.string().optional(),
    labels: z.array(z.string()).min(1).max(24),
    series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).min(1).max(8),
    /** Optional unit suffix for value labels, e.g. "%", " kSEK". */
    unit: z.string().max(12).optional(),
  })
  .refine((c) => c.series.every((s) => s.values.length === c.labels.length), "every series needs one value per label")
  .refine((c) => (c.type === "pie" || c.type === "doughnut" ? c.series.length === 1 : true), "pie/doughnut charts take exactly one series");
export type Chart = z.infer<typeof ChartSchema>;

export const SlideLayoutSchema = z.enum(["title", "section", "bullets", "two-column", "image-left", "image-full", "chart", "quote", "stats", "timeline", "closing"]);
export type SlideLayout = z.infer<typeof SlideLayoutSchema>;

export const ColumnSchema = z.object({ heading: z.string().optional(), bullets: z.array(z.string()).optional(), body: z.string().optional() });

export const SlideSchema = z.object({
  id: z.string().min(1).max(64),
  layout: SlideLayoutSchema,
  title: z.string().max(200),
  subtitle: z.string().max(300).optional(),
  bullets: z.array(z.string().max(400)).max(10).optional(),
  body: z.string().max(2000).optional(),
  columns: z.array(ColumnSchema).max(3).optional(),
  image: ImageRefSchema.optional(),
  chart: ChartSchema.optional(),
  stats: z.array(z.object({ value: z.string().max(24), label: z.string().max(120) })).max(6).optional(),
  quote: z.object({ text: z.string().max(600), author: z.string().max(120) }).optional(),
  timeline: z.array(z.object({ label: z.string().max(40), text: z.string().max(200) })).max(8).optional(),
  notes: z.string().max(4000).default(""),
});
export type Slide = z.infer<typeof SlideSchema>;
export type SlideInput = z.input<typeof SlideSchema>;

export const DeckSchema = z
  .object({
    title: z.string().min(1).max(200),
    theme: DeckThemeSchema,
    slides: z.array(SlideSchema).min(1).max(60),
    /** Provenance, e.g. { generator: "rule-based mock" | "llm", deckType }. */
    meta: z.record(z.unknown()).optional(),
  })
  .refine((d) => new Set(d.slides.map((s) => s.id)).size === d.slides.length, "slide ids must be unique");
export type Deck = z.infer<typeof DeckSchema>;
export type DeckInput = z.input<typeof DeckSchema>;

/** What the LLM returns for "slides.outline" (the theme is applied by Forge afterwards). */
export const DeckOutlineSchema = z.object({
  title: z.string().min(1).max(200),
  slides: z.array(SlideSchema).min(1).max(60),
  meta: z.record(z.unknown()).optional(),
});
export type DeckOutline = z.infer<typeof DeckOutlineSchema>;

// ---------------- documents ----------------

export const DocBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: z.string().max(6000) }),
  z.object({ type: z.literal("bullets"), items: z.array(z.string().max(1000)).min(1).max(40) }),
  z.object({ type: z.literal("numbered"), items: z.array(z.string().max(1000)).min(1).max(40) }),
  z.object({
    type: z.literal("table"),
    caption: z.string().max(300).optional(),
    headers: z.array(z.string().max(200)).min(1).max(10),
    rows: z.array(z.array(z.string().max(500))).max(100),
  }),
  z.object({ type: z.literal("image"), image: ImageRefSchema, caption: z.string().max(300).optional() }),
  z.object({ type: z.literal("chart"), chart: ChartSchema, caption: z.string().max(300).optional() }),
  z.object({ type: z.literal("callout"), tone: z.enum(["info", "warning", "success", "note"]), title: z.string().max(200).optional(), text: z.string().max(2000) }),
]);
export type DocBlock = z.infer<typeof DocBlockSchema>;

export const DocSectionSchema = z.object({
  id: z.string().min(1).max(64),
  heading: z.string().min(1).max(200),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  blocks: z.array(DocBlockSchema).max(60),
});
export type DocSection = z.infer<typeof DocSectionSchema>;

export const DocSchema = z
  .object({
    title: z.string().min(1).max(200),
    subtitle: z.string().max(300).optional(),
    author: z.string().max(200).optional(),
    date: z.string().max(40).optional(),
    theme: DeckThemeSchema.optional(),
    sections: z.array(DocSectionSchema).min(1).max(80),
    meta: z.record(z.unknown()).optional(),
  })
  .superRefine((d, ctx) => {
    for (const s of d.sections) {
      for (const b of s.blocks) {
        if (b.type === "table" && b.rows.some((r) => r.length !== b.headers.length)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `table in section "${s.id}" has rows that do not match the header count` });
        }
      }
    }
  });
export type Doc = z.infer<typeof DocSchema>;
export type DocInput = z.input<typeof DocSchema>;

export function parseDeck(input: unknown): Deck {
  return DeckSchema.parse(input);
}
export function parseDoc(input: unknown): Doc {
  return DocSchema.parse(input);
}
