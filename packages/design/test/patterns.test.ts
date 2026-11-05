import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PATTERN_DEP_VERSIONS, PATTERN_IDS, bundlePatterns, getPattern, patterns } from "../src/index.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { devDependencies: Record<string, string> };

const REQUIRED = [
  "hero-3d", "sticky-story", "horizontal-scroll", "split-text", "magnetic-button", "custom-cursor", "parallax-layers", "marquee",
  "image-distortion", "bento-grid", "animated-counter", "page-transition", "preloader", "smooth-scroll", "motion-reveal",
];

/** Reduced-motion guard per pattern: a JS check and/or a CSS media query. */
const REDUCED_GUARD = /usePrefersReducedMotion\(|useReducedMotion\(|prefersReducedMotion\(|prefers-reduced-motion/;

/** a11y attributes/semantics each pattern must contain (regexes over its own sources). */
const A11Y: Record<string, RegExp[]> = {
  "hero-3d": [/aria-labelledby=/, /aria-hidden="true"/, /<h1/, /tabIndex=\{-1\}/],
  "sticky-story": [/aria-labelledby=/, /<ol/, /<article>/, /aria-current=/, /aria-hidden="true"/],
  "horizontal-scroll": [/aria-labelledby=/, /tabIndex=\{pinned \? undefined : 0\}/, /aria-label=/, /focusin/],
  "split-text": [/className="sr-only"/, /aria-hidden="true"/],
  "magnetic-button": [/<button ref=\{ref\} type="button"/, /<a ref=\{ref\} href=/, /:focus-visible/, /min-height: 3rem/],
  "custom-cursor": [/aria-hidden="true"/, /pointer-events: none/, /pointer: coarse/],
  "parallax-layers": [/aria-label=\{label\}/, /aria-hidden=/],
  marquee: [/aria-pressed=\{paused\}/, /aria-hidden=\{hidden \? "true" : undefined\}/, /aria-label=\{label\}/, /focus-within/],
  "image-distortion": [/alt=\{alt\}/, /width=\{width\}/, /height=\{height\}/, /setAttribute\("aria-hidden", "true"\)/],
  "bento-grid": [/role="list"/, /<article/, /aria-labelledby=/],
  "animated-counter": [/className="sr-only"/, /aria-hidden="true"/, /tabular-nums/],
  "page-transition": [/data-route-focus/, /\.focus\(/, /startViewTransition/],
  preloader: [/aria-hidden="true"/, /pointer-events: none/, /sessionStorage/],
  "smooth-scroll": [/focusTarget/, /tabindex/],
  "motion-reveal": [/data-motion="static"/],
};

describe("pattern library", () => {
  it("registers every required pattern with metadata", () => {
    expect(PATTERN_IDS.sort()).toEqual([...REQUIRED].sort());
    for (const p of patterns) {
      expect(p.name.length).toBeGreaterThan(3);
      expect(p.description.length).toBeGreaterThan(20);
      expect(p.a11y.length).toBeGreaterThan(0);
      expect(p.reducedMotion.length).toBeGreaterThan(10);
      expect(p.perfNotes.length).toBeGreaterThan(10);
      expect(Object.keys(p.files).some((f) => f.startsWith(`src/patterns/${p.id}/`) && f.endsWith(".tsx"))).toBe(true);
      expect(p.files["src/patterns/_shared/motion.ts"]).toBeDefined();
      expect(p.dependencies.react).toBe(PATTERN_DEP_VERSIONS.react);
    }
  });

  it("reads real source from disk (packages/design/patterns/<id>)", () => {
    const hero = getPattern("hero-3d");
    const onDisk = readFileSync(new URL("../patterns/hero-3d/Hero3D.tsx", import.meta.url), "utf8");
    expect(hero.files["src/patterns/hero-3d/Hero3D.tsx"]).toBe(onDisk);
    expect(hero.files["src/patterns/hero-3d/shaders.ts"]).toMatch(/gl_FragColor/);
    expect(hero.dependencies).toMatchObject({ three: "0.187.0", "@react-three/fiber": "9.8.2", "@react-three/drei": "10.7.9" });
  });

  it.each(REQUIRED)("%s honours prefers-reduced-motion", (id) => {
    const src = Object.entries(getPattern(id).files)
      .filter(([f]) => f.startsWith(`src/patterns/${id}/`))
      .map(([, c]) => c)
      .join("\n");
    expect(src).toMatch(REDUCED_GUARD);
  });

  it.each(REQUIRED)("%s has its a11y attributes", (id) => {
    const src = Object.entries(getPattern(id).files)
      .filter(([f]) => f.startsWith(`src/patterns/${id}/`) || (id === "smooth-scroll" && f.includes("_shared")))
      .map(([, c]) => c)
      .join("\n");
    for (const re of A11Y[id]!) expect(src, `${id}: ${re}`).toMatch(re);
  });

  it("animates only transform/opacity in CSS transitions and keyframes", () => {
    for (const p of patterns) {
      for (const [file, css] of Object.entries(p.files)) {
        if (!file.endsWith(".css")) continue;
        for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
          const props = m[1]!.split(",").map((part) => part.trim().split(/\s+/)[0]);
          for (const prop of props) expect(["transform", "opacity"], `${file}: ${m[0]}`).toContain(prop);
        }
        for (const kf of css.matchAll(/@keyframes[^{]+\{([\s\S]*?\})\s*\}/g)) {
          for (const decl of kf[1]!.matchAll(/([a-z-]+)\s*:/g)) expect(["transform", "opacity"], `${file} keyframes`).toContain(decl[1]);
        }
        expect(css, `${file} must not hardcode colours`).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
      }
    }
  });

  it("lazy-loads heavy dependencies (three, gsap, lenis) via dynamic import", () => {
    const src = (id: string) => Object.values(getPattern(id).files).join("\n");
    expect(src("hero-3d")).toMatch(/lazy\(\(\) => import\("\.\/Hero3DScene"\)\)/);
    expect(getPattern("hero-3d").files["src/patterns/hero-3d/Hero3D.tsx"]).not.toMatch(/from "three"|@react-three/);
    expect(getPattern("hero-3d").files["src/patterns/hero-3d/Hero3DScene.tsx"]).toMatch(/dpr=\{\[1, Math\.min\(dpr, MAX_DPR\)\]\}/);
    expect(src("hero-3d")).toMatch(/isLowPowerDevice\(\)/);
    expect(src("sticky-story")).toMatch(/import\("gsap\/ScrollTrigger"\)/);
    expect(src("sticky-story")).not.toMatch(/^import .* from "gsap/m);
    expect(src("horizontal-scroll")).toMatch(/import\("gsap"\)/);
    expect(src("smooth-scroll")).toMatch(/import\("lenis"\)/);
    expect(src("custom-cursor")).toMatch(/useCoarsePointer\(\)/);
    expect(src("page-transition")).toMatch(/typeof doc\.startViewTransition !== "function"/);
    expect(src("preloader")).toMatch(/alreadyShown\(\)/);
  });

  it("bundles patterns with deduplicated shared files and css", () => {
    const b = bundlePatterns(["marquee", "split-text", "marquee"]);
    expect(b.css).toEqual(["src/patterns/_shared/a11y.css", "src/patterns/marquee/styles.css", "src/patterns/split-text/styles.css"]);
    expect(Object.keys(b.dependencies).sort()).toEqual(["react", "react-dom"]);
  });

  it("pins runtime versions equal to this package's devDependencies", () => {
    for (const [name, version] of Object.entries(PATTERN_DEP_VERSIONS)) expect(pkg.devDependencies[name], name).toBe(version);
  });

  it("typechecks with tsc -p tsconfig.patterns.json", () => {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const out = execFileSync(process.execPath, [tsc, "-p", "tsconfig.patterns.json", "--pretty", "false"], { cwd: pkgDir, encoding: "utf8", timeout: 180_000 });
    expect(out).toBe("");
  }, 200_000);
});
