import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@forge/llm";
import {
  DesignBriefSchema,
  PATTERN_DEP_VERSIONS,
  TOOLCHAIN_VERSIONS,
  composeLanding,
  composePortfolio,
  curatedDirections,
  defaultSections,
  extractFacts,
  generateContent,
  mockCopy,
  pickDirection,
  projectSvg,
} from "../src/index.js";
import { BENCHMARK_BRIEFS } from "./briefs.js";

const [ebike, architect, fintech] = BENCHMARK_BRIEFS.map((b) => ({ ...b, parsed: DesignBriefSchema.parse(b.brief) }));

describe("copy", () => {
  it("extracts only facts stated in the brief", () => {
    expect(extractFacts("with 120 km range, 19 kg frame and 4 h charge.")).toEqual([
      { value: 120, suffix: " km", label: "range", decimals: 0 },
      { value: 19, suffix: " kg", label: "frame", decimals: 0 },
      { value: 4, suffix: " h", label: "charge", decimals: 0 },
    ]);
    expect(extractFacts("payouts to 38 countries, 0.4% FX fee and 99.95% uptime.").map((f) => [f.value, f.suffix, f.label])).toEqual([
      [38, "", "countries"],
      [0.4, "%", "FX fee"],
      [99.95, "%", "uptime"],
    ]);
    expect(extractFacts("Founded 2009 in Malmö.")).toEqual([]);
  });

  it("mock copywriter writes brief-specific copy (purpose design.copy)", async () => {
    const llm = new MockLLMProvider();
    const c = await generateContent(llm, ebike!.brief);
    expect(llm.calls[0]!.purpose).toBe("design.copy");
    expect(c.generatedBy).toMatch(/mock-copywriter/);
    expect(c.brand).toBe("Volta");
    expect(c.hero.lede).toContain("electric bikes");
    expect(c.stats.items.map((s) => s.value)).toEqual([120, 19, 4]);
    expect(c.features.items.length).toBeGreaterThanOrEqual(3);
    const portfolio = mockCopy(architect!.parsed);
    expect(portfolio.projects.length).toBeGreaterThanOrEqual(4);
    expect(new Set(portfolio.projects.map((p) => p.slug)).size).toBe(portfolio.projects.length);
    expect(mockCopy(fintech!.parsed).hero.headline).not.toBe(mockCopy(ebike!.parsed).hero.headline);
  });
});

describe("composeLanding", () => {
  const direction = pickDirection(curatedDirections(ebike!.parsed), ebike!.brief);
  const content = mockCopy(ebike!.parsed);
  const files = composeLanding({ brief: ebike!.brief, direction, content, sections: ["hero-3d", "statement", "features", "story", "stats", "marquee", "cta"] });

  it("produces a complete vite + react + ts project", () => {
    for (const f of ["package.json", "index.html", "vite.config.ts", "tsconfig.json", "src/main.tsx", "src/App.tsx", "src/content.ts", "src/styles/tokens.css", "src/styles/base.css", "public/favicon.svg", "public/robots.txt"]) {
      expect(files[f], f).toBeDefined();
    }
    expect(files["src/patterns/hero-3d/Hero3DScene.tsx"]).toBeDefined();
    expect(files["src/patterns/_shared/motion.ts"]).toBeDefined();
  });

  it("pins exact current versions", () => {
    const pkg = JSON.parse(files["package.json"]!) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
    for (const v of [...Object.values(pkg.dependencies), ...Object.values(pkg.devDependencies)]) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies.three).toBe(PATTERN_DEP_VERSIONS.three);
    expect(pkg.dependencies.gsap).toBe(PATTERN_DEP_VERSIONS.gsap);
    expect(pkg.devDependencies.vite).toBe(TOOLCHAIN_VERSIONS.vite);
    expect(pkg.devDependencies["@types/three"]).toBeDefined();
    expect(pkg.scripts.build).toBe("tsc --noEmit && vite build");
  });

  it("writes index.html with lang, meta and font preconnects", () => {
    const html = files["index.html"]!;
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
    expect(html).toMatch(/<meta name="description" content="Volta makes lightweight electric bikes/);
    expect(html).toContain('<link rel="preconnect" href="https://fonts.googleapis.com" />');
    expect(html).toContain(direction.typography.display.family.replace(/ /g, "+"));
    expect(html).toContain(`<meta name="theme-color" content="${direction.palette.bg}" />`);
  });

  it("uses the chosen patterns, tokens and real copy", () => {
    const app = files["src/App.tsx"]!;
    for (const name of ["Hero3D", "SplitText", "BentoGrid", "StickyStory", "CounterRow", "Marquee", "MagneticButton", "SmoothScrollProvider", "Reveal"]) expect(app).toContain(`<${name}`);
    expect(app).toContain('href="#main"');
    expect(files["src/content.ts"]).toContain("Volta makes lightweight electric bikes");
    expect(files["src/styles/tokens.css"]).toContain(`--color-bg: ${direction.palette.bg};`);
    const main = files["src/main.tsx"]!;
    expect(main).toContain('import "./patterns/hero-3d/styles.css";');
    expect(main).toContain("startTransition");
    expect(files["src/styles/base.css"]).not.toMatch(/#[0-9a-f]{6}\b/i);
  });

  it("derives default sections from brief features", () => {
    expect(defaultSections(ebike!.parsed, direction, content)[0]).toBe("hero-3d");
    const s = defaultSections(fintech!.parsed, direction, mockCopy(fintech!.parsed));
    expect(s).toContain("horizontal");
    expect(s).toContain("stats");
  });
});

describe("composePortfolio", () => {
  const direction = pickDirection(curatedDirections(architect!.parsed), architect!.brief);
  const content = mockCopy(architect!.parsed);
  const files = composePortfolio({ brief: architect!.brief, direction, content });

  it("tells the story through every project with case-study views", () => {
    const app = files["src/App.tsx"]!;
    expect(app).toContain("content.projects.map");
    expect(app).toContain("<DistortImage");
    expect(app).toContain("useHashRoute");
    expect(app).toContain("<Preloader");
    for (const p of content.projects) expect(files[`public/work/${p.slug}.svg`]).toMatch(/<svg[\s\S]*<title>/);
    expect(files["src/patterns/page-transition/PageTransition.tsx"]).toBeDefined();
  });

  it("requires projects", () => {
    expect(() => composePortfolio({ brief: architect!.brief, direction, content: { ...content, projects: [] } })).toThrow(/projects/);
  });

  it("renders project art in the palette's literal colours", () => {
    const svg = projectSvg(direction.palette, "A house", 0);
    expect(svg).toContain(direction.palette.accent);
    expect(svg).toContain('role="img"');
  });
});
