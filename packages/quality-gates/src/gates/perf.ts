import { skipped, type GateContext, type GateOutcome } from "./context.js";

/** Lighthouse scores may come as 0..1 (raw LHR) or 0..100; normalize to 0..100. */
function pct(n: number): number {
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}



/**
 * Lighthouse must measure what visitors get: a dev server is unminified and un-bundled, so its
 * performance score is meaningless (and "fixing" it strips the design). When the project has
 * build + preview scripts, build it and measure the production preview; otherwise fall back to the
 * dev preview URL.
 */
async function productionUrl(ctx: GateContext, PROD_PORT: number): Promise<string | null> {
  const scripts = ctx.project.packageJson?.scripts ?? {};
  if (!scripts.build || !scripts.preview) return null;
  const b = await ctx.sb.exec("npm run build", { timeoutMs: 300_000 });
  if (b.exitCode !== 0) return null;
  await ctx.sb.exec(`nohup npm run preview -- --host 127.0.0.1 --port ${PROD_PORT} > /tmp/forge-prod-preview.log 2>&1 &`, { timeoutMs: 15_000 });
  const probe = `node -e "fetch('http://127.0.0.1:${PROD_PORT}/').then(r=>console.log(r.status)).catch(()=>console.log(0))"`;
  for (let i = 0; i < 30; i++) {
    const r = await ctx.sb.exec(probe, { timeoutMs: 8_000 });
    if (/^[23]\d\d$/.test(r.stdout.trim())) return (await ctx.sb.exposePort(PROD_PORT)).url;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return null;
}

export async function lighthouseGate(ctx: GateContext): Promise<GateOutcome> {
  if (!ctx.opts.lighthouse) return skipped("skipped: no lighthouse runner injected (opts.lighthouse)");
  if (!ctx.opts.previewUrl) return skipped("skipped: no previewUrl");
  // A fresh port per run: sandboxes may share a host with other projects' previews.
  const PROD_PORT = 40000 + Math.floor(Math.random() * 9000);
  const prod = await productionUrl(ctx, PROD_PORT).catch(() => null);
  try {
    return await measure(ctx, prod ?? ctx.opts.previewUrl, !!prod);
  } finally {
    if (prod) await ctx.sb.exec(`pkill -f -- "--host 127.0.0.1 --port ${PROD_PORT}" >/dev/null 2>&1 || true`, { timeoutMs: 10_000 }).catch(() => undefined);
  }
}

async function measure(ctx: GateContext, url: string, production: boolean): Promise<GateOutcome> {
  // A dev server can't reach production scores: measure it, but only accessibility blocks there.
  const minPerf = production ? (ctx.opts.thresholds?.performance ?? 85) : 0;
  const minA11y = ctx.opts.thresholds?.accessibility ?? 90;
  const scores = await ctx.opts.lighthouse!(url);
  const perf = pct(scores.performance);
  const a11y = pct(scores.accessibility);
  const details = `performance ${perf} (>= ${minPerf}${production ? "" : ", dev server — not enforced"}), accessibility ${a11y} (>= ${minA11y}) for ${production ? "production build" : url}`;
  const findings = [
    ...(perf < minPerf ? [{ rule: "lighthouse/performance", message: `performance score ${perf} < ${minPerf}`, severity: "error" as const }] : []),
    ...(a11y < minA11y ? [{ rule: "lighthouse/accessibility", message: `accessibility score ${a11y} < ${minA11y}`, severity: "error" as const }] : []),
  ];
  if (findings.length === 0) return { passed: true, details, findings };
  const fixes: string[] = [];
  if (perf < minPerf)
    fixes.push(
      "Performance: serve images as AVIF/WebP with explicit width/height and lazy loading below the fold, preload the LCP image and fonts (font-display: swap), " +
        "code-split heavy client components (dynamic import for 3D/animation libs), remove unused JS/CSS, and avoid layout shift from late-loading content. " +
        "Keep the design's scroll effects and animations: optimise how they load (CSS/transform-only, lazy-init below the fold), never delete them.",
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

/** Every internal page and in-page link works: no 404s, empty pages, dead anchors or uncaught JS errors. */
export async function linksGate(ctx: GateContext): Promise<GateOutcome> {
  if (!ctx.opts.crawl) return skipped("skipped: no crawler injected (opts.crawl)");
  if (!ctx.opts.previewUrl) return skipped("skipped: no previewUrl");
  const pages = await ctx.opts.crawl(ctx.opts.previewUrl);
  const broken = pages.filter((p) => !p.ok);
  const path = (u: string) => {
    try {
      return new URL(u).pathname || "/";
    } catch {
      return u;
    }
  };
  if (!broken.length) return { passed: true, details: `${pages.length} page(s) visited, every link works`, findings: [] };
  return {
    passed: false,
    details: `${broken.length} of ${pages.length} page(s) broken`,
    findings: broken.flatMap((p) => p.problems.map((m) => ({ rule: "links/broken", message: `${path(p.url)}: ${m}`, severity: "error" as const }))),
    fix:
      "Make every navigation link work like a real site: create the missing pages/routes (with real content), point anchors at sections that exist, " +
      "add an SPA fallback/router for client-side routes, and fix the JavaScript errors listed:\n" +
      broken.map((p) => `- ${path(p.url)}: ${p.problems.join("; ")}`).join("\n"),
  };
}
