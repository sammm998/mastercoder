import type { Criterion } from "../types.js";

/**
 * The written design-QA checklist. Used verbatim in the LLM critic prompt ("design.critic") and mirrored
 * by the heuristic critic, which measures the same criteria in the browser.
 */
export interface ChecklistItem {
  criterion: Criterion;
  title: string;
  checks: string[];
  /** What a 10 / 8 / 5 / 2 looks like. */
  rubric: string;
  /** What the heuristic critic measures for this criterion. */
  heuristic: string;
}

export const CHECKLIST: ChecklistItem[] = [
  {
    criterion: "hierarchy",
    title: "Hierarchy",
    checks: [
      "One unmistakable focal point per viewport; the h1 is the largest text on the page.",
      "Heading levels descend without skips (h1 → h2 → h3) and match visual weight.",
      "Display type is at least 3x body size on desktop; scale steps are clearly distinct.",
      "Two or three type families at most, each with a clear role (display / body / mono).",
    ],
    rubric: "10: instant read order, dramatic scale contrast. 8: clear with minor competing elements. 5: several elements fight for attention. 2: flat, no order.",
    heuristic: "h1 count, heading-level skips, h1/body size ratio, number of font families.",
  },
  {
    criterion: "spacing",
    title: "Spacing",
    checks: [
      "Margins, paddings and gaps come from the spacing scale (tokens), not arbitrary values.",
      "Related items are closer than unrelated ones (proximity), generous outer whitespace.",
      "No horizontal overflow at 375px; content respects the page margin.",
      "Tap targets are at least 24x24 CSS px (44px preferred) with space between them.",
    ],
    rubric: "10: every gap on-scale, calm and intentional. 8: on-scale with a few exceptions. 5: cramped or inconsistent. 2: chaotic, overflowing.",
    heuristic: "share of margin/padding/gap values on the --space-* scale, elements overflowing at 375px, undersized tap targets.",
  },
  {
    criterion: "contrast",
    title: "Contrast",
    checks: [
      "Body text meets WCAG AA 4.5:1; large text (>=24px or >=18.66px bold) meets 3:1.",
      "Accent colour on background is legible for the sizes it is used at.",
      "Text over imagery or WebGL has a scrim or sits on a solid surface.",
    ],
    rubric: "10: everything AA (body AAA). 8: AA everywhere that matters. 5: some failing text. 2: widespread failures.",
    heuristic: "computed WCAG contrast of every visible text node against its composited background.",
  },
  {
    criterion: "rhythm",
    title: "Rhythm",
    checks: [
      "Section spacing follows a consistent beat; density alternates deliberately (loud/quiet).",
      "Body line length stays around 45–85 characters; line-height 1.4–1.8 for body copy.",
      "Grid columns and alignment are consistent between sections.",
    ],
    rubric: "10: musical pacing, consistent measure. 8: consistent with small lapses. 5: uneven. 2: random.",
    heuristic: "coefficient of variation of section vertical padding, median paragraph line length, body line-height.",
  },
  {
    criterion: "motion",
    title: "Motion quality",
    checks: [
      "Motion supports the story (scroll-linked scenes, reveals, 3D) and uses one motion language.",
      "Only transform/opacity animate; no layout shift (CLS < 0.1, ideally < 0.05).",
      "prefers-reduced-motion is honoured: no autoplaying or scroll-jacked motion when set.",
      "Heavy motion (WebGL, GSAP) is lazy-loaded and never blocks first paint.",
    ],
    rubric: "10: purposeful, smooth, accessible. 8: good with minor excess. 5: decorative or janky. 2: none, or harmful (shifts, no reduced-motion).",
    heuristic: "presence of CSS/JS/scroll/WebGL motion, layout-property animations, CLS, behaviour under emulated reduced motion.",
  },
  {
    criterion: "originality",
    title: "Originality",
    checks: [
      "Not a template: avoids centred-hero + three identical cards + generic footer.",
      "Distinctive type pairing and art direction; layout uses asymmetry or scale surprises.",
      "Signature moments (3D, scroll storytelling, kinetic type) that fit the brand.",
      "Never imitates a specific existing website.",
    ],
    rubric: "10: memorable, award-level. 8: distinctive with a clear point of view. 5: competent but generic. 2: default template.",
    heuristic: "number of distinct motion/layout patterns, custom web fonts, WebGL/canvas, expressive display size, share of centred headings.",
  },
];

export function checklistText(): string {
  return CHECKLIST.map(
    (c) => `## ${c.title} (${c.criterion})\n${c.checks.map((x) => `- ${x}`).join("\n")}\nRubric: ${c.rubric}`,
  ).join("\n\n");
}
