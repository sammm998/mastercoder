import type { FontSpec } from "./types.js";

/**
 * Curated type pairings. Every family is on Google Fonts under the SIL Open Font License 1.1
 * (verified against fonts.google.com metadata when curated). Weights listed are the ones Forge requests
 * (kept small for performance) and exist for the family.
 */
export interface FontPairing {
  id: string;
  display: FontSpec;
  body: FontSpec;
  mono: FontSpec;
  /** Display letter-spacing in em. */
  displayTracking: number;
  /** Uppercase display (poster faces). */
  uppercase?: boolean;
  tags: string[];
  note: string;
}

const SERIF = "ui-serif, Georgia, 'Times New Roman', serif";
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

const f = (family: string, weights: number[], category: FontSpec["category"], extra: Partial<FontSpec> = {}): FontSpec => ({
  family,
  weights,
  category,
  fallback: category === "serif" || category === "slab" ? SERIF : category === "mono" ? MONO : SANS,
  source: "google",
  license: "OFL-1.1",
  ...extra,
});

export const MONO_FONTS: Record<string, FontSpec> = {
  jetbrains: f("JetBrains Mono", [400, 500], "mono"),
  plex: f("IBM Plex Mono", [400, 500], "mono"),
  space: f("Space Mono", [400, 700], "mono"),
  dm: f("DM Mono", [400, 500], "mono"),
  fira: f("Fira Code", [400, 500], "mono"),
};

export const FONT_PAIRINGS: FontPairing[] = [
  {
    id: "fraunces-inter",
    display: f("Fraunces", [400, 700], "serif", { italic: true }),
    body: f("Inter", [400, 600], "sans"),
    mono: MONO_FONTS.jetbrains!,
    displayTracking: -0.03,
    tags: ["editorial", "warm", "craft", "food", "wellness", "publishing", "nature"],
    note: "Soft, wonky optical-size serif against a neutral workhorse sans.",
  },
  {
    id: "instrument-serif-inter-tight",
    display: f("Instrument Serif", [400], "serif", { italic: true, widthEm: 0.45 }),
    body: f("Inter Tight", [400, 600], "sans"),
    mono: MONO_FONTS.dm!,
    displayTracking: -0.02,
    tags: ["luxury", "editorial", "architecture", "minimal", "portfolio", "fashion", "studio"],
    note: "Condensed high-contrast serif at huge sizes; tight grotesk for quiet body copy.",
  },
  {
    id: "space-grotesk-plex",
    display: f("Space Grotesk", [500, 700], "sans", { widthEm: 0.6 }),
    body: f("IBM Plex Sans", [400, 600], "sans"),
    mono: MONO_FONTS.plex!,
    displayTracking: -0.035,
    tags: ["tech", "engineering", "fintech", "developer", "data", "ai", "saas"],
    note: "Quirky geometric grotesk with an engineered, technical body face.",
  },
  {
    id: "syne-manrope",
    display: f("Syne", [600, 800], "display", { widthEm: 0.66 }),
    body: f("Manrope", [400, 600], "sans"),
    mono: MONO_FONTS.space!,
    displayTracking: -0.04,
    tags: ["experimental", "art", "fashion", "bold", "music", "culture", "agency"],
    note: "Wide, idiosyncratic display face that turns headlines into graphics.",
  },
  {
    id: "unbounded-onest",
    display: f("Unbounded", [500, 800], "display", { widthEm: 0.74 }),
    body: f("Onest", [400, 600], "sans"),
    mono: MONO_FONTS.jetbrains!,
    displayTracking: -0.04,
    tags: ["energy", "futuristic", "sport", "mobility", "electric", "bold", "gaming"],
    note: "Rounded extended display with momentum; clean neo-grotesk body.",
  },
  {
    id: "bricolage-figtree",
    display: f("Bricolage Grotesque", [500, 800], "sans", { widthEm: 0.6 }),
    body: f("Figtree", [400, 600], "sans"),
    mono: MONO_FONTS.dm!,
    displayTracking: -0.035,
    tags: ["playful", "friendly", "startup", "community", "education", "consumer"],
    note: "Characterful grotesque with ink-trap quirks; friendly geometric body.",
  },
  {
    id: "dm-serif-dm-sans",
    display: f("DM Serif Display", [400], "serif", { italic: true, widthEm: 0.52 }),
    body: f("DM Sans", [400, 600], "sans"),
    mono: MONO_FONTS.dm!,
    displayTracking: -0.02,
    tags: ["classic", "hospitality", "food", "editorial", "beauty", "retail"],
    note: "Didone-flavoured display serif with a low-contrast geometric companion.",
  },
  {
    id: "archivo-black-archivo",
    display: f("Archivo Black", [400], "sans", { widthEm: 0.68 }),
    body: f("Archivo", [400, 600], "sans"),
    mono: MONO_FONTS.space!,
    displayTracking: -0.03,
    uppercase: true,
    tags: ["brutalist", "bold", "sport", "industrial", "poster", "streetwear"],
    note: "Heavy grotesque blocks for brutalist poster typography from one superfamily.",
  },
  {
    id: "cormorant-karla",
    display: f("Cormorant Garamond", [500, 700], "serif", { italic: true }),
    body: f("Karla", [400, 600], "sans"),
    mono: MONO_FONTS.fira!,
    displayTracking: -0.01,
    tags: ["luxury", "beauty", "fashion", "jewellery", "wine", "calm"],
    note: "Calligraphic display Garamond with a grotesque body for modern luxury.",
  },
  {
    id: "bebas-barlow",
    display: f("Bebas Neue", [400], "display", { widthEm: 0.42 }),
    body: f("Barlow", [400, 600], "sans"),
    mono: MONO_FONTS.jetbrains!,
    displayTracking: 0.01,
    uppercase: true,
    tags: ["industrial", "sport", "automotive", "energy", "mobility", "outdoor"],
    note: "Tall condensed caps with a road-sign inspired body family.",
  },
  {
    id: "big-shoulders-public-sans",
    display: f("Big Shoulders Display", [700, 900], "display", { widthEm: 0.44 }),
    body: f("Public Sans", [400, 600], "sans"),
    mono: MONO_FONTS.plex!,
    displayTracking: 0,
    uppercase: true,
    tags: ["urban", "civic", "mobility", "infrastructure", "bold", "city"],
    note: "Condensed civic display face; neutral, highly legible government-grade body.",
  },
  {
    id: "schibsted-newsreader",
    display: f("Schibsted Grotesk", [600, 800], "sans"),
    body: f("Newsreader", [400, 600], "serif", { italic: true }),
    mono: MONO_FONTS.plex!,
    displayTracking: -0.035,
    tags: ["journalism", "editorial", "finance", "research", "nordic", "trust"],
    note: "Scandinavian news grotesk headlines over a text serif built for long reading.",
  },
  {
    id: "anton-hanken",
    display: f("Anton", [400], "display", { widthEm: 0.46 }),
    body: f("Hanken Grotesk", [400, 600], "sans"),
    mono: MONO_FONTS.space!,
    displayTracking: 0,
    uppercase: true,
    tags: ["bold", "poster", "music", "events", "festival", "loud"],
    note: "Impact-weight condensed display for posters; airy grotesk body.",
  },
  {
    id: "young-serif-jakarta",
    display: f("Young Serif", [400], "serif", { widthEm: 0.6 }),
    body: f("Plus Jakarta Sans", [400, 600], "sans"),
    mono: MONO_FONTS.dm!,
    displayTracking: -0.02,
    tags: ["warm", "nature", "wellness", "food", "sustainable", "organic"],
    note: "Chunky, warm old-style serif with a contemporary geometric body.",
  },
  {
    id: "familjen-literata",
    display: f("Familjen Grotesk", [500, 700], "sans"),
    body: f("Literata", [400, 600], "serif"),
    mono: MONO_FONTS.jetbrains!,
    displayTracking: -0.03,
    tags: ["nordic", "calm", "publishing", "architecture", "minimal", "craft"],
    note: "Swedish-designed grotesk with ink traps; bookish screen serif for body.",
  },
  {
    id: "sora-inter",
    display: f("Sora", [500, 700], "sans", { widthEm: 0.62 }),
    body: f("Inter", [400, 600], "sans"),
    mono: MONO_FONTS.jetbrains!,
    displayTracking: -0.04,
    tags: ["fintech", "saas", "clean", "ai", "crypto", "product"],
    note: "Geometric display built for tech brands with a UI-proven body.",
  },
];

export function fontStack(f: FontSpec): string {
  const fam = /[\s\d]/.test(f.family) ? `"${f.family}"` : f.family;
  return `${fam}, ${f.fallback}`;
}

/** Google Fonts css2 `family=` parameter for one font. */
export function googleFamilyParam(font: FontSpec): string {
  const name = font.family.trim().replace(/\s+/g, "+");
  const weights = [...new Set(font.weights)].sort((a, b) => a - b);
  if (font.italic) {
    const tuples = [...weights.map((w) => `0,${w}`), ...weights.map((w) => `1,${w}`)];
    return `${name}:ital,wght@${tuples.join(";")}`;
  }
  return `${name}:wght@${weights.join(";")}`;
}

/** Build the Google Fonts css2 URL (display=swap) for google-sourced fonts; null when none. */
export function googleFontsHref(fonts: FontSpec[], opts: { text?: string } = {}): string | null {
  const seen = new Map<string, FontSpec>();
  for (const font of fonts) {
    if (font.source !== "google") continue;
    const prev = seen.get(font.family);
    seen.set(font.family, prev ? { ...prev, weights: [...prev.weights, ...font.weights], italic: prev.italic || font.italic } : font);
  }
  if (seen.size === 0) return null;
  const params = [...seen.values()].map((x) => `family=${googleFamilyParam(x)}`);
  params.push("display=swap");
  if (opts.text) params.push(`text=${encodeURIComponent(opts.text)}`);
  return `https://fonts.googleapis.com/css2?${params.join("&")}`;
}

/**
 * `<link>` tags for Google Fonts: preconnect to both origins and a non-render-blocking stylesheet
 * (preload + onload swap, with a <noscript> fallback). font-display: swap keeps text visible.
 */
export function googleFontsLinks(fonts: FontSpec[]): string {
  const href = googleFontsHref(fonts);
  if (!href) return "";
  const h = href.replace(/&/g, "&amp;");
  return [
    `<link rel="preconnect" href="https://fonts.googleapis.com" />`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`,
    `<link rel="preload" as="style" href="${h}" />`,
    `<link rel="stylesheet" href="${h}" media="print" onload="this.media='all'" />`,
    `<noscript><link rel="stylesheet" href="${h}" /></noscript>`,
  ].join("\n    ");
}

export function findPairing(id: string): FontPairing | undefined {
  return FONT_PAIRINGS.find((p) => p.id === id);
}

/** Make a FontSpec for a brand-supplied family name (assumed on Google Fonts unless it is a system face). */
export function brandFont(family: string, role: "display" | "body" | "mono", base?: FontSpec): FontSpec {
  const system = /^(system-ui|arial|helvetica|georgia|times|ui-)/i.test(family);
  return {
    family,
    weights: base?.weights ?? (role === "display" ? [600, 800] : [400, 600]),
    category: base?.category ?? (role === "mono" ? "mono" : "sans"),
    fallback: base?.fallback ?? (role === "mono" ? MONO : SANS),
    source: system ? "system" : "google",
    license: system ? "system" : "unknown (brand supplied)",
  };
}
