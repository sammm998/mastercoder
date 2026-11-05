# Forge

Type or speak a prompt — or invite Forge to a meeting — and get a finished, tested result: web apps, sites,
APIs, mobile apps, images, video, decks, documents and autonomous agents.

**Why Forge:** proven quality (every result is tested and shown working before delivery) · award-level
design · security by default (nothing deploys without passing gates) · fair pricing (estimate upfront, no
charge when the agent fails on its own errors) · no lock-in (standard code, GitHub export, Dockerfile) ·
EU data (EU storage, hosting and processing, GDPR built in).

## Quick start

```bash
docker compose up -d        # Postgres+pgvector, Redis, S3 (SeaweedFS), Mailpit
pnpm install
pnpm start:all              # migrations, buckets, then api :4000, worker, web :3000, admin :3001
```

Everything runs offline with mock providers by default (`.env.example`). Set real keys
(`LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`, `MEDIA_PROVIDER=fal` + `FAL_KEY`, …) to use real providers.

## Repository

| Path | What |
|---|---|
| `apps/web` | Platform UI (Next.js, sv/en) |
| `apps/admin` | Internal admin |
| `apps/mobile` | Expo app (chat, voice, meeting recording, previews) |
| `apps/api` | Fastify + tRPC + WebSocket gateway (events, Yjs collaboration, audio) |
| `apps/agent-worker` | BullMQ workers: builds, media, slides, transcription, meeting bots, agent runs, deploys, scans |
| `packages/*` | Domain packages — see `BUILD_PLAN.md` |
| `evals/` | 20-prompt benchmark, load test, sandbox escape tests, speech WER |

See `CLAUDE.md` (conventions), `BUILD_PLAN.md` (architecture + contracts), `PROGRESS.md` (status),
`docs/decisions/` (ADRs) and `FINAL_REPORT.md` (what works, real vs mocked providers, limitations).

## Tests

```bash
pnpm typecheck && pnpm lint && pnpm test   # unit tests (no network)
pnpm test:integration                      # needs the docker stack
```
