import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { AUTOSCROLL_SCRIPT, CLS_INIT_SCRIPT, measureExpression } from "./measure-script.js";
import { heuristicCritique, overallScore, PageMetricsSchema, type CriticResult, type PageMetrics } from "./critic-heuristic.js";
import type { Criterion } from "../types.js";

export interface HeuristicReport {
  url: string;
  metrics: PageMetrics;
  criteria: Record<Criterion, number>;
  score: number;
  notes: string;
  suggestions: string[];
  critic: "heuristic";
}

export interface AnalyzeOptions {
  /** Reuse an existing browser (closed by the caller). */
  browser?: Browser;
  timeoutMs?: number;
  /** Extra settle time after load (ms) for lazy chunks/fonts. */
  settleMs?: number;
}

interface RawMeasure {
  viewport: number;
  contrast: PageMetrics["contrast"];
  spacing: PageMetrics["spacing"];
  fonts: PageMetrics["fonts"];
  headings: PageMetrics["headings"];
  cls: number;
  motion: Omit<PageMetrics["motion"], "reduced">;
  overflow: PageMetrics["overflow375"];
  tapTargets: PageMetrics["tapTargets"];
  images: PageMetrics["images"];
  rhythm: PageMetrics["rhythm"];
  layout: PageMetrics["layout"];
}

export async function openPage(context: BrowserContext, url: string, timeoutMs: number, settleMs: number): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(CLS_INIT_SCRIPT);
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
  } catch {
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
  }
  await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
  await page.waitForTimeout(settleMs);
  await page.evaluate(AUTOSCROLL_SCRIPT);
  await page.waitForTimeout(Math.min(1500, settleMs));
  return page;
}

async function measure(browser: Browser, url: string, viewport: { width: number; height: number }, opts: { mobile?: boolean; reducedMotion?: "reduce" | "no-preference"; timeoutMs: number; settleMs: number }): Promise<RawMeasure> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: opts.mobile ?? false,
    hasTouch: opts.mobile ?? false,
    reducedMotion: opts.reducedMotion ?? "no-preference",
  });
  try {
    const page = await openPage(context, url, opts.timeoutMs, opts.settleMs);
    return (await page.evaluate(measureExpression(viewport.width))) as RawMeasure;
  } finally {
    await context.close();
  }
}

/**
 * Heuristic critic: load the page in Chromium at 1440px, 375px (mobile, touch) and 1440px with emulated
 * prefers-reduced-motion, measure real metrics and map them to the 1-10 checklist criteria.
 */
export async function analyzePage(url: string, opts: AnalyzeOptions = {}): Promise<HeuristicReport> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const settleMs = opts.settleMs ?? 1500;
  const browser = opts.browser ?? (await chromium.launch());
  try {
    const desktop = await measure(browser, url, { width: 1440, height: 900 }, { timeoutMs, settleMs });
    const mobile = await measure(browser, url, { width: 375, height: 812 }, { mobile: true, timeoutMs, settleMs });
    const reduced = await measure(browser, url, { width: 1440, height: 900 }, { reducedMotion: "reduce", timeoutMs, settleMs });
    const metrics = PageMetricsSchema.parse({
      contrast: {
        checked: desktop.contrast.checked + mobile.contrast.checked,
        failing: desktop.contrast.failing + mobile.contrast.failing,
        unknownBackground: desktop.contrast.unknownBackground + mobile.contrast.unknownBackground,
        minRatio: Math.min(desktop.contrast.minRatio || 21, mobile.contrast.minRatio || 21),
        failures: [...desktop.contrast.failures, ...mobile.contrast.failures],
      },
      spacing: {
        samples: desktop.spacing.samples + mobile.spacing.samples,
        onScale: desktop.spacing.onScale + mobile.spacing.onScale,
        ratio: (desktop.spacing.onScale + mobile.spacing.onScale) / Math.max(1, desktop.spacing.samples + mobile.spacing.samples),
        scale: desktop.spacing.scale,
        offScaleExamples: [...new Set([...desktop.spacing.offScaleExamples, ...mobile.spacing.offScaleExamples])].slice(0, 10),
      },
      fonts: desktop.fonts,
      headings: desktop.headings,
      cls: Math.max(desktop.cls, mobile.cls),
      motion: { ...desktop.motion, reduced: { runningAnimations: reduced.motion.runningAnimations, activeMotionElements: reduced.motion.activeMotionElements, canvases: reduced.motion.canvases } },
      overflow375: mobile.overflow,
      tapTargets: mobile.tapTargets,
      images: desktop.images,
      rhythm: desktop.rhythm,
      layout: desktop.layout,
    });
    const critique: CriticResult = heuristicCritique(metrics);
    return {
      url,
      metrics,
      criteria: critique.criteria,
      score: overallScore(critique.criteria),
      notes: critique.notes,
      suggestions: critique.suggestions,
      critic: "heuristic",
    };
  } finally {
    if (!opts.browser) await browser.close();
  }
}
