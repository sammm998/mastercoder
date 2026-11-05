import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pattern library registry. Pattern sources are real .tsx/.ts/.css files under packages/design/patterns/
 * (typechecked by tsconfig.patterns.json) and are read from disk here so the composer can copy them into
 * generated projects at `src/patterns/<id>/...`.
 */

export type PatternCategory = "hero" | "scroll" | "typography" | "interaction" | "layout" | "data" | "navigation" | "loading" | "infrastructure";

export interface PatternDef {
  id: string;
  name: string;
  description: string;
  category: PatternCategory;
  /** Target path in a generated project -> file content. Includes the shared helpers it imports. */
  files: Record<string, string>;
  /** npm packages (exact versions) the pattern needs at runtime. */
  dependencies: Record<string, string>;
  /** Import specifier + named export for composers, e.g. { path: "./patterns/marquee/Marquee", name: "Marquee" }. */
  entry: { path: string; name: string };
  /** Stylesheet path (target) to import once, when the pattern has one. */
  css?: string;
  a11y: string[];
  reducedMotion: string;
  perfNotes: string;
}

/** Exact runtime versions used by patterns (kept equal to this package's devDependencies; see test). */
export const PATTERN_DEP_VERSIONS = {
  react: "19.3.1",
  "react-dom": "19.3.1",
  three: "0.187.0",
  "@react-three/fiber": "9.8.2",
  "@react-three/drei": "10.7.9",
  gsap: "3.15.1",
  lenis: "1.3.27",
  motion: "14.9.1",
} as const;

export const PATTERNS_DIR = fileURLToPath(new URL("../../patterns/", import.meta.url));
const SHARED = "_shared";

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? listFiles(p) : [p];
    })
    .sort();
}

/** Read every file of a pattern directory (plus _shared) as target-path -> content. */
export function readPatternFiles(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of [SHARED, id]) {
    for (const file of listFiles(join(PATTERNS_DIR, dir))) {
      out[`src/patterns/${relative(PATTERNS_DIR, file).split("\\").join("/")}`] = readFileSync(file, "utf8");
    }
  }
  return out;
}

interface PatternMeta extends Omit<PatternDef, "files" | "dependencies" | "entry" | "css"> {
  entryFile: string;
  exportName: string;
  deps: Array<keyof typeof PATTERN_DEP_VERSIONS>;
}

const BASE: Array<keyof typeof PATTERN_DEP_VERSIONS> = ["react", "react-dom"];

const META: PatternMeta[] = [
  {
    id: "hero-3d",
    name: "3D shader hero",
    description: "Oversized asymmetric headline over a noise-displaced shader orb (React Three Fiber + drei + custom GLSL), lazy-mounted after load+idle.",
    category: "hero",
    entryFile: "Hero3D",
    exportName: "Hero3D",
    deps: [...BASE, "three", "@react-three/fiber", "@react-three/drei"],
    a11y: ["Section labelled by its h1 (aria-labelledby)", "Canvas and poster are aria-hidden and not focusable (tabIndex=-1)", "Headline is real text, not part of the canvas"],
    reducedMotion: "usePrefersReducedMotion() → WebGL never mounts; static token gradient poster is shown.",
    perfNotes: "Scene is a React.lazy chunk imported only after window load + requestIdleCallback; skipped on low-power/save-data/no-WebGL; DPR clamped to [1,1.75] with drei PerformanceMonitor; frameloop paused off-screen; stage uses contain: strict (no CLS).",
  },
  {
    id: "sticky-story",
    name: "Sticky scroll storytelling",
    description: "Pinned visual stage that swaps scenes while narrative steps scroll by; GSAP ScrollTrigger drives active scene, progress rail and parallax.",
    category: "scroll",
    entryFile: "StickyStory",
    exportName: "StickyStory",
    deps: [...BASE, "gsap"],
    a11y: ["Ordered list of <article> steps with headings", "Active step marked with aria-current=step", "Duplicate stage visuals are aria-hidden"],
    reducedMotion: "GSAP is not loaded; IntersectionObserver switches scenes without transitions (CSS transitions only inside prefers-reduced-motion: no-preference).",
    perfNotes: "gsap + ScrollTrigger dynamically imported; CSS position: sticky does the pinning (no pin-spacer reflow); transform/opacity only.",
  },
  {
    id: "horizontal-scroll",
    name: "Horizontal scroll section",
    description: "Cards pan horizontally while the section is pinned (GSAP ScrollTrigger); native scroll-snap list otherwise.",
    category: "scroll",
    entryFile: "HorizontalScroll",
    exportName: "HorizontalScroll",
    deps: [...BASE, "gsap"],
    a11y: ["Scrollable list is focusable (tabIndex=0) with an aria-label when not pinned", "Focusing a card while pinned scrolls it into view", "Cards are <article> with h3"],
    reducedMotion: "No pinning or scrubbing; a native horizontal scroll-snap list (keyboard scrollable).",
    perfNotes: "gsap lazy-loaded; only translateX on the track; pinned only ≥56em.",
  },
  {
    id: "split-text",
    name: "Split-text reveal",
    description: "Words rise from clip masks with a token-timed stagger when the heading enters the viewport.",
    category: "typography",
    entryFile: "SplitText",
    exportName: "SplitText",
    deps: [...BASE],
    a11y: ["Full sentence in a visually hidden span (sr-only)", "Split word spans are aria-hidden", "Renders any heading level via `as`"],
    reducedMotion: "Renders plain text (no masks, no transforms).",
    perfNotes: "CSS transitions on transform only; words keep their inline boxes so no layout shift.",
  },
  {
    id: "magnetic-button",
    name: "Magnetic button",
    description: "Button/link and label drift toward the pointer and spring back.",
    category: "interaction",
    entryFile: "MagneticButton",
    exportName: "MagneticButton",
    deps: [...BASE],
    a11y: ["Real <a href> or <button type=button>", "Visible :focus-visible outline", "Min 48px target size", "Accent background uses --color-on-accent (AA)"],
    reducedMotion: "Pointer tracking disabled for reduced motion and coarse pointers.",
    perfNotes: "rAF-batched transform writes; no layout reads per frame except one getBoundingClientRect per move.",
  },
  {
    id: "custom-cursor",
    name: "Custom cursor follower",
    description: "Blend-mode ring trailing the pointer that grows over interactive elements.",
    category: "interaction",
    entryFile: "CustomCursor",
    exportName: "CustomCursor",
    deps: [...BASE],
    a11y: ["aria-hidden, pointer-events: none", "Native cursor is never hidden"],
    reducedMotion: "Not mounted with reduced motion; also not on touch/coarse pointers (and hidden by CSS media query).",
    perfNotes: "Single fixed element, transform-only, rAF loop stops when settled.",
  },
  {
    id: "parallax-layers",
    name: "Parallax layers",
    description: "Depth-separated layers moving at different speeds across the viewport.",
    category: "scroll",
    entryFile: "ParallaxLayers",
    exportName: "ParallaxLayers",
    deps: [...BASE],
    a11y: ["Section has aria-label", "Decorative layers aria-hidden"],
    reducedMotion: "No scroll listener; layers stay static.",
    perfNotes: "Passive scroll listener + rAF, only while on screen (IntersectionObserver); fixed-height stage.",
  },
  {
    id: "marquee",
    name: "Marquee",
    description: "Infinite looping band of words with a pause control.",
    category: "typography",
    entryFile: "Marquee",
    exportName: "Marquee",
    deps: [...BASE],
    a11y: ["Duplicate track aria-hidden", "Pause/play toggle button with aria-pressed (WCAG 2.2.2)", "Pauses on hover and focus-within"],
    reducedMotion: "Static wrapped list; no animation.",
    perfNotes: "Pure CSS keyframes on transform.",
  },
  {
    id: "image-distortion",
    name: "WebGL image distortion",
    description: "Ripple + RGB-split shader over an image on hover (raw WebGL, no three.js).",
    category: "interaction",
    entryFile: "DistortImage",
    exportName: "DistortImage",
    deps: [...BASE],
    a11y: ["Real <img> with alt text always present", "Canvas overlay aria-hidden", "Focus shows a CSS-only state"],
    reducedMotion: "WebGL is never initialised; CSS hover zoom is also disabled.",
    perfNotes: "WebGL context created lazily on first pointerenter; width/height attributes reserve space; img lazy-loaded.",
  },
  {
    id: "bento-grid",
    name: "Bento grid",
    description: "Asymmetric modular feature grid with dense packing.",
    category: "layout",
    entryFile: "BentoGrid",
    exportName: "BentoGrid",
    deps: [...BASE],
    a11y: ["<ul role=list> of <article> tiles with h3", "Whole-tile links via ::after keep a single tab stop", "Accent tiles use --color-on-accent"],
    reducedMotion: "Hover lift lives inside prefers-reduced-motion: no-preference.",
    perfNotes: "CSS grid only, no JS.",
  },
  {
    id: "animated-counter",
    name: "Animated counters",
    description: "Numbers count up with expo-out easing when they enter the viewport.",
    category: "data",
    entryFile: "AnimatedCounter",
    exportName: "CounterRow",
    deps: [...BASE],
    a11y: ["Final value in sr-only text; animated digits aria-hidden", "Labels are visible text"],
    reducedMotion: "Final value rendered immediately.",
    perfNotes: "Width reserved via ch + tabular-nums (no CLS); rAF stops when done.",
  },
  {
    id: "page-transition",
    name: "Page transitions",
    description: "View Transitions API navigation with a hash router and instant fallback.",
    category: "navigation",
    entryFile: "PageTransition",
    exportName: "TransitionLink",
    deps: [...BASE],
    a11y: ["Real links (middle-click works)", "Focus moves to [data-route-focus] heading after navigation", "Scroll resets to top"],
    reducedMotion: "No startViewTransition call; CSS disables ::view-transition animations.",
    perfNotes: "No dependency; feature-detected API; flushSync keeps the snapshot consistent.",
  },
  {
    id: "preloader",
    name: "Preloader",
    description: "Non-blocking curtain that counts to 100 on first visit, then wipes away.",
    category: "loading",
    entryFile: "Preloader",
    exportName: "Preloader",
    deps: [...BASE],
    a11y: ["aria-hidden and pointer-events: none — never blocks content or input"],
    reducedMotion: "Skipped entirely (also via CSS display: none).",
    perfNotes: "Content renders underneath from the first frame; capped at 1.2s; skipped when cached in sessionStorage or on Save-Data.",
  },
  {
    id: "smooth-scroll",
    name: "Lenis smooth-scroll provider",
    description: "Context provider that enables Lenis smooth scrolling and anchor handling.",
    category: "infrastructure",
    entryFile: "SmoothScroll",
    exportName: "SmoothScrollProvider",
    deps: [...BASE, "lenis", "gsap"],
    a11y: ["Anchor navigation moves focus to the target", "Native scrolling kept for touch"],
    reducedMotion: "Lenis never loads; native scroll (smooth CSS behaviour only under no-preference).",
    perfNotes: "Lenis imported after load + idle; autoRaf; optional ScrollTrigger sync.",
  },
  {
    id: "motion-reveal",
    name: "Motion reveal",
    description: "Opacity + y reveal on scroll using Motion (motion/react) with LazyMotion.",
    category: "scroll",
    entryFile: "Reveal",
    exportName: "Reveal",
    deps: [...BASE, "motion"],
    a11y: ["Wrapper div adds no semantics; content stays in DOM order"],
    reducedMotion: "useReducedMotion() → static wrapper without animation.",
    perfNotes: "LazyMotion + domAnimation feature bundle; transform/opacity only; below-the-fold use.",
  },
];

function build(meta: PatternMeta): PatternDef {
  const { entryFile, exportName, deps, ...rest } = meta;
  const files = readPatternFiles(meta.id);
  const css = `src/patterns/${meta.id}/styles.css`;
  return {
    ...rest,
    files,
    dependencies: Object.fromEntries(deps.map((d) => [d, PATTERN_DEP_VERSIONS[d]])),
    entry: { path: `./patterns/${meta.id}/${entryFile}`, name: exportName },
    ...(files[css] !== undefined ? { css } : {}),
  };
}

let cache: PatternDef[] | null = null;

/** All patterns (files read from disk once). */
export function getPatterns(): PatternDef[] {
  cache ??= META.map(build);
  return cache;
}

export function getPattern(id: string): PatternDef {
  const p = getPatterns().find((x) => x.id === id);
  if (!p) throw new Error(`Unknown pattern "${id}"`);
  return p;
}

export const PATTERN_IDS = META.map((m) => m.id);

/** Merge files + dependencies of several patterns (shared helper files dedupe by path). */
export function bundlePatterns(ids: string[]): { files: Record<string, string>; dependencies: Record<string, string>; css: string[] } {
  const files: Record<string, string> = {};
  const dependencies: Record<string, string> = {};
  const css: string[] = [`src/patterns/${SHARED}/a11y.css`];
  for (const id of [...new Set(ids)]) {
    const p = getPattern(id);
    Object.assign(files, p.files);
    Object.assign(dependencies, p.dependencies);
    if (p.css) css.push(p.css);
  }
  return { files, dependencies, css };
}


/** The pattern library (BUILD_PLAN contract: `patterns: PatternDef[]`). Files are read from disk on import. */
export const patterns: PatternDef[] = getPatterns();
