import { describe, expect, it } from "vitest";
import {
  checkPalette,
  contrastRatio,
  enforcePalette,
  ensureContrast,
  gamutMap,
  generatePalette,
  hexToOklch,
  inGamut,
  oklchToHex,
  palettePasses,
  parseColor,
  readableOn,
} from "../src/index.js";

describe("color science", () => {
  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1 AA threshold grey.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("round-trips hex <-> OKLCH", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#7a3cff", "#101418", "#f5efe6"]) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
    const red = hexToOklch("#ff0000");
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.h).toBeCloseTo(29.2, 0);
  });

  it("gamut-maps out-of-gamut OKLCH by reducing chroma", () => {
    const wild = { l: 0.7, c: 0.4, h: 150 };
    expect(inGamut(wild)).toBe(false);
    const mapped = gamutMap(wild);
    expect(inGamut(mapped)).toBe(true);
    expect(mapped.l).toBe(0.7);
    expect(mapped.c).toBeLessThan(0.4);
  });

  it("parses hex, rgb() and oklch()", () => {
    expect(parseColor("#FFF")).toBe("#ffffff");
    expect(parseColor("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(parseColor("oklch(62.8% 0.2577 29.23)")).toBe("#ff0000");
  });

  it("ensureContrast adjusts only lightness until the target is met", () => {
    const r = ensureContrast("#8899aa", "#ffffff", 4.5);
    expect(r.adjusted).toBe(true);
    expect(r.ratio).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(hexToOklch(r.hex).h - hexToOklch("#8899aa").h)).toBeLessThan(6);
    expect(ensureContrast("#000000", "#ffffff", 4.5).adjusted).toBe(false);
    expect(contrastRatio(readableOn("#3355ff"), "#3355ff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("palette generation", () => {
  it("passes WCAG AA for every hue, scheme and chroma", () => {
    for (const scheme of ["light", "dark"] as const)
      for (let hue = 0; hue < 360; hue += 30)
        for (const chroma of [0.05, 0.15, 0.3]) {
          const p = generatePalette({ hue, scheme, chroma, accentHue: hue + 40 });
          const failing = checkPalette(p).filter((c) => !c.pass);
          expect(failing, `${scheme} ${hue} ${chroma}`).toEqual([]);
          expect(contrastRatio(p.text, p.bg)).toBeGreaterThanOrEqual(7);
          expect(p.oklch.accent).toMatch(/^oklch\(/);
        }
  });

  it("enforcePalette repairs a failing palette", () => {
    const bad = { scheme: "light" as const, bg: "#ffffff", surface: "#f4f4f4", text: "#bbbbbb", muted: "#dddddd", accent: "#ffee00", accent2: "#aaffaa", border: "#eeeeee", onAccent: "#ffffff", oklch: {} };
    expect(palettePasses(bad)).toBe(false);
    expect(palettePasses(enforcePalette(bad))).toBe(true);
  });
});
