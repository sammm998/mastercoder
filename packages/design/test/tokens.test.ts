import { describe, expect, it } from "vitest";
import {
  DesignBriefSchema,
  curatedDirections,
  fluidClamp,
  fontLinksForTokens,
  googleFontsHref,
  googleFontsLinks,
  styleSuffixForMedia,
  tokensForSlides,
  tokensFromDirection,
  tokensToCss,
  tokensToJson,
  tokensToTailwind,
} from "../src/index.js";
import { BENCHMARK_BRIEFS } from "./briefs.js";

const direction = curatedDirections(DesignBriefSchema.parse(BENCHMARK_BRIEFS[2]!.brief))[0]!;
const tokens = tokensFromDirection(direction);

describe("tokens", () => {
  it("emits every contract CSS custom property", () => {
    const css = tokensToCss(tokens);
    const required = [
      "--color-bg", "--color-surface", "--color-text", "--color-muted", "--color-accent", "--color-accent-2", "--color-border",
      "--font-display", "--font-body", "--font-mono",
      ...[-1, 0, 1, 2, 3, 4, 5].map((s) => `--step-${s}`),
      ...Array.from({ length: 10 }, (_, i) => `--space-${i + 1}`),
      "--radius-1", "--radius-2", "--radius-3", "--ease", "--dur-fast", "--dur-base", "--dur-slow",
    ];
    for (const v of required) expect(css, v).toMatch(new RegExp(`\\s${v}:`));
    expect(css).toMatch(/--step-5: clamp\([\d.]+rem, [-\d.]+rem \+ [\d.]+vw, [\d.]+rem\)/);
    expect(css).toMatch(/@supports \(color: oklch\(0% 0 0\)\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*--dur-base: 0ms/);
  });

  it("builds fluid clamp() between 375 and 1440px", () => {
    expect(fluidClamp(16, 16)).toBe("1rem");
    const c = fluidClamp(40, 96);
    expect(c.startsWith("clamp(2.5rem")).toBe(true);
    expect(c.endsWith("6rem)")).toBe(true);
    // min <= max for every step, display steps shrink more than body
    for (const s of tokens.type) expect(s.minPx).toBeLessThanOrEqual(s.maxPx);
    const body = tokens.type.find((s) => s.step === 0)!, display = tokens.type.find((s) => s.step === 5)!;
    expect(display.maxPx / display.minPx).toBeGreaterThan(body.maxPx / body.minPx);
  });

  it("exports Tailwind preset, DTCG JSON and slide tokens", () => {
    const tw = tokensToTailwind(tokens) as { theme: { extend: { colors: Record<string, string>; fontSize: Record<string, string> } } };
    expect(tw.theme.extend.colors.accent).toBe("var(--color-accent)");
    expect(tw.theme.extend.colors["accent-2"]).toBe("var(--color-accent-2)");
    expect(tw.theme.extend.fontSize["step-5"]).toBe("var(--step-5)");
    const json = tokensToJson(tokens) as { color: Record<string, { $type: string; $value: string }>; motion: { ease: { $value: number[] } } };
    expect(json.color.bg!.$type).toBe("color");
    expect(json.color.bg!.$value).toBe(tokens.color.bg);
    expect(json.motion.ease.$value).toHaveLength(4);
    const slides = tokensForSlides(tokens);
    expect(slides.colors.bg).toMatch(/^[0-9A-F]{6}$/);
    expect(slides.fonts.heading).toBe(direction.typography.display.family);
  });

  it("writes a media style suffix with the palette", () => {
    const s = styleSuffixForMedia(direction);
    expect(s).toContain(direction.palette.accent);
    expect(s).toContain("no text, no logos");
  });

  it("builds Google Fonts css2 links (display=swap, non-blocking)", () => {
    const href = googleFontsHref(tokens.fonts)!;
    expect(href).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=/);
    expect(href).toContain("display=swap");
    expect(href).toContain(`family=${direction.typography.display.family.replace(/ /g, "+")}:wght@`);
    const italic = googleFontsHref([{ family: "Fraunces", weights: [700, 400], italic: true, fallback: "serif", category: "serif", source: "google", license: "OFL-1.1" }]);
    expect(italic).toContain("Fraunces:ital,wght@0,400;0,700;1,400;1,700");
    const links = googleFontsLinks(tokens.fonts);
    expect(links).toContain('rel="preconnect" href="https://fonts.gstatic.com" crossorigin');
    expect(links).toContain('media="print" onload="this.media=\'all\'"');
    expect(links).toContain("<noscript>");
    expect(fontLinksForTokens(tokens).href).toBe(href);
    expect(googleFontsHref([{ ...tokens.fonts[0]!, source: "system" }])).toBeNull();
  });
});
