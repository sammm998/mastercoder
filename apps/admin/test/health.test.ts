import { describe, expect, it } from "vitest";
import { failureRate, healthState, sortByHealth } from "../src/lib/health.js";

describe("provider health", () => {
  const rows = [
    { provider: "openai", ok: true, failures24h: 0, checks24h: 10 },
    { provider: "fal", ok: true, failures24h: 2, checks24h: 10 },
    { provider: "anthropic", ok: false, failures24h: 3, checks24h: 10 },
  ];
  it("classifies latest failure as failing and past failures as degraded", () => {
    expect(rows.map(healthState)).toEqual(["ok", "degraded", "failing"]);
  });
  it("sorts failing first", () => {
    expect(sortByHealth(rows).map((r) => r.provider)).toEqual(["anthropic", "fal", "openai"]);
  });
  it("computes failure rate safely", () => {
    expect(failureRate(rows[1]!)).toBe(0.2);
    expect(failureRate({ provider: "x", ok: true, failures24h: 0, checks24h: 0 })).toBe(0);
  });
});
