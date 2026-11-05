import { z } from "zod";
import { CRITERIA, type Criterion } from "../types.js";

/** Metrics measured in a real browser by analyzePage(). */
export const PageMetricsSchema = z.object({
  contrast: z.object({
    checked: z.number(),
    failing: z.number(),
    unknownBackground: z.number(),
    minRatio: z.number(),
    failures: z.array(z.object({ text: z.string(), ratio: z.number(), required: z.number(), viewport: z.number() })),
  }),
  spacing: z.object({ samples: z.number(), onScale: z.number(), ratio: z.number(), scale: z.array(z.number()), offScaleExamples: z.array(z.number()) }),
  fonts: z.object({ families: z.array(z.string()), count: z.number(), webFontsLoaded: z.array(z.string()) }),
  headings: z.object({ levels: z.array(z.number()), h1Count: z.number(), skips: z.number(), h1ToBodyRatio: z.number(), maxDisplayPx: z.number() }),
  cls: z.number(),
  motion: z.object({
    animationRules: z.number(),
    transitionRules: z.number(),
    reducedMotionGuards: z.number(),
    runningAnimations: z.number(),
    scrollTrigger: z.boolean(),
    webgl: z.boolean(),
    canvases: z.number(),
    activeMotionElements: z.number(),
    layoutAnimations: z.array(z.string()),
    reduced: z.object({ runningAnimations: z.number(), activeMotionElements: z.number(), canvases: z.number() }).optional(),
  }),
  overflow375: z.object({ scrollWidth: z.number(), viewport: z.number(), offenders: z.array(z.string()) }),
  tapTargets: z.object({ checked: z.number(), tooSmall: z.number(), examples: z.array(z.string()) }),
  images: z.object({ total: z.number(), missingAlt: z.number() }),
  rhythm: z.object({ sectionPaddings: z.array(z.number()), beats: z.number().default(0), cv: z.number(), medianLineChars: z.number(), bodyLineHeight: z.number() }),
  layout: z.object({ sections: z.number(), patterns: z.array(z.string()), centeredHeadingRatio: z.number() }),
});
export type PageMetrics = z.infer<typeof PageMetricsSchema>;

export const CriticResultSchema = z.object({
  criteria: z.object(Object.fromEntries(CRITERIA.map((c) => [c, z.number().min(1).max(10)])) as Record<Criterion, z.ZodNumber>),
  notes: z.string(),
  suggestions: z.array(z.string()).default([]),
  critic: z.enum(["llm", "heuristic"]).optional(),
});
export type CriticResult = z.infer<typeof CriticResultSchema>;

const clamp = (n: number) => Math.round(Math.min(10, Math.max(1, n)) * 10) / 10;

/**
 * Map measured page metrics onto the 1-10 checklist criteria. Deterministic; this is the "heuristic"
 * critic used when no vision model is available (LLM_PROVIDER=mock).
 */
export function heuristicCritique(raw: unknown): CriticResult {
  const parsed = PageMetricsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      criteria: Object.fromEntries(CRITERIA.map((c) => [c, 1])) as Record<Criterion, number>,
      notes: `heuristic critic: no valid page metrics supplied (${parsed.error.issues[0]?.message ?? "missing"}) — run analyzePage() first`,
      suggestions: ["Pass analyzePage(url).metrics as ctx.heuristics"],
      critic: "heuristic",
    };
  }
  const m = parsed.data;
  const notes: string[] = [];
  const suggestions: string[] = [];

  // Contrast
  let contrast = 5;
  if (m.contrast.checked > 0) {
    const pass = 1 - m.contrast.failing / m.contrast.checked;
    contrast = pass >= 1 ? 10 : 10 - (1 - pass) * 40;
    notes.push(`contrast: ${m.contrast.checked - m.contrast.failing}/${m.contrast.checked} text nodes pass AA (min ${m.contrast.minRatio.toFixed(2)}:1)`);
    for (const f of m.contrast.failures.slice(0, 3)) suggestions.push(`Raise contrast of "${f.text}" (${f.ratio.toFixed(2)}:1 < ${f.required}:1 at ${f.viewport}px)`);
  } else notes.push("contrast: no measurable text");

  // Hierarchy
  let hierarchy = 10;
  if (m.headings.h1Count !== 1) {
    hierarchy -= 3;
    suggestions.push(`Use exactly one h1 (found ${m.headings.h1Count})`);
  }
  hierarchy -= Math.min(4, m.headings.skips * 1.5);
  if (m.headings.skips) suggestions.push(`Fix ${m.headings.skips} heading level skip(s)`);
  if (m.headings.h1ToBodyRatio < 2) hierarchy -= 3;
  else if (m.headings.h1ToBodyRatio < 3) hierarchy -= 1.5;
  if (m.fonts.count > 3) {
    hierarchy -= 2;
    suggestions.push(`Reduce font families from ${m.fonts.count} to 2-3`);
  } else if (m.fonts.count < 2) hierarchy -= 1;
  notes.push(`hierarchy: h1 ${m.headings.h1Count}, skips ${m.headings.skips}, h1/body ${m.headings.h1ToBodyRatio.toFixed(1)}x, ${m.fonts.count} families`);

  // Spacing
  let spacing = 4 + 6 * m.spacing.ratio;
  if (m.overflow375.offenders.length || m.overflow375.scrollWidth > m.overflow375.viewport + 1) {
    spacing -= 3;
    suggestions.push(`Fix horizontal overflow at 375px (${m.overflow375.offenders.slice(0, 3).join(", ") || `scrollWidth ${m.overflow375.scrollWidth}`})`);
  }
  spacing -= Math.min(3, m.tapTargets.tooSmall * 0.5);
  if (m.tapTargets.tooSmall) suggestions.push(`Enlarge ${m.tapTargets.tooSmall} tap target(s) to >=24px: ${m.tapTargets.examples.slice(0, 3).join(", ")}`);
  if (m.spacing.ratio < 0.8) suggestions.push(`Move off-scale spacing (${m.spacing.offScaleExamples.slice(0, 5).join("px, ")}px) onto the --space-* scale`);
  notes.push(`spacing: ${(m.spacing.ratio * 100).toFixed(0)}% of ${m.spacing.samples} values on-scale, ${m.tapTargets.tooSmall} small targets, overflow offenders ${m.overflow375.offenders.length}`);

  // Rhythm
  // Either a near-constant section beat (low CV) or a small set of repeated beats (alternating loud/quiet).
  const cvScore = m.rhythm.cv < 0.25 ? 10 : m.rhythm.cv < 0.5 ? 8.5 : m.rhythm.cv < 0.8 ? 7 : 5.5;
  const beats = m.rhythm.beats;
  const beatScore = beats === 0 ? 0 : beats <= 3 ? 10 : beats === 4 ? 9 : beats === 5 ? 8 : 6.5;
  let rhythm = Math.max(cvScore, beatScore);
  if (m.rhythm.medianLineChars && (m.rhythm.medianLineChars < 35 || m.rhythm.medianLineChars > 90)) {
    rhythm -= 1.5;
    suggestions.push(`Set paragraph measure to 45-85ch (median ${m.rhythm.medianLineChars.toFixed(0)})`);
  }
  if (m.rhythm.bodyLineHeight < 1.35 || m.rhythm.bodyLineHeight > 1.9) rhythm -= 1;
  if (m.images.missingAlt) {
    suggestions.push(`Add alt text to ${m.images.missingAlt} image(s)`);
  }
  notes.push(`rhythm: ${m.rhythm.beats} section beats, padding CV ${m.rhythm.cv.toFixed(2)}, median line ${m.rhythm.medianLineChars.toFixed(0)}ch, body line-height ${m.rhythm.bodyLineHeight.toFixed(2)}`);

  // Motion
  const mo = m.motion;
  const hasMotion = mo.animationRules + mo.transitionRules > 0 || mo.scrollTrigger || mo.webgl || mo.activeMotionElements > 0;
  let motion = hasMotion ? 7 : 3;
  if (mo.scrollTrigger || mo.webgl) motion += 1;
  if (mo.reduced) {
    const quiet = mo.reduced.runningAnimations <= Math.max(0, mo.runningAnimations * 0.2) && mo.reduced.activeMotionElements <= Math.max(0, mo.activeMotionElements * 0.2) && mo.reduced.canvases <= mo.canvases;
    if (quiet) motion += 1;
    else {
      motion -= 2;
      suggestions.push("Honour prefers-reduced-motion: motion still runs when reduced motion is emulated");
    }
  } else if (mo.reducedMotionGuards > 0) motion += 0.5;
  if (m.cls < 0.05) motion += 1;
  else if (m.cls > 0.1) {
    motion -= 3;
    suggestions.push(`Eliminate layout shift (CLS ${m.cls.toFixed(3)})`);
  }
  motion -= Math.min(3, mo.layoutAnimations.length);
  if (mo.layoutAnimations.length) suggestions.push(`Animate transform/opacity instead of ${mo.layoutAnimations.slice(0, 3).join(", ")}`);
  notes.push(`motion: ${mo.animationRules} keyframe + ${mo.transitionRules} transition rules, scrolltrigger=${mo.scrollTrigger}, webgl=${mo.webgl}, CLS ${m.cls.toFixed(3)}, reduced-motion ${mo.reduced ? `${mo.reduced.runningAnimations} running` : "not tested"}`);

  // Originality
  const distinct = new Set(m.layout.patterns).size;
  let originality = 5 + Math.min(3, distinct * 0.6);
  if (m.fonts.webFontsLoaded.length >= 1) originality += 1;
  if (mo.webgl || mo.canvases > 0 || mo.scrollTrigger) originality += 1;
  if (m.headings.maxDisplayPx >= 64) originality += 0.5;
  if (m.layout.centeredHeadingRatio > 0.7) {
    originality -= 2;
    suggestions.push("Break the template feel: fewer centred headings, use asymmetry");
  }
  if (!m.fonts.webFontsLoaded.length) suggestions.push("Load the art direction's web fonts (system fonts read as generic)");
  notes.push(`originality: ${distinct} patterns (${[...new Set(m.layout.patterns)].join(", ")}), web fonts ${m.fonts.webFontsLoaded.join("/") || "none"}, max display ${m.headings.maxDisplayPx.toFixed(0)}px`);

  return {
    criteria: {
      hierarchy: clamp(hierarchy),
      spacing: clamp(spacing),
      contrast: clamp(contrast),
      rhythm: clamp(rhythm),
      motion: clamp(motion),
      originality: clamp(originality),
    },
    notes: `heuristic critic (measured in browser, not a vision model): ${notes.join("; ")}`,
    suggestions,
    critic: "heuristic",
  };
}

export function overallScore(criteria: Record<Criterion, number>): number {
  const vals = CRITERIA.map((c) => criteria[c]);
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}
