import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/theme/contrast";
import { colorsFor, palette } from "../src/theme/tokens";

describe("theme tokens", () => {
  it("meet WCAG AA contrast for body text and buttons in both schemes", () => {
    for (const scheme of ["light", "dark"] as const) {
      const c = palette[scheme];
      expect(contrastRatio(c.text, c.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.muted, c.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.accentContrast, c.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("falls back to light colours for unknown schemes", () => {
    expect(colorsFor(null)).toBe(palette.light);
    expect(colorsFor("dark")).toBe(palette.dark);
  });

  it("computes contrast like WCAG", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(() => contrastRatio("red", "#fff")).toThrow();
  });
});
