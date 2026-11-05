import { gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MockLLMProvider, type CompletionRequest, type LLMProvider } from "@forge/llm";
import {
  CHECKLIST,
  CRITERIA,
  LIGHTHOUSE_LIMITS,
  checklistText,
  designQALoop,
  heuristicCritique,
  meetsLighthouseLimits,
  overallScore,
  serveStatic,
  visualQA,
  type PageMetrics,
  type VisualQAResult,
} from "../src/index.js";

export const goodMetrics: PageMetrics = {
  contrast: { checked: 200, failing: 0, unknownBackground: 3, minRatio: 4.8, failures: [] },
  spacing: { samples: 300, onScale: 290, ratio: 290 / 300, scale: [4, 8, 16], offScaleExamples: [270] },
  fonts: { families: ["Unbounded", "Onest", "JetBrains Mono"], count: 3, webFontsLoaded: ["Unbounded", "Onest", "JetBrains Mono"] },
  headings: { levels: [1, 2, 3, 3, 2], h1Count: 1, skips: 0, h1ToBodyRatio: 7, maxDisplayPx: 130 },
  cls: 0.01,
  motion: { animationRules: 2, transitionRules: 8, reducedMotionGuards: 6, runningAnimations: 3, scrollTrigger: true, webgl: false, canvases: 0, activeMotionElements: 9, layoutAnimations: [], reduced: { runningAnimations: 0, activeMotionElements: 0, canvases: 0 } },
  overflow375: { scrollWidth: 375, viewport: 375, offenders: [] },
  tapTargets: { checked: 12, tooSmall: 0, examples: [] },
  images: { total: 4, missingAlt: 0 },
  rhythm: { sectionPaddings: [256, 256, 192, 256], beats: 2, cv: 0.12, medianLineChars: 58, bodyLineHeight: 1.6 },
  layout: { sections: 7, patterns: ["hero-3d", "split-text", "bento-grid", "sticky-story", "marquee"], centeredHeadingRatio: 0 },
};

const badMetrics: PageMetrics = {
  ...goodMetrics,
  contrast: { checked: 100, failing: 30, unknownBackground: 0, minRatio: 1.9, failures: [{ text: "Subtle grey", ratio: 1.9, required: 4.5, viewport: 375 }] },
  fonts: { families: ["Arial", "Georgia", "Verdana", "Comic Sans", "Impact"], count: 5, webFontsLoaded: [] },
  headings: { levels: [2, 4, 1, 1], h1Count: 2, skips: 2, h1ToBodyRatio: 1.5, maxDisplayPx: 32 },
  cls: 0.32,
  motion: { animationRules: 0, transitionRules: 0, reducedMotionGuards: 0, runningAnimations: 0, scrollTrigger: false, webgl: false, canvases: 0, activeMotionElements: 0, layoutAnimations: [".box transition width"] },
  overflow375: { scrollWidth: 420, viewport: 375, offenders: ["div.hero"] },
  tapTargets: { checked: 10, tooSmall: 6, examples: ["x 12x12"] },
  rhythm: { sectionPaddings: [10, 200, 40, 400, 5, 90], beats: 6, cv: 1.1, medianLineChars: 140, bodyLineHeight: 1.1 },
  spacing: { samples: 100, onScale: 20, ratio: 0.2, scale: [], offScaleExamples: [13, 27] },
  layout: { sections: 3, patterns: [], centeredHeadingRatio: 1 },
};

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 1440, height: 3000, channels: 3, background: "#101010" } }).png().toBuffer();
}

describe("checklist", () => {
  it("covers every criterion", () => {
    expect(CHECKLIST.map((c) => c.criterion).sort()).toEqual([...CRITERIA].sort());
    const text = checklistText();
    for (const c of CHECKLIST) expect(text).toContain(c.title);
  });
});

describe("heuristic critic", () => {
  it("scores a well-built page >= 8 and labels itself", () => {
    const r = heuristicCritique(goodMetrics);
    expect(r.critic).toBe("heuristic");
    expect(overallScore(r.criteria)).toBeGreaterThanOrEqual(8);
    for (const c of CRITERIA) expect(r.criteria[c]).toBeGreaterThanOrEqual(7);
    expect(r.notes).toMatch(/not a vision model/);
  });

  it("penalises contrast failures, overflow, CLS, layout animations and template layouts", () => {
    const r = heuristicCritique(badMetrics);
    expect(overallScore(r.criteria)).toBeLessThan(5);
    expect(r.criteria.contrast).toBeLessThan(5);
    expect(r.criteria.motion).toBeLessThan(4);
    expect(r.suggestions.join("\n")).toMatch(/Subtle grey/);
    expect(r.suggestions.join("\n")).toMatch(/overflow/);
    expect(r.suggestions.join("\n")).toMatch(/CLS/);
    expect(r.suggestions.join("\n")).toMatch(/transform\/opacity instead of/);
  });

  it("returns minimum scores when metrics are missing", () => {
    const r = heuristicCritique(undefined);
    expect(overallScore(r.criteria)).toBe(1);
  });
});

describe("visualQA", () => {
  it("uses image blocks, MODEL_VISION_REVIEW and the mock heuristic critic", async () => {
    const llm = new MockLLMProvider();
    const shot = await png();
    const r = await visualQA(llm, [{ viewport: 1440, width: 1440, height: 900, png: shot }], { heuristics: goodMetrics });
    const req = llm.calls[0]!;
    expect(req.purpose).toBe("design.critic");
    expect(req.model).toBe(process.env.MODEL_VISION_REVIEW || "claude-sonnet-5-5");
    const blocks = req.messages[0]!.content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === "image")).toBe(true);
    expect(r.critic).toBe("heuristic");
    expect(r.score).toBeGreaterThanOrEqual(8);
    expect(r.passed).toBe(true);
  });

  it("reports critic=llm for a real (non-mock) provider", async () => {
    const fake: LLMProvider = {
      name: "fake-vision",
      isMock: false,
      async complete(req: CompletionRequest) {
        return {
          content: [{ type: "text", text: JSON.stringify({ criteria: { hierarchy: 9, spacing: 8, contrast: 9, rhythm: 7, motion: 8, originality: 7 }, notes: "ok", suggestions: ["tighten rhythm"] }) }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: req.model,
          costUsd: 0,
          provider: "fake-vision",
        };
      },
    };
    const r = await visualQA(fake, [{ viewport: 375, width: 375, height: 812, png: await png() }], { threshold: 8.5 });
    expect(r.critic).toBe("llm");
    expect(r.score).toBe(8);
    expect(r.passed).toBe(false);
  });
});

describe("designQALoop", () => {
  const result = (score: number): VisualQAResult => ({
    score,
    criteria: Object.fromEntries(CRITERIA.map((c) => [c, score])) as VisualQAResult["criteria"],
    notes: "",
    passed: score >= 8,
    suggestions: [`raise to ${score + 1}`],
    critic: "heuristic",
  });

  it("rebuilds with feedback until the threshold is reached", async () => {
    const feedback: Array<VisualQAResult | null> = [];
    const scores = [6, 7.5, 8.4];
    const r = await designQALoop({
      build: async (fb, round) => {
        feedback.push(fb);
        return `http://site/${round}`;
      },
      evaluate: async (url) => ({ result: result(scores[Number(url.split("/").pop()) - 1]!) }),
    });
    expect(r.passed).toBe(true);
    expect(r.rounds).toHaveLength(3);
    expect(feedback[0]).toBeNull();
    expect(feedback[1]!.suggestions[0]).toBe("raise to 7");
    expect(r.best.round).toBe(3);
  });

  it("stops at maxRounds and returns the best round", async () => {
    let n = 0;
    const r = await designQALoop({ build: async () => `u${++n}`, evaluate: async (u) => ({ result: result(u === "u2" ? 7 : 5) }), maxRounds: 3 });
    expect(r.passed).toBe(false);
    expect(r.rounds).toHaveLength(3);
    expect(r.best.url).toBe("u2");
  });
});

describe("lighthouse limits", () => {
  it("enforces performance >= 85 and accessibility >= 90", () => {
    expect(LIGHTHOUSE_LIMITS).toEqual({ performance: 85, accessibility: 90 });
    expect(meetsLighthouseLimits({ performance: 85, accessibility: 90 })).toBe(true);
    expect(meetsLighthouseLimits({ performance: 84, accessibility: 100 })).toBe(false);
  });
});

describe("serveStatic", () => {
  it("serves compressed files, SPA fallback and blocks traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-serve-"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
    await writeFile(join(dir, "assets", "app-abc.js"), "console.log(1)".repeat(50));
    const srv = await serveStatic(dir);
    try {
      const js = await fetch(`${srv.url}assets/app-abc.js`, { headers: { "accept-encoding": "gzip" } });
      expect(js.headers.get("cache-control")).toContain("immutable");
      expect(js.headers.get("content-type")).toContain("text/javascript");
      const raw = Buffer.from(await js.arrayBuffer());
      // fetch transparently decodes gzip; either way the content must round-trip
      const text = js.headers.get("content-encoding") === "gzip" && raw[0] === 0x1f ? gunzipSync(raw).toString() : raw.toString();
      expect(text.startsWith("console.log(1)")).toBe(true);
      expect(await (await fetch(`${srv.url}work/some-route`)).text()).toContain("<title>x</title>");
      expect((await fetch(`${srv.url}missing.png`)).status).toBe(404);
      expect((await fetch(`${srv.url}..%2f..%2fetc%2fpasswd`)).status).toBe(403);
    } finally {
      await srv.close();
    }
  });
});
