/**
 * Deterministic, curated art-direction generator. Used by the mock LLM handler for "design.directions"
 * (so Forge works offline) and as a reference for what a good direction looks like. It derives three
 * genuinely different directions from brief keywords by combining curated type pairings, OKLCH palettes,
 * motion languages, grids and scales. Output is rule-based, not model output.
 */
import { FONT_PAIRINGS, type FontPairing } from "./fonts.js";
import { GRID_SYSTEMS, MOTION_LANGUAGES, RADIUS_SETS, SPACING_SCALES, modularScale } from "./library.js";
import { generatePalette } from "./palette.js";
import type { ArtDirection, BrandInput, DesignBrief } from "./types.js";

interface Archetype {
  id: string;
  name: string;
  mood: string;
  scheme: "light" | "dark";
  pairing: string;
  motion: string;
  grid: string;
  spacing: string;
  radius: (typeof RADIUS_SETS)[number]["id"];
  ratio: number;
  baseSize: number;
  /** Default hue when the brief does not suggest one. */
  hue: number;
  /** Accent hue offset from the base hue. */
  accentShift: number;
  accent2Shift: number;
  chroma: number;
  neutralChroma: number;
  bgLightness?: number;
  tags: string[];
}

export const ARCHETYPES: Archetype[] = [
  { id: "voltage-noir", name: "Voltage Noir", mood: "Charged, nocturnal, fast — light cutting through dark glass.", scheme: "dark", pairing: "unbounded-onest", motion: "liquid-flow", grid: "asymmetric-12", spacing: "linear-8", radius: "pill", ratio: 1.5, baseSize: 18, hue: 265, accentShift: 0, accent2Shift: 140, chroma: 0.2, neutralChroma: 0.02, bgLightness: 0.14, tags: ["electric", "futuristic", "energy", "mobility", "tech", "bold", "night", "ai", "gaming"] },
  { id: "quiet-monument", name: "Quiet Monument", mood: "Still, material, monumental — stone, daylight and long shadows.", scheme: "light", pairing: "instrument-serif-inter-tight", motion: "editorial-glide", grid: "editorial-6", spacing: "airy-12", radius: "sharp", ratio: 1.618, baseSize: 17, hue: 70, accentShift: -45, accent2Shift: 160, chroma: 0.1, neutralChroma: 0.012, bgLightness: 0.955, tags: ["architecture", "luxury", "minimal", "portfolio", "editorial", "calm", "studio", "interior"] },
  { id: "signal-grid", name: "Signal Grid", mood: "Precise, lucid, trustworthy — instruments on a clean console.", scheme: "light", pairing: "space-grotesk-plex", motion: "mechanical-precision", grid: "swiss-8", spacing: "linear-8", radius: "subtle", ratio: 1.333, baseSize: 17, hue: 250, accentShift: 0, accent2Shift: -100, chroma: 0.19, neutralChroma: 0.01, tags: ["tech", "fintech", "data", "trust", "engineering", "developer", "saas", "finance"] },
  { id: "poster-riot", name: "Poster Riot", mood: "Loud, physical, unapologetic — wheat-pasted posters at street scale.", scheme: "light", pairing: "anton-hanken", motion: "brutal-cut", grid: "wide-16", spacing: "dense-4", radius: "sharp", ratio: 1.618, baseSize: 17, hue: 30, accentShift: 0, accent2Shift: 200, chroma: 0.22, neutralChroma: 0.02, bgLightness: 0.93, tags: ["brutalist", "bold", "music", "poster", "streetwear", "events", "festival", "loud"] },
  { id: "soft-botanica", name: "Soft Botanica", mood: "Warm, rooted, breathing — morning light through leaves.", scheme: "light", pairing: "young-serif-jakarta", motion: "organic-breath", grid: "modular-4", spacing: "golden", radius: "soft", ratio: 1.333, baseSize: 18, hue: 140, accentShift: -10, accent2Shift: -100, chroma: 0.13, neutralChroma: 0.02, bgLightness: 0.965, tags: ["nature", "wellness", "food", "organic", "warm", "sustainable", "eco", "calm"] },
  { id: "night-edition", name: "Night Edition", mood: "Serious, investigative, considered — a late edition under lamplight.", scheme: "dark", pairing: "schibsted-newsreader", motion: "cinematic-sweep", grid: "editorial-6", spacing: "fibonacci", radius: "sharp", ratio: 1.414, baseSize: 18, hue: 220, accentShift: -160, accent2Shift: 40, chroma: 0.15, neutralChroma: 0.015, bgLightness: 0.17, tags: ["editorial", "finance", "journalism", "trust", "nordic", "research", "publishing"] },
  { id: "pop-arcade", name: "Pop Arcade", mood: "Bright, bouncy, generous — a toy shop for grown-ups.", scheme: "light", pairing: "bricolage-figtree", motion: "kinetic-snap", grid: "asymmetric-12", spacing: "linear-8", radius: "pill", ratio: 1.414, baseSize: 18, hue: 300, accentShift: 0, accent2Shift: 120, chroma: 0.22, neutralChroma: 0.02, tags: ["playful", "friendly", "startup", "consumer", "community", "education", "gaming"] },
  { id: "velvet-atelier", name: "Velvet Atelier", mood: "Intimate, crafted, sensual — candlelight on velvet and brass.", scheme: "dark", pairing: "cormorant-karla", motion: "editorial-glide", grid: "broken-10", spacing: "fibonacci", radius: "sharp", ratio: 1.5, baseSize: 18, hue: 20, accentShift: 50, accent2Shift: -40, chroma: 0.11, neutralChroma: 0.02, bgLightness: 0.17, tags: ["luxury", "beauty", "fashion", "jewellery", "wine", "craft", "hospitality"] },
  { id: "gallery-static", name: "Gallery Static", mood: "Curatorial, experimental, spacious — white cube with a glitch.", scheme: "light", pairing: "syne-manrope", motion: "cinematic-sweep", grid: "broken-10", spacing: "airy-12", radius: "sharp", ratio: 1.618, baseSize: 17, hue: 95, accentShift: 230, accent2Shift: 100, chroma: 0.2, neutralChroma: 0.006, bgLightness: 0.975, tags: ["art", "agency", "experimental", "portfolio", "culture", "fashion", "studio"] },
  { id: "velocity-sport", name: "Velocity Sport", mood: "Kinetic, gritty, competitive — asphalt, motion blur and a finish line.", scheme: "dark", pairing: "bebas-barlow", motion: "cinematic-sweep", grid: "wide-16", spacing: "linear-8", radius: "subtle", ratio: 1.618, baseSize: 18, hue: 120, accentShift: 0, accent2Shift: 180, chroma: 0.21, neutralChroma: 0.012, bgLightness: 0.15, tags: ["sport", "automotive", "outdoor", "mobility", "energy", "bike", "industrial"] },
  { id: "clear-ledger", name: "Clear Ledger", mood: "Calm confidence — glass, air and numbers that add up.", scheme: "light", pairing: "sora-inter", motion: "mechanical-precision", grid: "asymmetric-12", spacing: "linear-8", radius: "soft", ratio: 1.414, baseSize: 17, hue: 165, accentShift: 0, accent2Shift: 110, chroma: 0.16, neutralChroma: 0.01, bgLightness: 0.98, tags: ["fintech", "saas", "ai", "product", "clean", "crypto", "finance", "payments"] },
  { id: "nordic-paper", name: "Nordic Paper", mood: "Honest, quiet, tactile — birch, linen and long winter light.", scheme: "light", pairing: "familjen-literata", motion: "organic-breath", grid: "swiss-8", spacing: "golden", radius: "subtle", ratio: 1.333, baseSize: 18, hue: 85, accentShift: 140, accent2Shift: -60, chroma: 0.09, neutralChroma: 0.014, bgLightness: 0.96, tags: ["nordic", "calm", "craft", "publishing", "architecture", "minimal", "sustainable"] },
];

/** Brief word -> tags. Multi-word keys are matched as phrases. */
const LEXICON: Record<string, string[]> = {
  electric: ["electric", "energy", "futuristic"], ev: ["electric", "mobility"], "e-bike": ["electric", "mobility", "bike"], ebike: ["electric", "mobility", "bike"],
  battery: ["electric", "energy", "tech"], bike: ["mobility", "bike", "sport"], bicycle: ["mobility", "bike"], cycling: ["sport", "bike", "outdoor"],
  scooter: ["mobility", "urban"], car: ["automotive", "mobility"], mobility: ["mobility"], commute: ["mobility", "urban"], urban: ["urban", "mobility"],
  ride: ["mobility", "sport"], speed: ["sport", "energy"], "3d": ["futuristic", "tech"],
  architect: ["architecture", "portfolio", "studio"], architecture: ["architecture"], building: ["architecture"], interior: ["interior", "architecture"],
  spaces: ["architecture"], studio: ["studio"], portfolio: ["portfolio"], projects: ["portfolio"], gallery: ["art", "portfolio"],
  fintech: ["fintech", "finance", "tech"], bank: ["finance", "trust"], banking: ["finance", "trust", "fintech"], payments: ["payments", "fintech"],
  payment: ["payments", "fintech"], money: ["finance"], invest: ["finance"], investing: ["finance"], card: ["fintech"], wallet: ["fintech"], crypto: ["crypto", "fintech"],
  launch: ["product", "startup"], startup: ["startup"], ai: ["ai", "tech"], software: ["tech", "saas"], saas: ["saas", "tech"], api: ["developer", "tech"],
  developer: ["developer", "tech"], data: ["data", "tech"], cloud: ["tech", "saas"], app: ["product", "tech"], platform: ["tech", "saas"],
  luxury: ["luxury"], premium: ["luxury"], bespoke: ["luxury", "craft"], fashion: ["fashion"], beauty: ["beauty"], jewellery: ["jewellery", "luxury"], jewelry: ["jewellery", "luxury"],
  wine: ["wine", "luxury"], hotel: ["hospitality", "luxury"], restaurant: ["food", "hospitality"], food: ["food"], coffee: ["food", "warm"], bakery: ["food", "warm", "craft"],
  nature: ["nature"], organic: ["organic", "nature"], eco: ["eco", "sustainable"], sustainable: ["sustainable"], green: ["sustainable", "nature"], forest: ["nature", "outdoor"],
  outdoor: ["outdoor"], wellness: ["wellness"], yoga: ["wellness", "calm"], health: ["wellness", "trust"], calm: ["calm"],
  music: ["music"], festival: ["festival", "events"], event: ["events"], concert: ["music", "events"], club: ["music", "night"], streetwear: ["streetwear"],
  art: ["art"], artist: ["art", "portfolio"], agency: ["agency"], creative: ["agency", "art"], experimental: ["experimental"], culture: ["culture"],
  magazine: ["editorial", "publishing"], journal: ["editorial", "journalism"], news: ["journalism"], editorial: ["editorial"], book: ["publishing"],
  playful: ["playful"], fun: ["playful"], kids: ["playful", "friendly"], game: ["gaming", "playful"], community: ["community", "friendly"], school: ["education"],
  bold: ["bold"], minimal: ["minimal"], minimalist: ["minimal"], brutalist: ["brutalist"], loud: ["loud", "bold"], quiet: ["calm", "minimal"],
  nordic: ["nordic"], scandinavian: ["nordic"], swedish: ["nordic"], sweden: ["nordic"], craft: ["craft"], handmade: ["craft"], trust: ["trust"], secure: ["trust"],
  sport: ["sport"], fitness: ["sport", "wellness"], running: ["sport", "outdoor"], automotive: ["automotive"], industrial: ["industrial"],
};

/** Hue (OKLCH degrees) suggested by tags. */
const TAG_HUES: Array<[string, number]> = [
  ["electric", 135], ["energy", 60], ["nature", 145], ["sustainable", 150], ["wellness", 160], ["fintech", 255], ["finance", 250], ["trust", 245],
  ["luxury", 70], ["beauty", 10], ["architecture", 60], ["food", 45], ["music", 330], ["art", 300], ["sport", 30], ["tech", 270], ["nordic", 230], ["playful", 320],
];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Tags inferred from the brief text, keywords, tone, industry and features. */
export function briefTags(brief: DesignBrief): string[] {
  const text = [brief.name, brief.description, brief.industry ?? "", brief.audience ?? "", ...brief.keywords, ...brief.tone, ...brief.features, brief.kind]
    .join(" ")
    .toLowerCase();
  const words = new Set(text.split(/[^a-z0-9-]+/).filter(Boolean));
  const tags = new Map<string, number>();
  const add = (t: string, w = 1) => tags.set(t, (tags.get(t) ?? 0) + w);
  for (const [word, ts] of Object.entries(LEXICON)) {
    const hit = word.includes(" ") || word.includes("-") ? text.includes(word) : words.has(word);
    if (hit) ts.forEach((t, i) => add(t, i === 0 ? 2 : 1));
  }
  for (const k of [...brief.keywords, ...brief.tone]) add(k.toLowerCase(), 2);
  if (brief.kind === "portfolio") add("portfolio", 2);
  return [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

function suggestedHue(tags: string[], seed: number): number | undefined {
  for (const t of tags) {
    const hit = TAG_HUES.find(([k]) => k === t);
    if (hit) return (hit[1] + (seed % 17) - 8 + 360) % 360;
  }
  return undefined;
}

function scoreArchetype(a: Archetype, tags: string[]): number {
  let s = 0;
  tags.forEach((t, i) => {
    if (a.tags.includes(t)) s += Math.max(1, 6 - i);
  });
  return s;
}

/** Choose three archetypes: best fit, best contrasting fit, and a wildcard that differs in motion + type. */
export function chooseArchetypes(tags: string[], seed: number): Archetype[] {
  const ranked = [...ARCHETYPES]
    .map((a, i) => ({ a, s: scoreArchetype(a, tags) + ((seed >> (i % 24)) & 1) * 0.1 }))
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a);
  const first = ranked[0]!;
  const second = ranked.find((a) => a !== first && a.scheme !== first.scheme && a.motion !== first.motion) ?? ranked[1]!;
  const cat = (a: Archetype) => FONT_PAIRINGS.find((p) => p.id === a.pairing)?.display.category;
  const third =
    ranked.find((a) => a !== first && a !== second && a.motion !== first.motion && a.motion !== second.motion && a.pairing !== first.pairing && cat(a) !== cat(first)) ??
    ranked.find((a) => a !== first && a !== second)!;
  return [first, second, third];
}

function pick<T extends { id: string }>(list: readonly T[], id: string): T {
  const v = list.find((x) => x.id === id);
  if (!v) throw new Error(`curated library missing "${id}"`);
  return v;
}

export function directionFromArchetype(a: Archetype, brief: DesignBrief, tags: string[], seed: number, index: number): ArtDirection {
  const pairing: FontPairing = pick(FONT_PAIRINGS, a.pairing);
  const motion = pick(MOTION_LANGUAGES, a.motion);
  const grid = pick(GRID_SYSTEMS, a.grid);
  const spacing = pick(SPACING_SCALES, a.spacing);
  const radius = pick(RADIUS_SETS, a.radius);
  const hueFromBrief = suggestedHue(tags, seed);
  // The first direction follows the brief's colour cue; others keep their archetype hue so the set stays varied.
  const hue = index === 0 && hueFromBrief !== undefined ? hueFromBrief : (a.hue + (seed % 23) - 11 + 360) % 360;
  const palette = generatePalette({
    hue,
    accentHue: hue + a.accentShift,
    accent2Hue: hue + a.accent2Shift,
    scheme: a.scheme,
    chroma: a.chroma,
    neutralChroma: a.neutralChroma,
    bgLightness: a.bgLightness,
  });
  const matched = a.tags.filter((t) => tags.includes(t));
  const why = matched.length ? `it answers the brief's ${matched.slice(0, 3).join(", ")} cues` : "it deliberately pushes the brief somewhere unexpected";
  const patterns = [...new Set([...motion.patterns])];
  return {
    id: `${a.id}-${(seed % 9973).toString(36)}`,
    name: a.name,
    mood: a.mood,
    tags: [...new Set([...a.tags, ...motion.tags.slice(0, 2)])],
    typography: {
      display: pairing.display,
      body: pairing.body,
      mono: pairing.mono,
      scale: modularScale(a.baseSize, a.ratio),
      ratio: a.ratio,
      tracking: { display: pairing.displayTracking, body: 0 },
    },
    palette,
    grid: { name: grid.name, columns: grid.columns, maxWidth: grid.maxWidth, gutter: grid.gutter, margin: grid.margin },
    spacing: spacing.values,
    radius: [...radius.values],
    buttonRadius: radius.button,
    motion: {
      language: motion.name,
      easing: motion.easing,
      durations: motion.durations,
      stagger: motion.stagger,
      distance: motion.distance,
      description: motion.description,
    },
    preferredPatterns: patterns,
    rationale:
      `${a.name} for ${brief.name}: ${pairing.display.family} over ${pairing.body.family} — ${pairing.note} ` +
      `${motion.name}: ${motion.description} A ${grid.name.toLowerCase()} grid with a ${spacing.id} spacing scale and a ` +
      `${a.ratio} type ratio gives dramatic scale contrast. ${a.scheme === "dark" ? "Dark" : "Light"} OKLCH palette (hue ${Math.round(hue)}°) ` +
      `checked for WCAG AA. Chosen because ${why}.`,
  };
}

/** Three curated directions for a brief (deterministic for the same brief). */
export function curatedDirections(brief: DesignBrief, _brand?: BrandInput): ArtDirection[] {
  const tags = briefTags(brief);
  const seed = hashString(`${brief.name}|${brief.description}`);
  return chooseArchetypes(tags, seed).map((a, i) => directionFromArchetype(a, brief, tags, seed, i));
}
