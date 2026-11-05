import { z } from "zod";
import { getModels, structured, type LLMProvider } from "@forge/llm";
import { WCAG, hexToOklch, oklchToHex } from "./color.js";
import { brandFont } from "./fonts.js";
import { briefTags } from "./curated.js";
import { enforcePalette, checkPalette } from "./palette.js";
import {
  ArtDirectionSchema,
  BrandInputSchema,
  DesignBriefSchema,
  type ArtDirection,
  type ArtDirectionInput,
  type BrandInput,
  type BrandInputInit,
  type DesignBrief,
  type DesignBriefInput,
} from "./types.js";

export const DirectionsResponseSchema = z.object({ directions: z.array(ArtDirectionSchema).length(3) });

export const DIRECTIONS_SYSTEM = `You are an award-winning art director (Awwwards / FWA calibre).
Propose exactly 3 genuinely different art directions for the brief: different type pairing, palette scheme
or temperature, grid, and motion language. Never generic template UI (no centered-hero-plus-three-cards).
Rules:
- Fonts: only Google Fonts families under the SIL Open Font License; give weights that exist.
- Palette: hex colours designed in OKLCH; text/bg contrast >= 7, muted >= 4.5, accent >= 3 on bg (WCAG AA).
- typography.scale: 7 px sizes for steps -1..5 at desktop; spacing: 10 px values; radius: 3 px values.
- motion: a named language, a CSS cubic-bezier easing, durations in ms (fast/base/slow).
- preferredPatterns: ids from [hero-3d, sticky-story, horizontal-scroll, split-text, magnetic-button,
  custom-cursor, parallax-layers, marquee, image-distortion, bento-grid, animated-counter, page-transition,
  preloader, smooth-scroll, motion-reveal].
- Never imitate a specific existing website; describe inspiration only by category.
Return JSON: {"directions":[ArtDirection, ArtDirection, ArtDirection]}.`;

export function directionsPrompt(brief: DesignBrief, brand?: BrandInput): string {
  return [
    `<brief>${JSON.stringify(brief)}</brief>`,
    brand ? `<brand>${JSON.stringify(brand)}</brand>\nBrand colours and fonts are hard constraints and override your choices.` : "",
    `ArtDirection shape: {"id","name","mood","tags":[],"typography":{"display":FontSpec,"body":FontSpec,"mono":FontSpec,"scale":[7 numbers],"ratio"},` +
      `"palette":{"scheme":"light|dark","bg","surface","text","muted","accent","accent2","border","onAccent"},` +
      `"grid":{"name","columns","maxWidth","gutter","margin"},"spacing":[10],"radius":[3],` +
      `"motion":{"language","easing","durations":{"fast","base","slow"},"stagger","distance","description"},"preferredPatterns":[],"rationale"}. ` +
      `FontSpec: {"family","weights":[...],"italic"?,"fallback","category":"serif|sans|display|mono|slab"}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Enforce contrast (auto-adjusting lightness), sane scales and ids on any direction (LLM or curated). */
export function normalizeDirection(input: ArtDirectionInput): ArtDirection {
  const d = ArtDirectionSchema.parse(input);
  const scale = [...d.typography.scale].sort((a, b) => a - b).slice(0, 7);
  const spacing = [...d.spacing].sort((a, b) => a - b).slice(0, 10);
  // Container radii stay <= 48px; a "pill" (>= 999) value belongs to buttons only.
  const pill = d.radius.some((r) => r >= 999);
  const radius = d.radius.slice(0, 3).map((r) => Math.min(r, 48));
  return {
    ...d,
    id: d.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
    typography: { ...d.typography, scale },
    spacing,
    radius,
    buttonRadius: d.buttonRadius ?? (pill ? 999 : undefined),
    palette: enforcePalette(d.palette),
  };
}

/**
 * Apply brand constraints: brand primary becomes the accent (lightness adjusted only if needed for AA),
 * secondary becomes accent2, explicit background/text replace the palette's, brand fonts replace the pairing.
 */
export function applyBrand(direction: ArtDirection, brandIn: BrandInputInit): ArtDirection {
  const brand = BrandInputSchema.parse(brandIn);
  const p = { ...direction.palette };
  const notes: string[] = [];
  const c = brand.colors;
  if (c.background) {
    p.bg = c.background;
    p.scheme = hexToOklch(c.background).l < 0.55 ? "dark" : "light";
    const l = hexToOklch(c.background);
    p.surface = shiftL(c.background, p.scheme === "dark" ? 0.05 : -0.035, l.h);
    p.border = shiftL(c.background, p.scheme === "dark" ? 0.13 : -0.12, l.h);
  }
  if (c.text) p.text = c.text;
  if (c.primary) p.accent = c.primary;
  if (c.secondary) p.accent2 = c.secondary;
  const enforced = enforcePalette(p);
  for (const k of ["accent", "accent2", "text"] as const) {
    const given = k === "accent" ? c.primary : k === "accent2" ? c.secondary : c.text;
    if (given && given.toLowerCase() !== enforced[k].toLowerCase()) {
      notes.push(`brand ${k} ${given} lightness-adjusted to ${enforced[k]} for WCAG AA on ${enforced.bg}`);
    }
  }
  const typography = { ...direction.typography };
  if (brand.fonts.display) typography.display = brandFont(brand.fonts.display, "display", typography.display);
  if (brand.fonts.body) typography.body = brandFont(brand.fonts.body, "body", typography.body);
  if (brand.fonts.mono) typography.mono = brandFont(brand.fonts.mono, "mono", typography.mono);
  const brandBits = [c.primary && `primary ${c.primary}`, brand.fonts.display && `display font ${brand.fonts.display}`].filter(Boolean);
  return {
    ...direction,
    palette: enforced,
    typography,
    tags: [...direction.tags, "brand"],
    rationale: `${direction.rationale} Brand overrides applied (${brandBits.join(", ") || "palette"}${brand.source !== "explicit" ? ` from ${brand.source}` : ""}).${notes.length ? ` ${notes.join("; ")}.` : ""}`,
  };
}

function shiftL(hex: string, dl: number, h: number): string {
  const lch = hexToOklch(hex);
  return oklchToHex({ ...lch, l: Math.min(1, Math.max(0, lch.l + dl)), h: lch.c < 1e-3 ? h : lch.h });
}

export interface GenerateDirectionsOptions {
  model?: string;
  maxTokens?: number;
}

/**
 * Generate exactly 3 distinct art directions (LLM purpose "design.directions", MODEL_PLANNER).
 * Output is validated with zod, contrast-enforced and brand-overridden.
 */
export async function generateDirections(
  llm: LLMProvider,
  briefIn: DesignBriefInput,
  brandIn?: BrandInputInit,
  opts: GenerateDirectionsOptions = {},
): Promise<ArtDirection[]> {
  const brief = DesignBriefSchema.parse(briefIn);
  const brand = brandIn ? BrandInputSchema.parse(brandIn) : undefined;
  const { value } = await structured(
    llm,
    {
      purpose: "design.directions",
      model: opts.model ?? getModels().planner,
      system: DIRECTIONS_SYSTEM,
      messages: [{ role: "user", content: directionsPrompt(brief, brand) }],
      maxTokens: opts.maxTokens ?? 8000,
      cache: true,
    },
    DirectionsResponseSchema,
  );
  const seen = new Set<string>();
  return value.directions.map((raw, i) => {
    let d = normalizeDirection(raw);
    if (seen.has(d.id)) d = { ...d, id: `${d.id}-${i + 1}` };
    seen.add(d.id);
    if (brand) d = applyBrand(d, brand);
    return d;
  });
}

export interface DirectionScore {
  direction: ArtDirection;
  score: number;
  reasons: string[];
}

/** Score how well each direction fits the brief (tags, requested features, contrast headroom). */
export function scoreDirections(dirs: ArtDirection[], briefIn: DesignBriefInput): DirectionScore[] {
  const brief = DesignBriefSchema.parse(briefIn);
  const tags = briefTags(brief);
  const wanted = brief.features.map((f) => f.toLowerCase());
  return dirs.map((d) => {
    const reasons: string[] = [];
    let score = 0;
    tags.forEach((t, i) => {
      if (d.tags.includes(t) || d.mood.toLowerCase().includes(t)) {
        const w = Math.max(1, 6 - i);
        score += w;
        reasons.push(`tag "${t}" +${w}`);
      }
    });
    for (const f of wanted) {
      if (d.preferredPatterns.some((p) => p === f || f.includes(p.replace(/-/g, " ")) || p.includes(f))) {
        score += 3;
        reasons.push(`supports feature "${f}" +3`);
      }
    }
    const checks = checkPalette(d.palette);
    const failures = checks.filter((c) => !c.pass).length;
    if (failures) {
      score -= failures * 5;
      reasons.push(`${failures} contrast failures -${failures * 5}`);
    }
    const textRatio = checks[0]?.ratio ?? 0;
    if (textRatio >= WCAG.AAA_TEXT) {
      score += 1;
      reasons.push("AAA body text +1");
    }
    return { direction: d, score, reasons };
  });
}

export function pickDirection(dirs: ArtDirection[], brief: DesignBriefInput): ArtDirection {
  if (dirs.length === 0) throw new Error("pickDirection: no directions");
  const scored = scoreDirections(dirs, brief);
  // Stable: ties keep the original (LLM-ranked) order.
  let best = scored[0]!;
  for (const s of scored) if (s.score > best.score) best = s;
  return best.direction;
}
