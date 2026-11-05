# @forge/templates

Starter projects the build agent scaffolds. Each template under `files/<id>/` is a complete, minimal,
working project: README, `.gitignore`, production `Dockerfile` (non-root, health check, EU-hostable on
any OCI host), a passing unit test, lint + typecheck scripts and a `forge.json` manifest.

| id              | kind    | stack                                                        | dev port → container port |
| --------------- | ------- | ------------------------------------------------------------ | ------------------------- |
| `vite-react-ts` | app     | Vite 8, React 19.3, Vitest + Testing Library, Playwright     | 5173 → 8080 (nginx)       |
| `nextjs`        | app     | Next.js 16 App Router, standalone output, Vitest, Playwright | 3000 → 3000               |
| `astro-site`    | website | Astro 7, @astrojs/sitemap, SEO layout, Vitest, Playwright    | 4321 → 8080 (nginx)       |
| `expo`          | mobile  | Expo SDK 58, expo-router, RN 0.88, Vitest logic tests, EAS   | 8081 → 8080 (web export)  |
| `fastapi`       | backend | FastAPI 0.162, pydantic 2, pytest, ruff, mypy (strict)       | 8000 → 8000               |
| `hono-api`      | backend | Hono 4 on Node, @hono/zod-validator + zod 4, Vitest          | 3000 → 3000               |

Web templates (`vite-react-ts`, `nextjs`, `astro-site`) take every visual value from `tokens.css`
(`--color-bg`, `--color-text`, `--color-accent`, `--font-display`, `--font-body`, `--space-*`,
`--radius-*`, `--ease`, `--dur-*`, plus `--color-surface/muted/border/accent-contrast`) so
`@forge/design` can restyle them by rewriting that file. They have `lang`, landmarks, a skip link,
`:focus-visible` styles, honour `prefers-reduced-motion`, and ship `playwright.config.ts` + one smoke
e2e. Expo uses `src/theme/tokens.ts` (the native equivalent) with a WCAG contrast test.

Each template also has an app-kit extension point (`src/kit/slots.tsx`, `src/kit/Head.astro`/`Body.astro`,
`src/kit/index.ts`, `app/kit/__init__.py`) that `@forge/app-kit` regenerates when features are added.

TypeScript is pinned to `~6.0.3` in templates: TS 7 is the latest npm tag, but `typescript-eslint`
(<6.1) and `@astrojs/check` (^5 || ^6) do not support it yet; Expo's own template also uses 6.0.

## Public API

```ts
TEMPLATE_IDS; type TemplateId
listTemplates(): ForgeManifest[]
getManifest(id): ForgeManifest                       // zod-validated forge.json
templateFiles(id, vars?): Promise<Record<path, content>>  // {{projectName}} / {{projectSlug}} substitution
templateFileList(id): Promise<string[]>
scaffold(id, writer: { writeFile(path, content) }, vars): Promise<{ manifest, files }>
selectTemplate(intentKind, hint?): TemplateId
localWriter(dir): FileWriter                         // fs writer that refuses path escapes
ForgeManifestSchema, CronSpecSchema, parseManifest, containerPortOf, slugify, substitute
```

`forge.json`: `{ id, name, kind: app|website|mobile|backend, language?, install, dev, build, test,
typecheck, lint, e2e?, port, containerPort?, publicRoutes, lighthouse, healthPath?, crons?, features? }`.

`selectTemplate`: explicit framework hints win (`nextjs`, `vite`, `astro`, `expo`/`react native`,
`python`/`fastapi`, `hono`) when they fit the platform; otherwise app → `nextjs` (`vite-react-ts` for
SPA/dashboard/internal-tool hints), website → `astro-site` (`vite-react-ts` for 3D/WebGL/scroll-driven/
motion-heavy hints), mobile → `expo`, backend/integration → `hono-api` (`fastapi` for Python hints).

CLI for humans: `pnpm --filter @forge/templates exec tsx src/cli.ts <id> <dir> "<Project Name>"`.

## Providers

None. This package only reads files from disk.

## Env vars

None.

## Tests

- `pnpm --filter @forge/templates test`: manifests validate, referenced files/scripts/Dockerfile COPY
  sources exist, tokens + a11y markers present, substitution, scaffold, `selectTemplate` mapping.
- `pnpm --filter @forge/templates test:integration` (network: npm + PyPI): scaffolds into temp dirs
  and runs install + typecheck + lint + test for `vite-react-ts`, `hono-api`, `nextjs` (+ build for vite
  and hono); `fastapi` with pip in a venv (pytest, mypy, ruff) when python3 is available; JSON/TS/Astro
  syntax validation for all others.

## Limitations

- Expo and Astro toolchains are not run in CI (syntax validation only); they were verified manually
  (install, typecheck, lint, test, `expo export --platform web`, `astro build`).
- Playwright smoke tests are shipped but not run by the integration test: `@playwright/test` 1.64 needs
  its own browser build. They pass locally with a Playwright version matching the installed browsers.
- No lockfiles are shipped; `npm install` resolves the caret ranges at scaffold time.
