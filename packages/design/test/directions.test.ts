import { describe, expect, it } from "vitest";
import { MeteredLLM, MockLLMProvider } from "@forge/llm";
import { MemoryUsageSink } from "@forge/shared";
import {
  ARCHETYPES,
  FONT_PAIRINGS,
  GRID_SYSTEMS,
  MOTION_LANGUAGES,
  applyBrand,
  checkPalette,
  contrastRatio,
  curatedDirections,
  generateDirections,
  normalizeDirection,
  pickDirection,
  scoreDirections,
  type DesignBriefInput,
} from "../src/index.js";
import { BENCHMARK_BRIEFS } from "./briefs.js";

const ebike = BENCHMARK_BRIEFS[0]!.brief;
const architect = BENCHMARK_BRIEFS[1]!.brief;

describe("curated libraries", () => {
  it("has >=12 OFL font pairings, >=6 motion languages and several grids", () => {
    expect(FONT_PAIRINGS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(FONT_PAIRINGS.map((p) => p.display.family)).size).toBe(FONT_PAIRINGS.length);
    expect(FONT_PAIRINGS.every((p) => p.display.license === "OFL-1.1" && p.body.license === "OFL-1.1")).toBe(true);
    expect(MOTION_LANGUAGES.length).toBeGreaterThanOrEqual(6);
    expect(MOTION_LANGUAGES.every((m) => /^cubic-bezier\(/.test(m.easing))).toBe(true);
    expect(GRID_SYSTEMS.length).toBeGreaterThanOrEqual(4);
    for (const a of ARCHETYPES) expect(FONT_PAIRINGS.some((p) => p.id === a.pairing), a.id).toBe(true);
  });
});

describe("generateDirections (mock LLM)", () => {
  it("returns exactly 3 genuinely different, AA-compliant directions", async () => {
    const dirs = await generateDirections(new MockLLMProvider(), ebike);
    expect(dirs).toHaveLength(3);
    expect(new Set(dirs.map((d) => d.id)).size).toBe(3);
    expect(new Set(dirs.map((d) => d.typography.display.family)).size).toBe(3);
    expect(new Set(dirs.map((d) => d.motion.language)).size).toBe(3);
    expect(new Set(dirs.map((d) => d.palette.scheme)).size).toBe(2);
    for (const d of dirs) {
      expect(checkPalette(d.palette).every((c) => c.pass), d.name).toBe(true);
      expect(d.typography.scale).toHaveLength(7);
      expect(d.spacing).toHaveLength(10);
      expect(d.radius).toHaveLength(3);
      expect(d.rationale.length).toBeGreaterThan(80);
    }
  });

  it("derives directions from brief keywords and is deterministic", async () => {
    const a = await generateDirections(new MockLLMProvider(), ebike);
    const b = await generateDirections(new MockLLMProvider(), ebike);
    expect(a).toEqual(b);
    const arch = curatedDirections((await import("../src/types.js")).DesignBriefSchema.parse(architect));
    expect(arch[0]!.tags).toContain("architecture");
    expect(a[0]!.tags.some((t) => ["electric", "mobility", "energy"].includes(t))).toBe(true);
    expect(arch[0]!.id).not.toBe(a[0]!.id);
  });

  it("meters the call through MeteredLLM with purpose design.directions on MODEL_PLANNER", async () => {
    const sink = new MemoryUsageSink();
    const mock = new MockLLMProvider();
    await generateDirections(new MeteredLLM(mock, sink), ebike);
    expect(mock.calls[0]!.purpose).toBe("design.directions");
    expect(mock.calls[0]!.model).toBe(process.env.MODEL_PLANNER || "claude-opus-5-5");
    expect(sink.records.length).toBeGreaterThan(0);
    expect(sink.totalUsd()).toBeGreaterThan(0);
  });

  it("normalises LLM output: fixes contrast, sorts scales, clamps pill radii", async () => {
    const base = curatedDirections((await import("../src/types.js")).DesignBriefSchema.parse(ebike))[0]!;
    const broken = { ...base, id: "Bad Dir!", radius: [4, 8, 999], palette: { ...base.palette, text: base.palette.bg, accent: base.palette.bg } };
    const llm = new MockLLMProvider().on("design.directions", () => JSON.stringify({ directions: [broken, { ...base, id: "b" }, { ...base, id: "c" }] }));
    const dirs = await generateDirections(llm, ebike);
    expect(dirs[0]!.id).toBe("bad-dir-");
    expect(contrastRatio(dirs[0]!.palette.text, dirs[0]!.palette.bg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(dirs[0]!.palette.accent, dirs[0]!.palette.bg)).toBeGreaterThanOrEqual(3);
    expect(dirs[0]!.radius[2]).toBeLessThanOrEqual(48);
    expect(dirs[0]!.buttonRadius).toBe(999);
    expect(normalizeDirection(base).palette.oklch.bg).toMatch(/oklch/);
  });

  it("brand overrides the direction (colours adjusted for AA, fonts replaced)", async () => {
    const dirs = await generateDirections(new MockLLMProvider(), ebike, { colors: { primary: "#ffde00", background: "#ffffff" }, fonts: { display: "Space Grotesk" } });
    for (const d of dirs) {
      expect(d.palette.bg).toBe("#ffffff");
      expect(d.palette.scheme).toBe("light");
      expect(d.typography.display.family).toBe("Space Grotesk");
      expect(contrastRatio(d.palette.accent, d.palette.bg)).toBeGreaterThanOrEqual(3);
      expect(d.rationale).toMatch(/Brand overrides applied/);
      expect(d.rationale).toMatch(/lightness-adjusted/);
    }
    const kept = applyBrand(dirs[0]!, { colors: { primary: "#1a3cff" } });
    expect(kept.palette.accent).toBe("#1a3cff");
  });
});

describe("pickDirection", () => {
  it("scores fit by tags and requested features", async () => {
    const brief: DesignBriefInput = { name: "Kiln", description: "A calm wellness studio for organic food and yoga", keywords: ["wellness", "organic"] };
    const dirs = await generateDirections(new MockLLMProvider(), brief);
    const reversed = [...dirs].reverse();
    const picked = pickDirection(reversed, brief);
    const scores = scoreDirections(reversed, brief);
    expect(picked.id).toBe(scores.reduce((a, b) => (b.score > a.score ? b : a)).direction.id);
    expect(picked.tags.some((t) => ["wellness", "organic", "nature", "calm"].includes(t))).toBe(true);
    expect(() => pickDirection([], brief)).toThrow();
  });
});
