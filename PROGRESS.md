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
- [ ] W1-A sandbox + quality-gates
- [ ] W1-B templates + app-kit
- [ ] W1-C design
- [ ] W1-D media + slides
- [ ] W1-E speech + meetings
- [ ] W1-F integrations + billing + intent-router

## Wave 2 — Orchestration
- [ ] W2-A agent-core
- [ ] W2-B agents-runtime

## Wave 3 — Apps
- [ ] W3-A apps/api
- [ ] W3-B apps/agent-worker
- [ ] W3-C apps/web
- [ ] W3-D apps/admin
- [ ] W3-E apps/mobile

## Wave 4 — Verification (Definition of done §19)
- [ ] DoD1 docker compose up + one command starts platform
- [ ] DoD2 benchmark 20 prompts, >=16 succeed
- [ ] DoD3 insecure app blocked by gates
- [ ] DoD4 checkpoint restore restores code + DB data
- [ ] DoD5 3 benchmark sites with 3D/scroll motion, visual QA >= 8, Lighthouse thresholds
- [ ] DoD6 cron user agent asks approval before sending, logs run + cost
- [ ] DoD7 two browsers edit same project live
- [ ] DoD8 sandbox escape tests
- [ ] DoD9 load test 50 concurrent builds
- [ ] DoD10 all tests pass + FINAL_REPORT.md

## Notes
