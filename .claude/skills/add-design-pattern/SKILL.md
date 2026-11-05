---
name: add-design-pattern
description: Add an award-level motion/3D pattern (tested, responsive, accessible, reduced-motion aware) to the packages/design pattern library.
---
1. Create `packages/design/src/patterns/<id>.ts` exporting a `PatternDef` with source files as strings (React + TS).
2. Requirements: honours `prefers-reduced-motion`; no layout shift (reserve space, animate transform/opacity only);
   keyboard accessible; lazy-loads heavy deps (three, gsap) via dynamic import; low-power fallback for WebGL.
3. Use tokens via CSS variables (`var(--color-accent)`), never hardcoded colours.
4. Register in `src/patterns/index.ts`; add tests asserting the reduced-motion guard and a11y attributes exist.
5. Never copy a specific existing site; describe the inspiration category only.
