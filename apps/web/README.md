# @forge/web — Forge platform UI

Next.js 16 (App Router, React 19.3, webpack build — see ADR 0005), tRPC v11 + TanStack Query against
`@forge/api` (type-only import), Swedish + English.

## Run

```
docker compose up -d && pnpm db:migrate
pnpm --filter @forge/api dev                 # :4000
NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @forge/web dev   # :3000
```

Env: `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`), `WEB_PORT`. The API's `APP_URL` must point at
the web origin (invite/magic links, CORS). Cookies are `credentials: "include"`; web and API must share a
site (e.g. `app.forge.eu` + `api.forge.eu`, or localhost ports).

## Pages

`/` landing (WebGL "molten" hero, loaded on first interaction; static gradient otherwise / reduced motion),
`/login`, `/signup` (honeypot + `elapsedMs`), `/auth/magic`, `/invite`, `/legal/{terms,privacy,dpa}`,
`/app` dashboard (prompt box with voice, templates, projects, explore + remix), `/app/p/[id]` workspace
(chat with live events, cost estimate, clarify, plan approval, tool calls, gates, design scores,
checkpoints, summary with screenshots, attachments + Figma link, mic; preview 375/768/1440 with visual
edit and pinned comments; Monaco + file tree + terminal + diff; Yjs collaboration with named cursors and
presence; history/restore; media; slides editor; deploy), `/app/p/[id]/deploy`, `/app/agents` (+ detail,
approvals), `/app/meetings` (+ detail; bot invite, in-browser recording with resumable chunked upload),
`/app/integrations`, `/app/billing`, `/app/settings`.

Services that aren't wired on the API (PRECONDITION_FAILED "… not configured") render a clear notice.

## Security

Nonce-based CSP (`src/proxy.ts`), `frame-ancestors 'none'`, no third-party scripts, fonts self-hosted
from @fontsource, Monaco bundled locally, preview iframe sandboxed, postMessage origin checks,
open-redirect-safe `?next=`.

## Tests

- `pnpm --filter @forge/web test` — vitest: i18n completeness/parity, API client + error mapping, CSP,
  chunked upload (hashing, resume, retry), events/collab/deck/attachments/audio helpers.
- `pnpm --filter @forge/web test:e2e` — Playwright (`e2e/`): starts the API on :4410 (SMTP → Mailpit) and
  `next build && next start` on :3410 (`E2E_WEB_MODE=dev` for `next dev`). Specs: signup → dashboard →
  project; **two browsers co-edit one file live with presence** (two users joined via a real invite email);
  sv/en switch; axe (light + dark), keyboard, reduced motion. Needs Docker Postgres/Redis/Mailpit.

Lighthouse on `/` (prod build, local): mobile perf 90 / a11y 100 / BP 100 / SEO 100; desktop 100/100/100/100.
