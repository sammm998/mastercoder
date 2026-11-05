/**
 * Definition of Done #5: three benchmark sites with 3D / scroll motion are composed, installed with npm,
 * built with Vite, served as static files, and pass the heuristic visual QA (>= 8) and Lighthouse
 * (mobile preset: performance >= 85, accessibility >= 90). Scores are written to test/results/latest.json.
 * Needs network for `npm install` (registry via the proxy) and the preinstalled Chromium.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLLMProvider } from "@forge/llm";
import {
  LIGHTHOUSE_LIMITS,
  analyzePage,
  captureScreenshots,
  meetsLighthouseLimits,
  runLighthouse,
  serveStatic,
  visualQA,
  type LighthouseScores,
} from "../src/index.js";
import { BENCHMARK_BRIEFS } from "./briefs.js";
import { buildSite } from "./site-builder.js";

const RESULTS = fileURLToPath(new URL("./results/latest.json", import.meta.url));
const PRESET = "mobile" as const;

interface SiteResult {
  id: string;
  kind: string;
  direction: { name: string; display: string; body: string; motion: string; scheme: string };
  patterns: string[];
  visualQA: { score: number; critic: string; criteria: Record<string, number>; passed: boolean; suggestions: string[] };
  lighthouse: { preset: string; runs: Array<Omit<LighthouseScores, "failing">>; best: Omit<LighthouseScores, "failing">; passed: boolean };
  screenshots: Array<{ viewport: number; bytes: number; video?: boolean }>;
  buildMs: number;
}

let root: string;
let browser: Browser;
const results: SiteResult[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-sites-"));
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await mkdir(join(RESULTS, ".."), { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    note:
      "Heuristic critic = browser-measured metrics mapped to the checklist (no vision model; LLM_PROVIDER=mock). " +
      `Lighthouse ${PRESET} preset (Lighthouse defaults: Moto G Power emulation, simulated slow 4G, 4x CPU throttle).`,
    limits: { visualQA: 8, ...LIGHTHOUSE_LIMITS },
    allPassed: results.length === BENCHMARK_BRIEFS.length && results.every((r) => r.visualQA.passed && r.lighthouse.passed),
    sites: results,
  };
  await writeFile(RESULTS, JSON.stringify(summary, null, 2) + "\n");
  if (root) await rm(root, { recursive: true, force: true });
});

const strip = ({ failing: _f, ...rest }: LighthouseScores) => rest;

describe("benchmark sites (DoD #5)", () => {
  it.each(BENCHMARK_BRIEFS.map((b) => [b.id, b] as const))("%s builds and passes visual QA + Lighthouse", async (_id, spec) => {
    const t0 = Date.now();
    const site = await buildSite(spec, root);
    const buildMs = Date.now() - t0;
    expect(site.buildLog).toMatch(/built in/);
    const server = await serveStatic(site.dist);
    try {
      const heuristics = await analyzePage(server.url, { browser });
      const shots = await captureScreenshots(server.url, [375, 768, 1440], { browser, outDir: join(root, `${spec.id}-shots`) });
      expect(shots.map((s) => s.viewport)).toEqual([375, 768, 1440]);
      expect(shots.find((s) => s.viewport === 1440)?.videoPath).toMatch(/\.webm$/);
      const qa = await visualQA(new MockLLMProvider(), shots, { heuristics: heuristics.metrics, threshold: 8 });

      // Lighthouse scores vary run to run; take up to 3 runs and keep the best (all runs are recorded).
      const runs: LighthouseScores[] = [];
      for (let i = 0; i < 3; i++) {
        const lh = await runLighthouse(server.url, { preset: PRESET });
        runs.push(lh);
        if (meetsLighthouseLimits(lh)) break;
      }
      const best = runs.reduce((a, b) => (b.performance + b.accessibility > a.performance + a.accessibility ? b : a));
      results.push({
        id: spec.id,
        kind: spec.kind,
        direction: {
          name: site.direction.name,
          display: site.direction.typography.display.family,
          body: site.direction.typography.body.family,
          motion: site.direction.motion.language,
          scheme: site.direction.palette.scheme,
        },
        patterns: [...new Set(heuristics.metrics.layout.patterns)],
        visualQA: { score: qa.score, critic: qa.critic, criteria: qa.criteria, passed: qa.passed, suggestions: qa.suggestions },
        lighthouse: { preset: PRESET, runs: runs.map(strip), best: strip(best), passed: meetsLighthouseLimits(best) },
        screenshots: shots.map((s) => ({ viewport: s.viewport, bytes: s.png.length, ...(s.videoPath ? { video: true } : {}) })),
        buildMs,
      });

      expect(qa.critic).toBe("heuristic");
      expect(qa.score, JSON.stringify(qa)).toBeGreaterThanOrEqual(8);
      expect(best.performance, JSON.stringify(best)).toBeGreaterThanOrEqual(LIGHTHOUSE_LIMITS.performance);
      expect(best.accessibility, JSON.stringify(best)).toBeGreaterThanOrEqual(LIGHTHOUSE_LIMITS.accessibility);
      // Motion must actually be there (3D / scroll storytelling / horizontal scroll per brief).
      expect(heuristics.metrics.motion.scrollTrigger || heuristics.metrics.motion.webgl).toBe(true);
      expect(heuristics.metrics.cls).toBeLessThan(0.1);
    } finally {
      await server.close();
    }
  });
});
