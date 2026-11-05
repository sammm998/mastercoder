/** Curated motion languages, grid systems, spacing + type scales and radius sets used by art directions. */

export interface MotionLanguage {
  id: string;
  name: string;
  easing: string;
  durations: { fast: number; base: number; slow: number };
  stagger: number;
  distance: number;
  description: string;
  tags: string[];
  /** Pattern ids that express this language well. */
  patterns: string[];
}

export const MOTION_LANGUAGES: MotionLanguage[] = [
  {
    id: "editorial-glide",
    name: "Editorial glide",
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    durations: { fast: 220, base: 640, slow: 1200 },
    stagger: 70,
    distance: 32,
    description: "Long expo-out glides; text arrives line by line like a page being typeset.",
    tags: ["editorial", "luxury", "calm", "architecture", "portfolio", "publishing"],
    patterns: ["split-text", "sticky-story", "smooth-scroll", "parallax-layers"],
  },
  {
    id: "kinetic-snap",
    name: "Kinetic snap",
    easing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    durations: { fast: 160, base: 360, slow: 720 },
    stagger: 40,
    distance: 20,
    description: "Springy overshoot with short durations; UI responds instantly and lands with a bounce.",
    tags: ["playful", "friendly", "startup", "consumer", "gaming"],
    patterns: ["magnetic-button", "bento-grid", "motion-reveal", "animated-counter"],
  },
  {
    id: "mechanical-precision",
    name: "Mechanical precision",
    easing: "cubic-bezier(0.65, 0, 0.35, 1)",
    durations: { fast: 120, base: 280, slow: 560 },
    stagger: 30,
    distance: 12,
    description: "Symmetric in-out curves, tight timings and small travel; feels engineered and exact.",
    tags: ["tech", "engineering", "fintech", "data", "developer", "saas", "trust"],
    patterns: ["horizontal-scroll", "animated-counter", "split-text", "marquee"],
  },
  {
    id: "liquid-flow",
    name: "Liquid flow",
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    durations: { fast: 260, base: 700, slow: 1400 },
    stagger: 90,
    distance: 40,
    description: "Fluid, shader-driven surfaces and slow drifts; motion feels like matter, not UI.",
    tags: ["futuristic", "electric", "ai", "energy", "mobility", "art"],
    patterns: ["hero-3d", "image-distortion", "smooth-scroll", "custom-cursor"],
  },
  {
    id: "brutal-cut",
    name: "Brutal cut",
    easing: "cubic-bezier(0.9, 0, 0.1, 1)",
    durations: { fast: 90, base: 220, slow: 480 },
    stagger: 0,
    distance: 64,
    description: "Hard cuts and abrupt wipes; content slams in with almost no easing tail.",
    tags: ["brutalist", "bold", "poster", "streetwear", "music", "loud", "industrial"],
    patterns: ["marquee", "split-text", "page-transition", "custom-cursor"],
  },
  {
    id: "organic-breath",
    name: "Organic breath",
    easing: "cubic-bezier(0.37, 0, 0.63, 1)",
    durations: { fast: 240, base: 560, slow: 1100 },
    stagger: 80,
    distance: 16,
    description: "Sine-based easing like breathing; gentle fades and small parallax drift.",
    tags: ["wellness", "nature", "organic", "warm", "sustainable", "calm", "food"],
    patterns: ["parallax-layers", "motion-reveal", "marquee", "preloader"],
  },
  {
    id: "cinematic-sweep",
    name: "Cinematic sweep",
    easing: "cubic-bezier(0.76, 0, 0.24, 1)",
    durations: { fast: 200, base: 800, slow: 1600 },
    stagger: 110,
    distance: 48,
    description: "Scroll is the timeline: pinned scenes, wide horizontal pans and slow masked reveals.",
    tags: ["automotive", "sport", "outdoor", "film", "architecture", "portfolio"],
    patterns: ["sticky-story", "horizontal-scroll", "hero-3d", "page-transition"],
  },
];

export interface GridSystem {
  id: string;
  name: string;
  columns: number;
  maxWidth: number;
  gutter: number;
  margin: number;
  tags: string[];
}

export const GRID_SYSTEMS: GridSystem[] = [
  { id: "asymmetric-12", name: "Asymmetric 12-column", columns: 12, maxWidth: 1440, gutter: 24, margin: 32, tags: ["bold", "tech", "agency"] },
  { id: "editorial-6", name: "Editorial 6-column", columns: 6, maxWidth: 1200, gutter: 32, margin: 40, tags: ["editorial", "luxury", "publishing"] },
  { id: "swiss-8", name: "Swiss 8-column", columns: 8, maxWidth: 1320, gutter: 20, margin: 24, tags: ["minimal", "architecture", "nordic", "trust"] },
  { id: "wide-16", name: "Wide 16-column", columns: 16, maxWidth: 1680, gutter: 16, margin: 24, tags: ["brutalist", "poster", "futuristic"] },
  { id: "modular-4", name: "Modular 4-column", columns: 4, maxWidth: 1120, gutter: 40, margin: 32, tags: ["calm", "wellness", "friendly"] },
  { id: "broken-10", name: "Broken 10-column", columns: 10, maxWidth: 1520, gutter: 28, margin: 36, tags: ["art", "fashion", "experimental", "portfolio"] },
];

export interface SpacingScale { id: string; values: number[]; tags: string[] }

export const SPACING_SCALES: SpacingScale[] = [
  { id: "linear-8", values: [4, 8, 12, 16, 24, 32, 48, 64, 96, 128], tags: ["tech", "trust", "saas"] },
  { id: "fibonacci", values: [4, 8, 12, 20, 32, 52, 84, 136, 176, 220], tags: ["editorial", "luxury", "art"] },
  { id: "golden", values: [4, 6, 10, 16, 26, 42, 68, 110, 160, 200], tags: ["calm", "nature", "craft"] },
  { id: "dense-4", values: [2, 4, 8, 12, 16, 24, 32, 48, 72, 104], tags: ["brutalist", "data", "developer"] },
  { id: "airy-12", values: [6, 12, 18, 24, 36, 54, 80, 120, 168, 224], tags: ["minimal", "architecture", "portfolio"] },
];

export const TYPE_RATIOS = [
  { id: "major-third", ratio: 1.25 },
  { id: "perfect-fourth", ratio: 1.333 },
  { id: "augmented-fourth", ratio: 1.414 },
  { id: "perfect-fifth", ratio: 1.5 },
  { id: "golden", ratio: 1.618 },
] as const;

/**
 * Radius sets: --radius-1 (chips/inputs), --radius-2 (cards, media), --radius-3 (large panels).
 * `button` is the button/pill radius (999 = fully rounded).
 */
export const RADIUS_SETS = [
  { id: "sharp", values: [0, 2, 4], button: 0, tags: ["brutalist", "editorial", "architecture", "luxury"] },
  { id: "soft", values: [6, 12, 24], button: 12, tags: ["friendly", "saas", "wellness"] },
  { id: "pill", values: [10, 20, 32], button: 999, tags: ["playful", "consumer", "futuristic"] },
  { id: "subtle", values: [3, 6, 12], button: 6, tags: ["tech", "fintech", "trust"] },
] as const;

/** Modular scale for steps -1..5 at the largest viewport. */
export function modularScale(base: number, ratio: number): number[] {
  return [-1, 0, 1, 2, 3, 4, 5].map((s) => Math.round(base * ratio ** s * 100) / 100);
}
