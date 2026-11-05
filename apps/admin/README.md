# @forge/admin — internal admin

Next.js 16 (App Router, React 19, TypeScript strict) on port **3001**. Dense internal tool for Forge staff:
overview stats, user search, projects, provider cost dashboard with spike detection, provider health, and the
abuse queue with evidence view and takedown/dismiss. English only; every string lives in
[`src/lib/strings.ts`](src/lib/strings.ts).

## How it talks to the API

- tRPC v11 client (`@trpc/react-query` + `superjson`) with `import type { AppRouter } from "@forge/api"` — type-only,
  nothing from the API is bundled.
- Sign-in uses `auth.login`; the API sets its httpOnly `forge_session` cookie and the admin sends it with
  `credentials: "include"`. The token never touches admin JavaScript. **Admin and API must be same-site**
  (e.g. `admin.forge.dev` + `api.forge.dev`, or `localhost:3001` + `localhost:4000`); the API's CORS already
  allows `ADMIN_URL` (default `http://localhost:3001`).
- Every page uses `admin.*` procedures; the server enforces `users.is_admin`. Signed-in non-admins get an
  "Admins only" screen (and any `FORBIDDEN` from an `admin.*` call renders the same notice).

| Page | Procedures |
|------|-----------|
| `/` Overview | `admin.stats`, `admin.costs({days:8})`, `admin.providerHealth` |
| `/users` | `admin.users({q})` (email substring search, debounced via `useDeferredValue`) |
| `/projects` | `admin.projects({limit})` + client-side filter |
| `/costs` | `admin.costs({days})`: stacked daily cost by provider (SVG), spike check, per-provider totals |
| `/providers` | `admin.providerHealth`: latest status per provider, latency, failures/checks in 24h, red row when failing |
| `/abuse` | `admin.abuseQueue({status})`, `admin.resolveAbuse({reportId, action})` with confirm dialog |

## Charts and spike detection

- `src/lib/costs.ts` — `pivotDaily()` fills a contiguous UTC day range and folds providers beyond 8 into
  "Other"; `detectSpike()` flags **today > 2 × mean of the previous 7 days** (strictly greater; a zero baseline
  with new spend is flagged as "new spend"); `spikeReport()` runs it for the total and each provider.
- `src/lib/chart.ts` — `niceCeil`, `linearTicks`, `yScale`, `bandLayout`, `stackColumn`, `assignSlots` (colour
  follows the provider, never its rank), formatting helpers.
- `src/components/StackedBarChart.tsx` — plain SVG, `role="img"` with title/description, keyboard navigation
  (←/→/Home/End) with tooltip + live region, legend, and a "Show data table" view. Palette: the validated
  categorical reference palette (fixed order, separate light/dark steps); status colours are reserved for
  status and always paired with a label.

## Scripts

```bash
pnpm --filter @forge/admin dev         # http://localhost:3001 (NEXT_PUBLIC_API_URL, default http://localhost:4000)
pnpm --filter @forge/admin build
pnpm --filter @forge/admin typecheck   # next typegen && tsc --noEmit
pnpm --filter @forge/admin lint
pnpm --filter @forge/admin test        # vitest: costs, chart scaling, health, evidence helpers
pnpm --filter @forge/admin test:e2e    # Playwright smoke against a real API (docker stack must be up)
```

The e2e smoke (`test/e2e/smoke.ts`) starts the API on :4791 and the built admin on :3791, signs up an admin and
a regular user, seeds clearly-labelled rows (`provider = smoke-<id>`, abuse `source = smoke-test`), checks the
admins-only state, overview, cost spike + chart keyboard tooltip, failing provider, user search and a dismissal,
writes screenshots to `test-results/`, and deletes everything it created.

## Env

| Var | Default | Notes |
|-----|---------|-------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Inlined at build time |

## Limitations

- No user/project mutation actions (suspend, delete, promote) — the API exposes none on `admin.*` yet.
- Users/projects lists are capped at 200 rows with no pagination (API takes `limit` only).
- Provider health shows only providers with a check in the last 24 h (API behaviour).
- Costs come from `usage_records` grouped by provider and UTC day (Postgres server time zone).
