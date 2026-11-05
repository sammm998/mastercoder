import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
  preset: "mobile" | "desktop";
  metrics: { fcpMs: number; lcpMs: number; tbtMs: number; cls: number; speedIndexMs: number };
  /** Failing audits (score < 0.9) with titles, for feedback. */
  failing: Array<{ id: string; title: string; score: number | null }>;
  lighthouseVersion: string;
}

/** Hard limits from the Forge quality bar. */
export const LIGHTHOUSE_LIMITS = { performance: 85, accessibility: 90 } as const;

export function meetsLighthouseLimits(s: Pick<LighthouseScores, "performance" | "accessibility">): boolean {
  return s.performance >= LIGHTHOUSE_LIMITS.performance && s.accessibility >= LIGHTHOUSE_LIMITS.accessibility;
}

/** Locate a Chromium binary: CHROME_PATH, the preinstalled Playwright browsers, then Playwright's own path. */
export async function findChromium(): Promise<string> {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter((x): x is string => Boolean(x));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  const { chromium } = await import("playwright");
  const p = chromium.executablePath();
  if (p && existsSync(p)) return p;
  throw new Error("No Chromium found: set CHROME_PATH");
}

export interface LighthouseOptions {
  preset?: "mobile" | "desktop";
  chromePath?: string;
  chromeFlags?: string[];
}

/**
 * Run Lighthouse (performance, accessibility, best-practices, SEO) against a URL with a headless Chromium
 * launched by chrome-launcher. Mobile preset = Lighthouse defaults (Moto G Power emulation, simulated
 * slow 4G, 4x CPU throttling); desktop preset = Lighthouse's desktop config.
 */
export async function runLighthouse(url: string, opts: LighthouseOptions = {}): Promise<LighthouseScores> {
  const preset = opts.preset ?? "mobile";
  const [{ default: lighthouse, desktopConfig }, chromeLauncher] = await Promise.all([import("lighthouse"), import("chrome-launcher")]);
  const chrome = await chromeLauncher.launch({
    chromePath: opts.chromePath ?? (await findChromium()),
    chromeFlags: opts.chromeFlags ?? ["--headless=new", "--no-sandbox", "--disable-gpu-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const flags = { port: chrome.port, output: "json" as const, logLevel: "error" as const, onlyCategories: ["performance", "accessibility", "best-practices", "seo"] };
    const result = await lighthouse(url, flags, preset === "desktop" ? desktopConfig : undefined);
    if (!result) throw new Error("Lighthouse returned no result");
    const lhr = result.lhr;
    if (lhr.runtimeError) throw new Error(`Lighthouse runtime error: ${lhr.runtimeError.code} ${lhr.runtimeError.message}`);
    const cat = (k: string) => Math.round((lhr.categories[k]?.score ?? 0) * 100);
    const num = (id: string) => Number(lhr.audits[id]?.numericValue ?? 0);
    const failing = Object.values(lhr.audits)
      .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "informative" && a.scoreDisplayMode !== "manual" && a.scoreDisplayMode !== "notApplicable")
      .map((a) => ({ id: a.id, title: a.title, score: a.score }))
      .slice(0, 30);
    return {
      performance: cat("performance"),
      accessibility: cat("accessibility"),
      bestPractices: cat("best-practices"),
      seo: cat("seo"),
      preset,
      metrics: {
        fcpMs: Math.round(num("first-contentful-paint")),
        lcpMs: Math.round(num("largest-contentful-paint")),
        tbtMs: Math.round(num("total-blocking-time")),
        cls: Math.round(num("cumulative-layout-shift") * 1000) / 1000,
        speedIndexMs: Math.round(num("speed-index")),
      },
      failing,
      lighthouseVersion: lhr.lighthouseVersion,
    };
  } finally {
    chrome.kill();
  }
}
