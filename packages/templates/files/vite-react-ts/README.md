# {{projectName}}

Single-page app built with Vite, React 19 and TypeScript. Scaffolded by Forge (`vite-react-ts`).

## Scripts

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `npm install`       | Install dependencies                                |
| `npm run dev`       | Dev server on http://localhost:5173                 |
| `npm run build`     | Production build into `dist/`                       |
| `npm run typecheck` | TypeScript, no emit                                 |
| `npm run lint`      | ESLint                                              |
| `npm test`          | Unit tests (Vitest + Testing Library)               |
| `npm run e2e`       | Playwright smoke test against a production preview  |

## Design tokens

All colours, fonts, spacing, radii and motion durations live in `src/styles/tokens.css` as CSS custom
properties. Components use only these variables, so the Forge design engine can restyle the project by
rewriting that one file.

## Accessibility

- `lang` on `<html>`, header/main/footer landmarks and a skip link.
- Visible `:focus-visible` outlines.
- `prefers-reduced-motion` disables CSS animation; use `useReducedMotion()` from `src/lib/motion.ts` for
  JS-driven motion.

## Deploy

`Dockerfile` builds the app and serves `dist/` from unprivileged nginx on port 8080 (health check
`/healthz`). It runs on any container host; Forge deploys to EU regions.

```sh
docker build -t {{projectSlug}} . && docker run -p 8080:8080 {{projectSlug}}
```
