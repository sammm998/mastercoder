import { skipped, type GateContext, type GateOutcome } from "./context.js";

/** Lighthouse scores may come as 0..1 (raw LHR) or 0..100; normalize to 0..100. */
function pct(n: number): number {
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

export async function lighthouseGate(ctx: GateContext): Promise<GateOutcome> {
  if (!ctx.opts.lighthouse) return skipped("skipped: no lighthouse runner injected (opts.lighthouse)");
  if (!ctx.opts.previewUrl) return skipped("skipped: no previewUrl");
  const minPerf = ctx.opts.thresholds?.performance ?? 85;
  const minA11y = ctx.opts.thresholds?.accessibility ?? 90;
  const scores = await ctx.opts.lighthouse(ctx.opts.previewUrl);
  const perf = pct(scores.performance);
  const a11y = pct(scores.accessibility);
  const details = `performance ${perf} (>= ${minPerf}), accessibility ${a11y} (>= ${minA11y}) for ${ctx.opts.previewUrl}`;
  const findings = [
    ...(perf < minPerf ? [{ rule: "lighthouse/performance", message: `performance score ${perf} < ${minPerf}`, severity: "error" as const }] : []),
    ...(a11y < minA11y ? [{ rule: "lighthouse/accessibility", message: `accessibility score ${a11y} < ${minA11y}`, severity: "error" as const }] : []),
  ];
  if (findings.length === 0) return { passed: true, details, findings };
  const fixes: string[] = [];
  if (perf < minPerf)
    fixes.push(
      "Performance: serve images as AVIF/WebP with explicit width/height and lazy loading below the fold, preload the LCP image and fonts (font-display: swap), " +
        "code-split heavy client components (dynamic import for 3D/animation libs), remove unused JS/CSS, and avoid layout shift from late-loading content.",
    );
  if (a11y < minA11y)
    fixes.push(
      "Accessibility: give every image meaningful alt text, label all form controls, ensure text contrast >= 4.5:1, use one <h1> and ordered headings, " +
        "add discernible names to icon buttons/links, set <html lang>, and keep focus outlines visible.",
    );
  return { passed: false, details, findings, fix: fixes.join("\n") };
}

export async function visualQaGate(ctx: GateContext): Promise<GateOutcome> {
  const score = ctx.opts.visualScore;
  if (score === undefined) return skipped("skipped: no visual QA score provided (opts.visualScore)");
  const min = ctx.opts.thresholds?.visual ?? 8;
  if (score >= min) return { passed: true, details: `visual QA score ${score} >= ${min}`, findings: [] };
  return {
    passed: false,
    details: `visual QA score ${score} < ${min}`,
    findings: [{ rule: "visual-qa/score", message: `visual QA score ${score} below ${min}`, severity: "error" }],
    fix:
      "Iterate on the design against the chosen art direction: tighten the type scale and spacing rhythm, fix alignment to the grid, increase contrast " +
      "between surface and accent, make the hero focal point unambiguous, and check 375/768/1440px layouts for overflow before re-scoring.",
  };
}
