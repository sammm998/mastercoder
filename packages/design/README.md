# @forge/design

Forge's design engine: everything Forge builds should look award-level, not like a template. This package
turns a brief into **art directions**, **design tokens**, a **motion/3D pattern library** (real React + TS
source), **complete Vite + React sites**, and **visual QA** (vision-LLM critic, browser-measured heuristic
critic, Lighthouse).

## Public API

### Art direction
| Function | Notes |
|---|---|
| `generateDirections(llm, brief, brand?)` | Exactly 3 distinct `ArtDirection`s. LLM purpose `design.directions` on `MODEL_PLANNER` via `structured()` + zod. Every direction is normalised: WCAG AA enforced by auto-adjusting OKLCH lightness, scales sorted, pill radii moved to `buttonRadius`, brand applied last. |
| `pickDirection(dirs, brief)` / `scoreDirections` | Scores fit from brief tags, requested features (`3d`, `horizontal scroll`...) and contrast headroom. |
| `curatedDirections(brief)` | The deterministic generator behind the mock: 12 archetypes × 16 OFL Google-font pairings × 7 motion languages × 6 grids × 5 spacing scales × 4 radius sets, OKLCH palettes. Picks best fit, a contrasting fit (other scheme + motion) and a wildcard (other motion + type category). |
| `applyBrand(direction, brand)` | Brand overrides the direction (accent/secondary/bg/text, fonts); colours only lightness-adjusted when needed for AA (noted in the rationale). |
| `generatePalette`, `enforcePalette`, `checkPalette`, `contrastRatio`, `ensureContrast`, `oklchToHex`, `hexToOklch`, `gamutMap` | Real OKLab/OKLCH colour science (Ottosson) + WCAG 2.x contrast. Text/bg ≥ 7, muted ≥ 4.5, accent/accent2 ≥ 3 (large text), on-accent ≥ 4.5. |

### Tokens
`tokensFromDirection(d)`, `tokensToCss(t)` (`--color-bg/surface/text/muted/accent/accent-2/border/on-accent`,
`--font-display/body/mono`, fluid `--step--1..--step-5` with `clamp()` between 375–1440px,
`--space-1..10`, `--radius-1..3`, `--radius-button`, `--ease`, `--dur-fast/base/slow`, grid vars, OKLCH
overrides under `@supports`, reduced-motion zeroes durations), `tokensToTailwind(t)` (preset),
`tokensToJson(t)` (W3C DTCG), `tokensForSlides(t)` (`RRGGBB` + font names + pt sizes for pptx),
`styleSuffixForMedia(d)` (prompt suffix for image/video), `googleFontsHref` / `googleFontsLinks`
(preconnect + non-blocking stylesheet + noscript).

### Brand import
`importBrand({ logo?, figma?, explicit? }, { figma? })` → `BrandInput` (priority explicit > Figma > logo).
`extractDominantColors(img, k)` (sharp + deterministic k-means++ in OKLab), `brandFromLogo`,
`figmaToBrand(file)` (colour + text styles resolved from the nodes that use them),
`createFigmaClient()` → `FigmaRestClient` (`GET /v1/files/:key`, `/v1/files/:key/styles`, `/v1/files/:key/nodes`) or `MockFigmaClient`.

### Pattern library
`patterns: PatternDef[]`, `getPattern(id)`, `bundlePatterns(ids)`. Sources are real files in
`patterns/<id>/` (typechecked by `tsconfig.patterns.json`, `jsx: react-jsx`) and read from disk:
`hero-3d` (R3F + drei + custom GLSL, React.lazy after load+idle, poster fallback, DPR clamp, hardware-WebGL
check), `sticky-story` (GSAP ScrollTrigger), `horizontal-scroll` (sticky stage + scrubbed pan, no pin
shifts), `split-text`, `magnetic-button`, `custom-cursor`, `parallax-layers`, `marquee` (pause control),
`image-distortion` (raw WebGL), `bento-grid`, `animated-counter`, `page-transition` (View Transitions +
fallback), `preloader` (non-blocking, session-cached), `smooth-scroll` (Lenis), `motion-reveal` (Motion
`m` + async features). All honour `prefers-reduced-motion`, animate transform/opacity only, use token CSS
variables, are keyboard accessible; unit tests assert guards + a11y attributes and run the patterns tsc.

### Site composer
`generateContent(llm, brief, sections)` (purpose `design.copy`, `MODEL_BUILDER`; mock = rule-based
copywriter using the brief's own words, stats only from facts stated in the brief),
`composeLanding({ brief, direction, sections?, content, options? })`,
`composePortfolio({ brief, direction, content })` → `Record<path, content>` for a Vite 8 + React 19 + TS
project (exact pinned versions, `index.html` with lang/meta/theme-color/font preconnect, `tokens.css`,
`base.css`, generative token-driven SVG art, patterns, content). Sections: `hero-3d`, `hero-type`,
`statement`, `features`, `story`, `horizontal`, `stats`, `marquee`, `cta`.

### Visual QA
| Function | Notes |
|---|---|
| `captureScreenshots(url, [375,768,1440], { outDir })` | Playwright full-page PNGs after a scroll pass + a scroll video (`recordVideo`) at the widest viewport. |
| `analyzePage(url)` | Heuristic critic measured in Chromium at 1440, 375 (touch) and 1440 + emulated reduced motion: text contrast of every text node vs composited background, spacing-on-scale, font families, heading order, CLS (PerformanceObserver), motion (CSS rules, running animations, ScrollTrigger/WebGL markers, layout-property animations, reduced-motion behaviour), overflow at 375px, tap targets (24px), image alt, rhythm, layout. Mapped to the same 1–10 criteria; `critic: "heuristic"`. |
| `visualQA(llm, shots, ctx)` | `design.critic` on `MODEL_VISION_REVIEW` with image blocks + the checklist (`src/qa/checklist.ts`). With the mock provider the handler maps `ctx.heuristics` and the result is labeled `critic: "heuristic"`. |
| `designQALoop({ build, threshold: 8, maxRounds: 3 })` | build(feedback) → evaluate → rebuild until ≥ threshold. |
| `runLighthouse(url, { preset })` | `lighthouse` + `chrome-launcher` with the preinstalled Chromium (`findChromium()`, `--headless=new --no-sandbox`) → performance / accessibility / bestPractices / seo + metrics. `LIGHTHOUSE_LIMITS = { performance: 85, accessibility: 90 }`. |
| `serveStatic(dir)` | Production-like static server (brotli/gzip, immutable assets, SPA fallback). |

## Providers
| Provider | Adapter | Real/mock | Env vars |
|---|---|---|---|
| LLM (directions, copy, critic) | via `@forge/llm` (`LLM_PROVIDER`) | real or mock | `MODEL_PLANNER`, `MODEL_BUILDER`, `MODEL_VISION_REVIEW` |
| Mock LLM handlers | `src/mock-llm.ts` (`design.directions`, `design.copy`, `design.critic`) | mock (rule-based, labeled) | – |
| Figma | `FigmaRestClient` (`figma`) | real (REST) | `FIGMA_PROVIDER=figma`, `FIGMA_TOKEN`, optional `FIGMA_API_URL` |
| Figma | `MockFigmaClient` (`mock`, default) | mock | – |
| Browser / Lighthouse | Playwright 1.63 Chromium, chrome-launcher | real, local | optional `CHROME_PATH`, `PLAYWRIGHT_BROWSERS_PATH` |

LLM costs are metered by wrapping the provider in `MeteredLLM` (prices from `@forge/llm` pricing table).
Figma REST calls are free (no `UsageRecord`). Lighthouse/Playwright run locally (no billable usage).

## New env vars
`FIGMA_PROVIDER` (`mock` | `figma`), `FIGMA_TOKEN`, `FIGMA_API_URL` (optional), `CHROME_PATH` (optional).

## Tests
- `pnpm --filter @forge/design test` — unit (no network): colour science, palettes, directions, brand
  (sharp logo, Figma with stubbed `fetch`), tokens, pattern guards/a11y + patterns `tsc`, composer, QA mapping, loop, static server.
- `pnpm --filter @forge/design test:integration` — DoD #5: 3 benchmark briefs (e-bike landing with 3D hero,
  architect portfolio with scroll storytelling, fintech launch with horizontal scroll + split text) are
  composed, `npm install` + `vite build` (tsc first), served, analysed by the heuristic critic (≥ 8) and
  Lighthouse mobile preset (performance ≥ 85, accessibility ≥ 90). Scores: `test/results/latest.json`.
  Needs npm registry access and the preinstalled Chromium.

## Limitations
- In headless Chromium (CI, Lighthouse) WebGL runs on SwiftShader; `supportsWebGL()` deliberately treats
  software rasterisers as "no GPU", so the 3D hero shows its static poster there, and phones (< 768px) also
  get the poster. The WebGL scene itself is typechecked and built, but not visually verified by the tests.
- The heuristic critic measures structure, not taste; real originality judgement needs the vision critic
  (`LLM_PROVIDER=anthropic`). Its contrast check skips text over background images/canvas (counted as
  `unknownBackground`).
- Session CLS in the heuristic includes shifts during the scripted scroll pass (stricter than Lighthouse's load CLS).
- Google Fonts are loaded from Google's CDN (non-blocking). For strict EU privacy, self-host the same OFL
  families (the composer does not yet emit `@fontsource` packages).
- Generated projects use `startTransition` for the first render (time-sliced, lower TBT) and are client-rendered (no SSG).
- The skill file `.claude/skills/add-design-pattern/SKILL.md` still describes the earlier "sources as
  strings in src/patterns/<id>.ts" layout; patterns now live as real files in `patterns/<id>/`.
