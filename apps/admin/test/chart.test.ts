import { describe, expect, it } from "vitest";
import { assignSlots, bandLayout, formatUsd, labelIndices, linearTicks, niceCeil, shortDay, stackColumn, yScale } from "../src/lib/chart.js";

describe("niceCeil", () => {
  it.each([
    [0, 1],
    [-5, 1],
    [1, 1],
    [1.1, 2],
    [2.2, 2.5],
    [3, 5],
    [7, 10],
    [0.03, 0.05],
    [0.3, 0.5],
    [120, 200],
    [0.1 + 0.2, 0.5],
  ])("niceCeil(%s) = %s", (v, expected) => expect(niceCeil(v)).toBe(expected));
});

describe("linearTicks", () => {
  it("produces 0-based evenly spaced ticks covering max", () => {
    expect(linearTicks(9.3, 4)).toEqual({ ticks: [0, 2.5, 5, 7.5, 10], max: 10 });
  });
  it("handles an empty chart", () => {
    const t = linearTicks(0, 4);
    expect(t.ticks[0]).toBe(0);
    expect(t.max).toBeGreaterThan(0);
  });
  it("max is always >= the data max", () => {
    for (const m of [0.004, 0.7, 13, 999, 12345.6]) {
      const t = linearTicks(m, 5);
      expect(t.max).toBeGreaterThanOrEqual(m);
      expect(t.ticks.length).toBeGreaterThanOrEqual(2);
      expect(t.ticks.length).toBeLessThanOrEqual(7);
    }
  });
});

describe("yScale", () => {
  it("maps 0 to the bottom and max to the top, clamping", () => {
    const y = yScale(10, 200);
    expect(y(0)).toBe(200);
    expect(y(10)).toBe(0);
    expect(y(5)).toBe(100);
    expect(y(20)).toBe(0);
    expect(y(-1)).toBe(200);
  });
});

describe("bandLayout", () => {
  it("divides width into bands with gaps", () => {
    const b = bandLayout(4, 406, 2);
    expect(b.bandwidth).toBe(100);
    expect(b.x(0)).toBe(0);
    expect(b.x(3)).toBe(306);
  });
  it("is empty for no bars", () => expect(bandLayout(0, 100).bandwidth).toBe(0));
});

describe("stackColumn", () => {
  it("stacks positive values in order and skips zeros", () => {
    const vals: Record<string, number> = { a: 2, b: 0, c: 3 };
    expect(stackColumn(["a", "b", "c"], (k) => vals[k] ?? 0)).toEqual([
      { key: "a", value: 2, y0: 0, y1: 2 },
      { key: "c", value: 3, y0: 2, y1: 5 },
    ]);
  });
});

describe("formatUsd", () => {
  it.each([
    [0, "$0"],
    [0.004, "<$0.01"],
    [0.42, "$0.42"],
    [1.25, "$1.3"],
    [12.4, "$12"],
    [1200, "$1.2k"],
    [3_400_000, "$3.4M"],
  ])("formatUsd(%s) = %s", (v, s) => expect(formatUsd(v)).toBe(s));
});

describe("assignSlots", () => {
  it("keeps preferred slots regardless of rank and fills the rest stably", () => {
    expect(assignSlots(["fal", "anthropic", "zeta", "acme", "Other"])).toEqual({ fal: 3, anthropic: 1, acme: 2, zeta: 4, Other: 0 });
  });
  it("a provider keeps its color when others disappear", () => {
    expect(assignSlots(["anthropic", "fal"]).fal).toBe(assignSlots(["fal"]).fal);
  });
});

describe("labels", () => {
  it("shortDay", () => expect(shortDay("2026-11-05")).toBe("Nov 5"));
  it("labelIndices keeps first and last and limits count", () => {
    expect(labelIndices(5, 10)).toEqual([0, 1, 2, 3, 4]);
    const idx = labelIndices(30, 6);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(29);
    expect(idx.length).toBeLessThanOrEqual(6);
  });
});
