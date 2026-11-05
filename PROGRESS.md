# Forge — PROGRESS (source of truth)

Legend: [x] done · [ ] todo · [~] partial (see note). Resume from the first unchecked item.

## Wave 0 — Foundation
- [x] F1 repo tooling (pnpm, turbo, tsconfig strict, eslint vendor-import rule, prettier, vitest)
- [x] F2 docker-compose (pgvector, redis, SeaweedFS S3, mailpit), devcontainer, .env.example
- [x] F3 @forge/shared (env/adapters, ids, errors, events, usage, storage local+S3, logger) — unit + S3 int tests
- [x] F4 @forge/llm (Anthropic SDK/OpenAI/Mock, pricing, metering, structured, defineTool) — tests
- [x] F5 @forge/db (schema, migrations, pgvector) — int test
- [x] F6 CLAUDE.md, BUILD_PLAN.md, PROGRESS.md, .claude/, ADRs 0001-0003

## Wave 1 — Packages
- [x] W1-A sandbox + quality-gates — docker (hardened, internal net + egress proxy), e2b, daytona, local; 14 gates incl. built-in semgrep/gitleaks/osv fallbacks, RLS/auth/validation/client-secrets; insecure fixture blocked; 66+18 / 50+2 tests
- [x] W1-B templates + app-kit — 6 templates (forge.json, tokens.css, Dockerfile, tests), kit features (auth/db+RLS/storage/ai/payments/email/cron/seo/analytics/consent/i18n/cms/observability), Neon/pg-clone branching, Fly/local deploy, AI gateway, GitHub export, error ingest; 55+9 / 71 tests
- [x] W1-C design — 3 directions w/ contrast, tokens, brand import (logo/Figma), 15 patterns, composer, heuristic + vision critic, Lighthouse; 3/3 benchmark sites QA>=9.5, mobile perf 91-97, a11y 100; 83 tests
- [x] W1-D media + slides — fal/Replicate/mock, moderation (62 cases), Remotion (renders mp4), MediaJobService; decks/docs, PPTX/PDF/DOCX; 93+4 / 19 tests
- [x] W1-E speech + meetings — ElevenLabs/Deepgram/Whisper/mock STT, WER, Swedish Piper fixtures; Recall/MeetStream/Vexa/mock bots, consent, calendar, chunked upload, meeting→spec; 49 / 38+1 tests
- [x] W1-F integrations + billing + intent-router — Composio/Nango/Pipedream/mock, catalog 12 apps, OpenAPI import + typed client, SSRF guard, MCP, envelope vault; plans/pricing/estimates/no-charge-on-agent-error/spend caps/Stripe; sv+en classifier 100% on 93 prompts; 100+2 / 19+1 / 39 tests

## Wave 2 — Orchestration
- [~] W2-A agent-core — loop (plan/design/build/verify/review/finish), loop guard (8 iters, strategy change after 3 identical), model router, 20 tools, tree-sitter repo map, pgvector search, mock planner/reviewer; 14 tests. TODO: mock builder code generators (after templates merge)
- [x] W2-B agents-runtime — definitions, in-house + Claude Agent SDK runners, approvals, cost caps, AgentService (DB), evals, Slack/widget/email channels; 13 tests (DoD6 int test)

## Wave 3 — Apps
- [x] W3-A apps/api — auth (password, magic link, OIDC Google/MS), RBAC, projects/files/remix, tasks (classify→estimate→queue, clarify, plan approval), GDPR, events WS, Yjs collab WS (2-client test), domain routers via ports, hooks; 13 tests
- [~] W3-B apps/agent-worker — build job runner + settlement + persisted events/usage (2 int tests). TODO: BullMQ wiring of all queues + domain ports
- [x] W3-C apps/web — all §5 pages, chat/events, plan mode, preview + visual edit (packages/visual-edit), Monaco + Yjs collab, checkpoints, studio, agents, meetings, integrations, billing, settings, legal; sv/en; Lighthouse mobile 90/100; 60 unit + 9 e2e
- [x] W3-D apps/admin — stats, users, projects, cost chart + spike flag, provider health, abuse queue; 48 tests + e2e smoke
- [x] W3-E apps/mobile — Expo: chat + live events, voice streaming, meeting recording w/ resumable upload, previews/QR, sv/en; 56 tests, web export verified (native not device-tested)

- [x] observability package — OTel tracing, Sentry adapter, health checks, cost spike/provider-down alerts

## Wave 4 — Verification (Definition of done §19)
- [ ] DoD1 docker compose up + one command starts platform
- [~] DoD2 benchmark runner done; non-code cases 10-16 pass (7/7 + #14 fixed); code cases pending mock builder
- [x] DoD3 insecure app blocked by gates (packages/quality-gates fixtures, all 7 static gates block)
- [x] DoD4 checkpoint restore restores code + DB data (apps/agent-worker/test/checkpoint.int.test.ts)
- [x] DoD5 3 benchmark sites (packages/design int test; heuristic critic, 3D shown as poster headless) with 3D/scroll motion, visual QA >= 8, Lighthouse thresholds
- [x] DoD6 cron agent approval before send, run log + cost (agents-runtime int test + bench #15)
- [x] DoD7 two browsers edit same project live (apps/web/e2e/collab.spec.ts + api collab int tests)
- [x] DoD8 sandbox escape tests (packages/sandbox/test/escape.int.test.ts, real docker)
- [~] DoD9 load test: 50 concurrent tasks (light mix), 3 workers, 0 failures (evals/load). Code-build mix pending mock builder
- [ ] DoD10 all tests pass + FINAL_REPORT.md

## Notes
- Railway deploy: docs/deploy/railway.md, railway.json (api), apps/agent-worker/railway.json; api image verified locally (/health ok)
- Wave 1 (W1-A..F), W3-C web, W3-D/E admin+mobile running as worktree subagents; merge each when its report arrives.
- Lead is building agent-core (W2-A) against its own ports so it does not block on wave 1.

## Production hardening (Railway, real Claude) — 2026-11-05
- [x] Live preview while building (dev server starts as soon as a UI exists; node-based probe; worker image has curl, git, Chromium + libs)
- [x] Follow-up prompts keep project context (router, planner, builder); fresh sandboxes restored from saved files
- [x] Design proposals (3 directions as mock-ups, pick one to build) and multi-question clarifications with own answers
- [x] Per-project integrations, Composio v3.1 connect links; redesigned catalog
- [x] Cost: incremental prompt caching in tool loops, planner on Sonnet, browser gates that cannot run are skipped (not "fixed").
      Live test website build: 432 s, $0.87 model cost, preview after 79 s, all gates green (was $5.09).
