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
- [ ] W1-B templates + app-kit
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
- [ ] W3-C apps/web
- [ ] W3-D apps/admin
- [ ] W3-E apps/mobile

- [x] observability package — OTel tracing, Sentry adapter, health checks, cost spike/provider-down alerts

## Wave 4 — Verification (Definition of done §19)
- [ ] DoD1 docker compose up + one command starts platform
- [ ] DoD2 benchmark 20 prompts, >=16 succeed
- [x] DoD3 insecure app blocked by gates (packages/quality-gates fixtures, all 7 static gates block)
- [ ] DoD4 checkpoint restore restores code + DB data
- [x] DoD5 3 benchmark sites (packages/design int test; heuristic critic, 3D shown as poster headless) with 3D/scroll motion, visual QA >= 8, Lighthouse thresholds
- [ ] DoD6 cron user agent asks approval before sending, logs run + cost
- [ ] DoD7 two browsers edit same project live
- [x] DoD8 sandbox escape tests (packages/sandbox/test/escape.int.test.ts, real docker)
- [ ] DoD9 load test 50 concurrent builds
- [ ] DoD10 all tests pass + FINAL_REPORT.md

## Notes
- Railway deploy: docs/deploy/railway.md, railway.json (api), apps/agent-worker/railway.json; api image verified locally (/health ok)
- Wave 1 (W1-A..F), W3-C web, W3-D/E admin+mobile running as worktree subagents; merge each when its report arrives.
- Lead is building agent-core (W2-A) against its own ports so it does not block on wave 1.
