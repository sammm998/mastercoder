import { z } from "zod";
import { ForgeError } from "@forge/shared";
import { DeckSchema, DeckThemeSchema, SlideLayoutSchema, SlideSchema, type Deck, type Slide, type SlideLayout } from "./schema.js";

const SlidePatchSchema = SlideSchema.omit({ id: true }).partial();

export const DeckEditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setTitle"), title: z.string().min(1).max(200) }),
  z.object({ op: z.literal("updateSlide"), slideId: z.string(), patch: SlidePatchSchema }),
  z.object({ op: z.literal("addSlide"), slide: SlideSchema.partial({ id: true, notes: true }), index: z.number().int().nonnegative().optional() }),
  z.object({ op: z.literal("removeSlide"), slideId: z.string() }),
  z.object({ op: z.literal("moveSlide"), slideId: z.string(), toIndex: z.number().int().nonnegative() }),
  z.object({ op: z.literal("duplicateSlide"), slideId: z.string() }),
  z.object({ op: z.literal("changeLayout"), slideId: z.string(), layout: SlideLayoutSchema }),
  z.object({
    op: z.literal("changeTheme"),
    theme: z.object({ colors: DeckThemeSchema.shape.colors.partial().optional(), fonts: DeckThemeSchema.shape.fonts.partial().optional() }),
  }),
]);
export type DeckEditOp = z.infer<typeof DeckEditOpSchema>;

function indexOf(deck: Deck, slideId: string): number {
  const i = deck.slides.findIndex((s) => s.id === slideId);
  if (i === -1) throw new ForgeError("NOT_FOUND", `No slide with id "${slideId}"`);
  return i;
}

function uniqueId(deck: Deck, base = "slide"): string {
  const ids = new Set(deck.slides.map((s) => s.id));
  for (let n = deck.slides.length + 1; ; n++) {
    const id = `${base}-${n}`;
    if (!ids.has(id)) return id;
  }
}

/** Move content between fields so a layout change keeps the slide's information visible. */
export function migrateLayout(slide: Slide, layout: SlideLayout): Slide {
  const s: Slide = { ...slide, layout };
  const bullets = slide.bullets ?? [];
  if (layout === "two-column" && !s.columns?.length && bullets.length) {
    const half = Math.ceil(bullets.length / 2);
    s.columns = [{ bullets: bullets.slice(0, half) }, { bullets: bullets.slice(half) }];
    delete s.bullets;
  }
  if ((layout === "bullets" || layout === "image-left" || layout === "closing") && !bullets.length) {
    const fromCols = (slide.columns ?? []).flatMap((c) => [...(c.heading ? [c.heading] : []), ...(c.bullets ?? [])]);
    const fromStats = (slide.stats ?? []).map((st) => `${st.value} — ${st.label}`);
    const fromTimeline = (slide.timeline ?? []).map((t) => `${t.label}: ${t.text}`);
    const merged = [...fromCols, ...fromStats, ...fromTimeline].slice(0, 10);
    if (merged.length) s.bullets = merged;
  }
  if (layout === "timeline" && !s.timeline?.length && bullets.length) {
    s.timeline = bullets.slice(0, 8).map((b, i) => {
      const m = b.match(/^([^:—-]{1,40})[:—-]\s*(.+)$/);
      return m ? { label: (m[1] as string).trim(), text: (m[2] as string).trim().slice(0, 200) } : { label: String(i + 1), text: b.slice(0, 200) };
    });
  }
  if (layout === "quote" && !s.quote && (slide.body || bullets[0])) {
    s.quote = { text: (slide.body ?? bullets[0] ?? "").slice(0, 600), author: slide.subtitle ?? "" };
  }
  return s;
}

/**
 * Apply one editor operation to a deck. Pure: returns a new, re-validated deck and never mutates the input.
 * Throws ForgeError BAD_INPUT for invalid ops/results and NOT_FOUND for unknown slide ids.
 */
export function applyDeckEdit(deck: Deck, rawOp: DeckEditOp): Deck {
  const parsed = DeckEditOpSchema.safeParse(rawOp);
  if (!parsed.success) throw new ForgeError("BAD_INPUT", `Invalid deck edit: ${parsed.error.message}`);
  const op = parsed.data;
  const slides = [...deck.slides];
  let next: Deck;
  switch (op.op) {
    case "setTitle":
      next = { ...deck, title: op.title };
      break;
    case "updateSlide": {
      const i = indexOf(deck, op.slideId);
      slides[i] = { ...(slides[i] as Slide), ...op.patch };
      next = { ...deck, slides };
      break;
    }
    case "addSlide": {
      const slide = { notes: "", ...op.slide, id: op.slide.id ?? uniqueId(deck) } as Slide;
      if (slides.some((s) => s.id === slide.id)) throw new ForgeError("BAD_INPUT", `Slide id "${slide.id}" already exists`);
      slides.splice(Math.min(op.index ?? slides.length, slides.length), 0, slide);
      next = { ...deck, slides };
      break;
    }
    case "removeSlide": {
      const i = indexOf(deck, op.slideId);
      if (slides.length === 1) throw new ForgeError("BAD_INPUT", "A deck needs at least one slide");
      slides.splice(i, 1);
      next = { ...deck, slides };
      break;
    }
    case "moveSlide": {
      const i = indexOf(deck, op.slideId);
      const [s] = slides.splice(i, 1);
      slides.splice(Math.min(op.toIndex, slides.length), 0, s as Slide);
      next = { ...deck, slides };
      break;
    }
    case "duplicateSlide": {
      const i = indexOf(deck, op.slideId);
      const copy = structuredClone(slides[i] as Slide);
      copy.id = uniqueId(deck, (slides[i] as Slide).id.replace(/-\d+$/, ""));
      slides.splice(i + 1, 0, copy);
      next = { ...deck, slides };
      break;
    }
    case "changeLayout": {
      const i = indexOf(deck, op.slideId);
      slides[i] = migrateLayout(slides[i] as Slide, op.layout);
      next = { ...deck, slides };
      break;
    }
    case "changeTheme":
      next = {
        ...deck,
        theme: { colors: { ...deck.theme.colors, ...op.theme.colors }, fonts: { ...deck.theme.fonts, ...op.theme.fonts } },
      };
      break;
  }
  const valid = DeckSchema.safeParse(next);
  if (!valid.success) throw new ForgeError("BAD_INPUT", `Edit produced an invalid deck: ${valid.error.message}`);
  return valid.data;
}

/** Apply several ops in order. */
export function applyDeckEdits(deck: Deck, ops: DeckEditOp[]): Deck {
  return ops.reduce(applyDeckEdit, deck);
}
