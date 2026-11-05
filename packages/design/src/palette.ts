import { WCAG, contrastRatio, ensureContrast, hexToOklch, oklchCss, oklchToHex, readableOn, type Oklch } from "./color.js";
import type { Palette } from "./types.js";

export interface PaletteOptions {
  /** Base hue (degrees) used to tint neutrals. */
  hue: number;
  /** Accent hue; defaults to `hue`. */
  accentHue?: number;
  /** Secondary accent hue; defaults to accentHue + 150 (split complement). */
  accent2Hue?: number;
  scheme: "light" | "dark";
  /** Accent chroma (0.04 muted .. 0.3 neon). */
  chroma?: number;
  /** Neutral tint chroma (0 pure grey .. 0.04 tinted). */
  neutralChroma?: number;
  /** Override background lightness (0..1). */
  bgLightness?: number;
}

export interface ContrastCheck {
  pair: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  pass: boolean;
}

const norm = (h: number) => ((h % 360) + 360) % 360;

/**
 * Generate an OKLCH palette and enforce WCAG AA: text/bg >= 7 (AAA), text/surface >= 4.5, muted >= 4.5
 * on bg and surface, accent + accent2 >= 3 (large text / UI) on bg and surface, onAccent >= 4.5 on accent.
 * Lightness is auto-adjusted (hue/chroma kept) when a pair falls short.
 */
export function generatePalette(o: PaletteOptions): Palette {
  const hue = norm(o.hue);
  const aHue = norm(o.accentHue ?? hue);
  const a2Hue = norm(o.accent2Hue ?? aHue + 150);
  const chroma = o.chroma ?? 0.16;
  const nc = o.neutralChroma ?? 0.012;
  const dark = o.scheme === "dark";
  const bgL = o.bgLightness ?? (dark ? 0.16 : 0.975);
  const lch: Record<string, Oklch> = {
    bg: { l: bgL, c: nc, h: hue },
    surface: { l: dark ? bgL + 0.055 : bgL - 0.035, c: nc * 1.3, h: hue },
    text: { l: dark ? 0.96 : 0.2, c: Math.min(nc * 1.5, 0.03), h: hue },
    muted: { l: dark ? 0.74 : 0.47, c: Math.min(nc * 2, 0.04), h: hue },
    accent: { l: dark ? 0.76 : 0.58, c: chroma, h: aHue },
    accent2: { l: dark ? 0.82 : 0.62, c: chroma * 0.85, h: a2Hue },
    border: { l: dark ? bgL + 0.13 : bgL - 0.12, c: nc * 1.5, h: hue },
  };
  return enforcePalette({
    scheme: o.scheme,
    bg: oklchToHex(lch.bg!),
    surface: oklchToHex(lch.surface!),
    text: oklchToHex(lch.text!),
    muted: oklchToHex(lch.muted!),
    accent: oklchToHex(lch.accent!),
    accent2: oklchToHex(lch.accent2!),
    border: oklchToHex(lch.border!),
    onAccent: "#000000",
    oklch: {},
  });
}

/** Fix every required contrast pair by adjusting lightness, then recompute the OKLCH strings. */
export function enforcePalette(p: Palette): Palette {
  const out: Palette = { ...p };
  const both = (fg: string, min: number) => {
    let hex = ensureContrast(fg, out.bg, min).hex;
    hex = ensureContrast(hex, out.surface, min).hex;
    // The surface fix may have broken bg in rare cases; final pass on bg.
    return ensureContrast(hex, out.bg, min).hex;
  };
  out.text = both(ensureContrast(out.text, out.bg, WCAG.AAA_TEXT).hex, WCAG.AA_TEXT);
  out.muted = both(out.muted, WCAG.AA_TEXT);
  out.accent = both(out.accent, WCAG.AA_LARGE);
  out.accent2 = both(out.accent2, WCAG.AA_LARGE);
  out.onAccent = readableOn(out.accent, hexToOklch(out.accent).h, WCAG.AA_TEXT);
  out.oklch = Object.fromEntries(
    (["bg", "surface", "text", "muted", "accent", "accent2", "border", "onAccent"] as const).map((k) => [k, oklchCss(hexToOklch(out[k]))]),
  );
  return out;
}

export function checkPalette(p: Palette): ContrastCheck[] {
  const pairs: Array<[string, string, string, number]> = [
    ["text/bg", p.text, p.bg, WCAG.AA_TEXT],
    ["text/surface", p.text, p.surface, WCAG.AA_TEXT],
    ["muted/bg", p.muted, p.bg, WCAG.AA_TEXT],
    ["muted/surface", p.muted, p.surface, WCAG.AA_TEXT],
    ["accent/bg (large text)", p.accent, p.bg, WCAG.AA_LARGE],
    ["accent/surface (large text)", p.accent, p.surface, WCAG.AA_LARGE],
    ["accent2/bg (large text)", p.accent2, p.bg, WCAG.AA_LARGE],
    ["onAccent/accent", p.onAccent, p.accent, WCAG.AA_TEXT],
  ];
  return pairs.map(([pair, fg, bg, min]) => {
    const ratio = contrastRatio(fg, bg);
    return { pair, fg, bg, ratio: Math.round(ratio * 100) / 100, min, pass: ratio >= min };
  });
}

export function palettePasses(p: Palette): boolean {
  return checkPalette(p).every((c) => c.pass);
}
