# 0007 — Web visual redesign: Scoutr brand on a "pastel horizon"

**Decision:** the visible product brand in `apps/web` is **Scoutr** (the owner's brand; code and package
names stay Forge). The visual system combines Scoutr's playful pastel character (lilac/pink/sky palette,
mascot crew, rounded friendly UI) with a cosmoq-*style* structure (original work, no copied text or assets):
a glowing planet-horizon hero, glass cards with hairline borders, bento sections, a sticky-index section
and a realistic product mock in the hero.

- **Tokens only.** All colours are CSS variables in `src/styles/globals.css`; dark and light share one
  identity. The theme follows `prefers-color-scheme` until the visitor toggles it; the choice is stored in
  the existing `forge_theme` cookie so SSR renders `data-theme` without a flash. The toggle renders both
  icons and CSS shows the right one (no hydration mismatch).
- **No heavy media in the hero.** The aurora/planet is pure CSS (conic + radial gradients, masks, blur);
  the old WebGL ember field was removed. Scroll reveals use `animation-timeline: view()` (no JS) and are
  not applied at all under `prefers-reduced-motion`.
- **One font.** DM Sans (variable, self-hosted via @fontsource) for display and text; JetBrains Mono for
  code. Fraunces and Inter Tight were dropped.
- **Workspace = fixed viewport app.** `/app/p/*` is exactly `100dvh`; only the timeline, file tree,
  editor and preview scroll. The agent panel is resizable (pointer + keyboard separator, width kept in
  localStorage) and becomes a switchable pane on mobile.
- **Server text never leaks into the UI language.** Gate results, tool calls, phases, intents and
  `team.message` events render translated labels from structured fields (`src/lib/agent-run.ts`); raw
  server text appears only inside an expandable "Details/Detaljer" block. A unit test fails on hard-coded
  user-facing JSX strings (`test/hardcoded-strings.test.ts`).
- **`team.message` is validated locally** (zod in `agent-run.ts`) so the web app works before and after
  the shared event type lands.

**Trade-offs:** scroll-driven reveals only animate in browsers with `animation-timeline` (others show
content statically); the light/dark token blocks are duplicated for the media-query and explicit-choice
cases (CSS cannot share one block between a selector and a media query).
