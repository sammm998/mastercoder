# {{projectName}}

Content website on Astro 7 with TypeScript. Scaffolded by Forge (`astro-site`). Pages are static
HTML with zero JavaScript by default, which keeps Lighthouse scores high.

## Scripts

| Command             | What it does                                      |
| ------------------- | ------------------------------------------------- |
| `npm install`       | Install dependencies                              |
| `npm run dev`       | Dev server on http://localhost:4321               |
| `npm run build`     | Static build into `dist/` (+ sitemap)             |
| `npm run typecheck` | `astro check`                                     |
| `npm run lint`      | ESLint (+ eslint-plugin-astro)                    |
| `npm test`          | Unit tests (Vitest)                               |
| `npm run e2e`       | Playwright smoke test against a production preview |

## SEO

`src/layouts/Base.astro` renders title, description, canonical URL, Open Graph, Twitter card and
JSON-LD. `@astrojs/sitemap` writes `sitemap-index.xml`; `src/pages/robots.txt.ts` points to it. Set
`SITE_URL` to the public origin when building.

## Design tokens and accessibility

All visual values are CSS custom properties in `src/styles/tokens.css` (rewritten by the Forge design
engine). The layout has `lang`, landmarks, a skip link, focus styles and honours
`prefers-reduced-motion`.

## Deploy

`Dockerfile` builds the site and serves it from unprivileged nginx on port 8080 (`/healthz`).

```sh
docker build --build-arg SITE_URL=https://example.eu -t {{projectSlug}} . && docker run -p 8080:8080 {{projectSlug}}
```
