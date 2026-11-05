/**
 * Client-side editing of deck JSON produced by @forge/slides. The schema is treated tolerantly: only
 * the fields the editor touches are read, and every unknown field is preserved on save (the server
 * validates with validateDeck).
 */

export type RawSlide = Record<string, unknown>;
export interface RawDeck {
  slides: RawSlide[];
  [k: string]: unknown;
}

export interface SlideView {
  layout: string;
  title: string;
  subtitle: string;
  body: string;
  bullets: string[];
  notes: string;
  image: string | null;
}

export function isDeck(v: unknown): v is RawDeck {
  return !!v && typeof v === "object" && Array.isArray((v as { slides?: unknown }).slides) && (v as { slides: unknown[] }).slides.every((s) => !!s && typeof s === "object");
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function viewOf(s: RawSlide): SlideView {
  const bullets = Array.isArray(s.bullets) ? s.bullets.map((b) => (typeof b === "string" ? b : str((b as Record<string, unknown>)?.text))) : [];
  const image = typeof s.image === "string" ? s.image : typeof (s.image as Record<string, unknown> | undefined)?.url === "string" ? ((s.image as Record<string, unknown>).url as string) : null;
  return { layout: str(s.layout) || "content", title: str(s.title), subtitle: str(s.subtitle), body: str(s.body), bullets, notes: str(s.notes), image };
}

/** Apply a partial SlideView edit to a raw slide, writing only fields that changed or already existed. */
export function patchSlide(s: RawSlide, patch: Partial<SlideView>): RawSlide {
  const out: RawSlide = { ...s };
  for (const [k, v] of Object.entries(patch) as Array<[keyof SlideView, SlideView[keyof SlideView]]>) {
    if (k === "image") continue;
    if (k === "bullets") {
      const list = (v as string[]).map((b) => b.trim()).filter(Boolean);
      if (list.length || "bullets" in s) out.bullets = list;
      continue;
    }
    if (v === "" && !(k in s)) continue;
    out[k] = v;
  }
  return out;
}

export function updateSlide(deck: RawDeck, index: number, patch: Partial<SlideView>): RawDeck {
  return { ...deck, slides: deck.slides.map((s, i) => (i === index ? patchSlide(s, patch) : s)) };
}

export function moveSlide(deck: RawDeck, index: number, dir: -1 | 1): RawDeck {
  const to = index + dir;
  if (to < 0 || to >= deck.slides.length) return deck;
  const slides = [...deck.slides];
  [slides[index], slides[to]] = [slides[to]!, slides[index]!];
  return { ...deck, slides };
}

export function removeSlide(deck: RawDeck, index: number): RawDeck {
  if (deck.slides.length <= 1) return deck;
  return { ...deck, slides: deck.slides.filter((_, i) => i !== index) };
}

/** Insert a new slide after `index` using the same layout, with fresh ids if the deck uses them. */
export function addSlide(deck: RawDeck, index: number, title: string): RawDeck {
  const base = deck.slides[index] ?? {};
  const fresh: RawSlide = { layout: str(base.layout) || "content", title, bullets: [] };
  if (typeof base.id === "string") fresh.id = `s_${Math.random().toString(36).slice(2, 10)}`;
  const slides = [...deck.slides];
  slides.splice(index + 1, 0, fresh);
  return { ...deck, slides };
}

export function layoutsIn(deck: RawDeck): string[] {
  const set = new Set<string>(["title", "content", "two-column", "image", "quote", "section"]);
  for (const s of deck.slides) if (typeof s.layout === "string") set.add(s.layout);
  return [...set];
}

export interface DeckTheme {
  bg: string;
  text: string;
  accent: string;
  muted: string;
  display: string;
  body: string;
}

function pickColor(o: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && /^(#|rgb|hsl|oklch)/.test(v)) return v;
  }
  return undefined;
}

/** Derive deck colours/fonts from the project's design tokens (project.brand) or the deck's own theme. */
export function themeFrom(brand: unknown, deck: unknown): DeckTheme {
  const sources = [deck && typeof deck === "object" ? (deck as Record<string, unknown>).theme : undefined, brand].filter(Boolean) as Array<Record<string, unknown>>;
  const theme: DeckTheme = { bg: "#f3eee5", text: "#17140f", accent: "#e8480c", muted: "#686055", display: "var(--font-display)", body: "var(--font-body)" };
  for (const src of sources.reverse()) {
    const palette = (src.palette ?? src.colors ?? src.color ?? src) as Record<string, unknown>;
    theme.bg = pickColor(palette, ["bg", "background", "surface"]) ?? theme.bg;
    theme.text = pickColor(palette, ["text", "ink", "foreground", "fg"]) ?? theme.text;
    theme.accent = pickColor(palette, ["accent", "primary", "brand"]) ?? theme.accent;
    theme.muted = pickColor(palette, ["muted", "secondary", "subtle"]) ?? theme.muted;
    const typo = (src.typography ?? src.fonts ?? src.font) as Record<string, unknown> | undefined;
    const fam = (v: unknown) => (typeof v === "string" ? v : typeof (v as Record<string, unknown> | undefined)?.family === "string" ? ((v as Record<string, unknown>).family as string) : undefined);
    if (typo) {
      const d = fam(typo.display ?? typo.heading);
      const b = fam(typo.body ?? typo.text);
      if (d) theme.display = `"${d}", var(--font-display)`;
      if (b) theme.body = `"${b}", var(--font-body)`;
    }
  }
  return theme;
}
