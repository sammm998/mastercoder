# {{projectName}}

Full-stack web app on Next.js 16 (App Router), React 19 and TypeScript. Scaffolded by Forge (`nextjs`).

## Scripts

| Command             | What it does                                           |
| ------------------- | ------------------------------------------------------ |
| `npm install`       | Install dependencies                                   |
| `npm run dev`       | Dev server on http://localhost:3000                    |
| `npm run build`     | Production build (`output: "standalone"`)              |
| `npm run typecheck` | `next typegen` + TypeScript                            |
| `npm run lint`      | ESLint (`eslint-config-next`, core web vitals)         |
| `npm test`          | Unit tests (Vitest)                                    |
| `npm run e2e`       | Playwright smoke test against a production server      |

## Layout

- `src/app/` routes (App Router). `src/app/api/health` is the liveness probe.
- `src/styles/tokens.css` design tokens (CSS custom properties). The Forge design engine restyles the
  app by rewriting this file; components only use the variables.
- `src/kit/slots.tsx` extension point for Forge app-kit features (auth, analytics, consent, i18n ...).

## Accessibility

`lang` on `<html>`, header/main/footer landmarks, a skip link, visible focus styles and
`prefers-reduced-motion` support (CSS plus `useReducedMotion()` in `src/lib/motion.ts`).

## Deploy

The `Dockerfile` builds a standalone server that runs as a non-root user on port 3000 with a health
check on `/api/health`. Forge deploys it to EU regions.

```sh
docker build -t {{projectSlug}} . && docker run -p 3000:3000 {{projectSlug}}
```
