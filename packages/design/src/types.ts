import { z } from "zod";

/** A font from Google Fonts (all curated entries are OFL / Apache-2.0 licensed). */
export const FontSpecSchema = z.object({
  family: z.string().min(1),
  weights: z.array(z.number().int().min(100).max(900)).min(1),
  italic: z.boolean().optional(),
  /** CSS fallback stack appended after the family. */
  fallback: z.string().default("system-ui, sans-serif"),
  category: z.enum(["serif", "sans", "display", "mono", "slab"]).default("sans"),
  source: z.enum(["google", "brand", "system"]).default("google"),
  license: z.string().default("OFL-1.1"),
  /** Average glyph advance in em (≈0.5 condensed … 0.75 extended); shrinks mobile display sizes for wide faces. */
  widthEm: z.number().positive().optional(),
});
export type FontSpec = z.infer<typeof FontSpecSchema>;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb");

export const PaletteSchema = z.object({
  scheme: z.enum(["light", "dark"]),
  bg: hex,
  surface: hex,
  text: hex,
  muted: hex,
  accent: hex,
  accent2: hex,
  border: hex,
  /** Text colour used on top of `accent` (buttons). */
  onAccent: hex,
  /** OKLCH source values (CSS `oklch()` strings) the hex values were derived from. */
  oklch: z.record(z.string()).default({}),
});
export type Palette = z.infer<typeof PaletteSchema>;

export const ArtDirectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mood: z.string().min(1),
  /** Keyword tags used by pickDirection to score fit (extension of the BUILD_PLAN contract). */
  tags: z.array(z.string()).default([]),
  typography: z.object({
    display: FontSpecSchema,
    body: FontSpecSchema,
    mono: FontSpecSchema.optional(),
    /** Modular scale in px for steps -1..5 at the max viewport (7 entries). */
    scale: z.array(z.number().positive()).min(7),
    /** Ratio used to derive the scale (informational). */
    ratio: z.number().positive().optional(),
    tracking: z.object({ display: z.number(), body: z.number() }).default({ display: -0.02, body: 0 }),
  }),
  palette: PaletteSchema,
  grid: z.object({
    name: z.string().default("custom"),
    columns: z.number().int().min(1).max(24),
    maxWidth: z.number().int().min(320),
    gutter: z.number().nonnegative(),
    margin: z.number().nonnegative().default(24),
  }),
  /** 10 spacing values in px for --space-1..--space-10. */
  spacing: z.array(z.number().nonnegative()).min(10),
  /** 3 radius values in px for --radius-1..3 (chips, cards, panels). */
  radius: z.array(z.number().nonnegative()).min(3),
  /** Button radius in px (999 = pill). Defaults to radius[1]. */
  buttonRadius: z.number().nonnegative().optional(),
  motion: z.object({
    language: z.string(),
    easing: z.string(),
    durations: z.object({ fast: z.number().nonnegative(), base: z.number().nonnegative(), slow: z.number().nonnegative() }),
    stagger: z.number().nonnegative().default(60),
    distance: z.number().nonnegative().default(24),
    description: z.string().default(""),
  }),
  /** Pattern ids that suit this direction (hint for the composer). */
  preferredPatterns: z.array(z.string()).default([]),
  rationale: z.string(),
});
export type ArtDirection = z.infer<typeof ArtDirectionSchema>;
export type ArtDirectionInput = z.input<typeof ArtDirectionSchema>;

export const DesignBriefSchema = z.object({
  /** Product / brand / person name. */
  name: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(["landing", "portfolio", "app", "deck", "document", "media", "other"]).default("landing"),
  audience: z.string().optional(),
  industry: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  tone: z.array(z.string()).default([]),
  /** BCP-47 language of the output, e.g. "en" or "sv". */
  locale: z.string().default("en"),
  /** Features the site must show (pattern ids or free words like "3d", "scroll storytelling"). */
  features: z.array(z.string()).default([]),
});
export type DesignBrief = z.infer<typeof DesignBriefSchema>;
export type DesignBriefInput = z.input<typeof DesignBriefSchema>;

/** Brand constraints. Brand always overrides the art direction. */
export const BrandInputSchema = z.object({
  name: z.string().optional(),
  colors: z
    .object({
      primary: hex.optional(),
      secondary: hex.optional(),
      background: hex.optional(),
      text: hex.optional(),
    })
    .default({}),
  fonts: z.object({ display: z.string().optional(), body: z.string().optional(), mono: z.string().optional() }).default({}),
  /** Where the brand came from (logo, figma, explicit). */
  source: z.enum(["explicit", "logo", "figma", "merged"]).default("explicit"),
  notes: z.array(z.string()).default([]),
});
export type BrandInput = z.infer<typeof BrandInputSchema>;
export type BrandInputInit = z.input<typeof BrandInputSchema>;

export const CRITERIA = ["hierarchy", "spacing", "contrast", "rhythm", "motion", "originality"] as const;
export type Criterion = (typeof CRITERIA)[number];

export interface Screenshot {
  viewport: number;
  width: number;
  height: number;
  /** Full-page PNG. */
  png: Buffer;
  path?: string;
  /** Short scroll video (webm) when recorded. */
  videoPath?: string;
}

export interface FluidStep {
  step: number;
  minPx: number;
  maxPx: number;
  clamp: string;
}

export interface DesignTokens {
  name: string;
  scheme: "light" | "dark";
  color: { bg: string; surface: string; text: string; muted: string; accent: string; accent2: string; border: string; onAccent: string };
  colorOklch: Record<string, string>;
  font: { display: string; body: string; mono: string };
  fonts: FontSpec[];
  type: FluidStep[];
  tracking: { display: number; body: number };
  space: number[];
  radius: number[];
  radiusButton: number;
  motion: { language: string; ease: string; durFast: number; durBase: number; durSlow: number; stagger: number; distance: number };
  grid: { columns: number; maxWidth: number; gutter: number; margin: number };
}
