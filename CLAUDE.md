# Forge — CLAUDE.md

Forge turns a typed/spoken/meeting prompt into a finished, tested result: web/mobile apps, sites, APIs,
images, video, decks, documents and autonomous agents. Source of truth for progress: `PROGRESS.md`.
Task graph: `BUILD_PLAN.md`. Decisions: `docs/decisions/`.

## Resume protocol
After compaction or a new session: re-read CLAUDE.md, BUILD_PLAN.md, PROGRESS.md; continue from the
first unchecked task in PROGRESS.md. Never redo checked work. Commit after every task (conventional commits).

## Layout (pnpm workspaces + Turborepo, TypeScript strict)
- `apps/web` Next.js platform UI (sv + en) · `apps/admin` internal admin · `apps/mobile` Expo
- `apps/api` Fastify + tRPC + WebSocket gateway (events, Yjs) · `apps/agent-worker` BullMQ workers
- `packages/shared` types, zod schemas, events, env/adapter selection, storage, logger
- `packages/llm` LLM provider interface, Anthropic/OpenAI/Mock adapters, pricing, metering
- `packages/db` Drizzle schema + migrations (Postgres + pgvector)
- `packages/intent-router` · `agent-core` · `design` · `media` · `slides` · `agents-runtime`
- `packages/speech` · `meetings` · `integrations` · `app-kit` · `sandbox` · `quality-gates` · `billing` · `templates`
- `evals/` benchmark (20 prompts), load test, sandbox escape tests, speech WER

## Commands
```
docker compose up -d          # postgres+pgvector, redis, s3 (SeaweedFS), mailpit
pnpm install && pnpm db:migrate
pnpm start:all                # api + worker + web + admin (scripts/start.sh)
pnpm typecheck | pnpm lint | pnpm test | pnpm test:integration
pnpm bench                    # evals/benchmark (mock providers unless keys set)
```
Per package: `pnpm --filter @forge/<pkg> test`.

## Conventions
- Packages are TS source (`main: src/index.ts`), consumed directly (tsx / Next transpilePackages). No build step.
- ESM everywhere; relative imports use `.js` suffix.
- Every external provider is an interface with >=1 real adapter and an adapter named `mock`, selected by env
  via `selectAdapter(ENV, {...}, default)`. Vendor SDKs are imported only under `src/adapters/` (ESLint enforces).
- Mock LLM: register deterministic handlers per call `purpose` in a file named `mock-llm.ts`. Mocks are
  rule-based and clearly labeled; never present mock output as model output.
- All external input validated with zod. Secrets only via env; never log secrets (`redact()`).
- Models come from env: MODEL_PLANNER / MODEL_BUILDER / MODEL_FAST / MODEL_VISION_REVIEW (`getModels()`).
- Every LLM/media/sandbox call is metered into a `UsageSink` with `costUsd`.
- Unit tests: `test/*.test.ts` (no network, no docker). Integration: `test/*.int.test.ts` (docker stack).
- Never fake an implementation: no TODO stubs, no hardcoded demo data presented as real.
- UI strings go through i18n (`apps/web/messages/{en,sv}.json`).
- Open design choice → simplest robust option + short ADR in `docs/decisions/NNNN-title.md`.

## Ask the human before
Spending money on real accounts, sending real email/messages, publishing to a real domain, deleting data.

## Done checklist (per task)
1. `pnpm --filter <pkg> typecheck && lint && test` green
2. Integration tests green if the package touches docker services
3. PROGRESS.md box checked with a one-line note
4. Conventional commit pushed
