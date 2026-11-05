import { describe, expect, it } from "vitest";
import { dayRange, detectSpike, OTHER, pivotDaily, spikeReport, type CostRow } from "../src/lib/costs.js";

const TODAY = new Date("2026-11-05T15:30:00Z");

describe("dayRange", () => {
  it("returns contiguous UTC days ending today", () => {
    expect(dayRange(TODAY, 3)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
  });
  it("crosses month boundaries", () => {
    expect(dayRange(new Date("2026-03-01T00:00:00Z"), 2)).toEqual(["2026-02-28", "2026-03-01"]);
  });
});

describe("detectSpike", () => {
  it("flags today above 2x the trailing 7-day mean", () => {
    const r = detectSpike([1, 1, 1, 1, 1, 1, 1, 2.5]);
    expect(r.trailingMean).toBe(1);
    expect(r.ratio).toBe(2.5);
    expect(r.flagged).toBe(true);
  });
  it("does not flag exactly 2x (strictly greater than)", () => {
    expect(detectSpike([1, 1, 1, 1, 1, 1, 1, 2]).flagged).toBe(false);
  });
  it("uses only the 7 days before today", () => {
    // An old 100 outside the window must not raise the mean.
    const r = detectSpike([100, 1, 1, 1, 1, 1, 1, 1, 3]);
    expect(r.trailingDays).toBe(7);
    expect(r.trailingMean).toBe(1);
    expect(r.flagged).toBe(true);
  });
  it("works with fewer trailing days than the window", () => {
    const r = detectSpike([2, 5]);
    expect(r.trailingDays).toBe(1);
    expect(r.flagged).toBe(true);
  });
  it("never flags with no history", () => {
    expect(detectSpike([50]).flagged).toBe(false);
    expect(detectSpike([]).flagged).toBe(false);
  });
  it("flags new spend after a zero baseline, respecting minUsd", () => {
    expect(detectSpike([0, 0, 0, 4]).flagged).toBe(true);
    expect(detectSpike([0, 0, 0, 4]).ratio).toBeNull();
    expect(detectSpike([0, 0, 0, 0.5], { minUsd: 1 }).flagged).toBe(false);
    expect(detectSpike([0, 0, 0, 0]).flagged).toBe(false);
  });
  it("supports a custom factor", () => {
    expect(detectSpike([10, 10, 16], { factor: 1.5 }).flagged).toBe(true);
  });
});

describe("pivotDaily", () => {
  const rows: CostRow[] = [
    { day: "2026-11-04", provider: "anthropic", costUsd: 3, quantity: 1 },
    { day: "2026-11-05", provider: "anthropic", costUsd: 5, quantity: 1 },
    { day: "2026-11-05", provider: "fal", costUsd: 1, quantity: 1 },
    { day: "2026-10-01", provider: "fal", costUsd: 99, quantity: 1 }, // outside range: ignored
  ];
  it("aligns series to a contiguous range filling gaps with 0", () => {
    const d = pivotDaily(rows, { days: 3, today: TODAY });
    expect(d.days).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(d.providers).toEqual(["anthropic", "fal"]);
    expect(d.series.anthropic).toEqual([0, 3, 5]);
    expect(d.series.fal).toEqual([0, 0, 1]);
    expect(d.totals).toEqual([0, 3, 6]);
    expect(d.providerTotals).toEqual({ anthropic: 8, fal: 1 });
  });
  it("folds the long tail into Other", () => {
    const many: CostRow[] = ["a", "b", "c", "d"].map((p, i) => ({ day: "2026-11-05", provider: p, costUsd: 10 - i, quantity: 1 }));
    const d = pivotDaily(many, { days: 1, today: TODAY, maxSeries: 3 });
    expect(d.providers).toEqual(["a", "b", OTHER]);
    expect(d.series[OTHER]).toEqual([7 + 8]);
    expect(d.totals).toEqual([34]);
  });
});

describe("spikeReport", () => {
  it("reports flagged providers ordered by today's spend", () => {
    const rows: CostRow[] = [];
    for (const day of dayRange(TODAY, 8).slice(0, 7)) {
      rows.push({ day, provider: "anthropic", costUsd: 10, quantity: 1 }, { day, provider: "fal", costUsd: 1, quantity: 1 });
    }
    rows.push({ day: "2026-11-05", provider: "anthropic", costUsd: 11, quantity: 1 }, { day: "2026-11-05", provider: "fal", costUsd: 9, quantity: 1 });
    const r = spikeReport(pivotDaily(rows, { days: 8, today: TODAY }));
    expect(r.total.flagged).toBe(false); // 20 vs mean 11
    expect(r.providers.map((p) => p.provider)).toEqual(["fal"]);
  });
});
