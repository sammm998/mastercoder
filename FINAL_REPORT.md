# Forge — Final report

Forge is one platform where a user types or speaks a prompt, or invites Forge to a meeting, and gets a finished,
tested result. Outputs are web/mobile apps, sites, APIs, images, video, decks, documents and autonomous agents.
This report lists what works, how to run it, which providers are real vs mocked, costs, and known limitations.

> **Read this first.** No vendor API keys were available while building. Every vendor adapter (Anthropic,
> fal.ai, Replicate, ElevenLabs, Deepgram, Recall.ai, MeetStream, Vexa, Composio, Nango, Pipedream, Stripe,
> E2B, Daytona, Neon, Fly, GitHub, Figma, Sentry) is real code against the vendor's documented API. Each one is
> tested only against stubbed HTTP, never against the live service.
> All end-to-end runs (benchmark, load test) use the clearly labelled **mock** adapters. The mock LLM is a
> **rule-based, template-driven generator**, not a language model. The benchmark therefore proves the pipeline:
> classification → plan → design → scaffold → generate → real quality gates → checkpoints/artifacts/agents.
> It does not prove model quality. Set real keys to run the same benchmark against real models
> (`LLM_PROVIDER=anthropic pnpm bench`).

## How to run

```bash
docker compose up -d        # Postgres 17 + pgvector, Redis 7, SeaweedFS (S3), Mailpit
pnpm install
pnpm start:all              # migrations + buckets, then api :4000, worker, web :3000, admin :3001
```

```bash
pnpm typecheck && pnpm lint && pnpm test   # unit tests, no network
pnpm test:integration                      # needs the docker stack
pnpm bench                                 # 20-prompt benchmark → evals/results/latest.md
pnpm load-test                             # 50 concurrent tasks
```

Railway: `docs/deploy/railway.md`. Config-as-code files are `railway.json`, `apps/agent-worker/railway.json`
and `apps/web/railway.json`; the Dockerfiles are in `infra/docker/`.

## Definition of done (§19)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `docker compose up` + one command starts everything | ✅ | `scripts/start.sh` (`pnpm start:all`) |
| 2 | 20-prompt benchmark, ≥16 succeed with no manual fixes | see below | `evals/bench`, `evals/results/latest.md` |
| 3 | Deliberately insecure app blocked by gates | ✅ | `packages/quality-gates/test` (insecure fixture blocked on all 7 static gates, secure fixture passes) |
| 4 | Restoring a checkpoint restores code **and** DB data | ✅ | `apps/agent-worker/test/checkpoint.int.test.ts` (git + sandbox snapshot + Postgres branch) |
| 5 | 3 sites with 3D/scroll motion, visual QA ≥ 8, Lighthouse thresholds | ✅* | `packages/design/test/results/latest.json`: QA 9.5/9.8/9.7, mobile perf 97/91/97, a11y 100 |
| 6 | Cron agent asks approval before sending, logs run + cost | ✅ | `packages/agents-runtime/test/service.int.test.ts`, bench #15 |
| 7 | Two browsers edit the same project live | ✅ | `apps/web/e2e/collab.spec.ts` (two contexts, Yjs + presence), `apps/api/test/collab.int.test.ts` |
| 8 | Sandbox escape tests | ✅ | `packages/sandbox/test/escape.int.test.ts` (no cross-project, metadata, host-service or direct internet access) |
| 9 | 50 concurrent build tasks, no worker failures | ✅ | `evals/load`: 50 tasks, 3 worker processes, 0 failures (light mix) |
| 10 | All tests pass + this report | ✅ | `pnpm turbo run typecheck lint test` green; integration suites green |

\* The visual-QA scores come from the **heuristic critic**: browser-measured contrast, spacing, heading order,
CLS, motion, overflow and tap targets, mapped to the 1–10 criteria. With `MODEL_VISION_REVIEW` and a real key the
vision critic is used instead. Headless Chromium has no GPU, so the 3D hero's static poster is what gets scored.

## Benchmark

BENCH_RESULTS

## What works (by area)

- **Platform API** (`apps/api`):
  - Fastify + tRPC with platform auth: scrypt passwords, magic links, Google/Microsoft OIDC + PKCE, SSO-ready.
  - Workspaces with owner/admin/editor/viewer roles, invites, audit log, rate limits (per user, per IP and on credentials), bot protection.
  - Projects with files, public sharing and remix.
  - Tasks: classify → estimate → spend-cap check → queue, with one clarifying question when needed and plan-mode approval.
  - GDPR: export, account deletion, retention policies.
  - WebSockets for the event stream, Yjs collaboration and streaming voice.
  - Routers for media, slides, agents, meetings, integrations, deploy, billing and admin.
  - Webhooks, an agent REST channel and resumable uploads.
- **Worker** (`apps/agent-worker`): BullMQ queues for build, media, slides, transcription, meeting bots, agent
  runs, deploys and abuse scans. Also cron schedulers, task settlement (no charge on agent error), OTel spans
  and the provider-health/cost-spike monitor.
- **Build agent** (`packages/agent-core`):
  - PLAN → DESIGN → BUILD → VERIFY → REVIEW → FINISH.
  - Loop guard: at most 8 fix iterations; after 3 identical errors it changes strategy (re-read files → search docs → re-plan); if still failing it stops and the task is not charged.
  - Model router, 20 tools, a Tree-sitter repo map and pgvector semantic search.
  - Offline mock builder generating Next.js + Better Auth + Drizzle RLS apps, Vite SPAs, Hono and FastAPI services, Expo apps and OpenAPI clients that pass the real gates.
- **Design engine** (`packages/design`): three art directions with enforced WCAG contrast, tokens (CSS, Tailwind,
  JSON, slides, media), brand import (logo/Figma), 15 motion/3D patterns, a site composer, heuristic and vision
  critics, Lighthouse.
- **Quality gates** (`packages/quality-gates`): typecheck, lint, unit, integration, e2e, semgrep/gitleaks/osv
  (real tools when installed, built-in scanners otherwise), RLS, auth, validation, client secrets, Lighthouse and
  visual QA. Every failing gate comes with a proposed fix.
- **Sandbox** (`packages/sandbox`):
  - Hardened Docker containers, one per project, on internal networks.
  - Egress only through an allowlist proxy, with DNS checks and private/metadata ranges blocked.
  - E2B and Daytona adapters for microVMs; a local adapter for tests.
- **Media** (`packages/media`): fal.ai, Replicate and mock providers; moderation before any model call (62
  cases); brand-consistent image sets; logos with favicons; Remotion compositions that render real MP4s.
- **Slides & documents** (`packages/slides`): deck/doc JSON, HTML renderer and editor operations, PPTX
  (native charts, notes), PDF, DOCX.
- **Agents** (`packages/agents-runtime`): prompt → definition; Claude Agent SDK runner and in-house runner;
  approvals for irreversible actions; per-run and monthly caps; evals (dry-run); cron, webhook, email and chat
  triggers; Slack, widget, email and REST channels.
- **Speech & meetings**:
  - Speech-to-text: ElevenLabs Scribe, Deepgram and self-hosted Whisper/KB-Whisper adapters; WER/CER.
  - Swedish fixture audio synthesised with Piper (CC0 voice).
  - Meeting bots: Recall.ai, MeetStream and Vexa, with consent notices and stop detection.
  - Calendar sync, resumable chunked recording upload, and a meeting → requirements → spec → build pipeline.
- **Integrations** (`packages/integrations`):
  - Composio, Nango and Pipedream connectors; a 12-app catalog with sv/en scope descriptions.
  - OpenAPI import → tools plus a typed client; SSRF-guarded fetch; MCP (stdio + HTTP).
  - Envelope-encrypted vault (AES-256-GCM, KMS-ready).
- **Billing** (`packages/billing`): plans, user-facing pricing, upfront estimates, settlement policy (no charge
  on agent/provider failure, capped at the quote), spend caps per user/workspace/agent, Stripe meter events.
- **App kit** (`packages/app-kit`):
  - Auth, database + RLS, storage, AI gateway, payments, email, cron, SEO, analytics, cookie consent, i18n, CMS and observability for generated apps.
  - Neon and pg-clone database branching; Fly and local deploys with rollback; GitHub export; error ingest → suggested fix.
- **Web app** (`apps/web`): every §5 page, sv/en; chat with live events; plan mode; preview with device
  sizes and a visual edit overlay (`packages/visual-edit`, AST edits, no LLM call); Monaco + Yjs; checkpoints;
  studio; agents; meetings; integrations; billing; settings; legal pages. Lighthouse mobile 90 / a11y 100.
- **Admin** (`apps/admin`): stats, users, projects, a cost chart with spike flags, provider health, abuse queue.
- **Mobile** (`apps/mobile`): Expo chat, voice streaming, meeting recording with resumable upload, previews/QR.
  Only verified as a web export; not tested on a device.
- **Abuse** (`packages/abuse`): phishing, impersonation, credential-harvesting and malware scanner, a Safe
  Browsing adapter, reports and auto-takedown.
- **Observability** (`packages/observability`): OTel tracing per agent run, a Sentry adapter, health checks, alerts.

## Providers: real vs mock

| Area | Real adapters (code, stub-tested) | Mock (used in runs) | Env |
|---|---|---|---|
| LLM | Anthropic (official SDK; adaptive thinking, prompt caching, server fallbacks), OpenAI | rule-based purpose handlers | `LLM_PROVIDER` |
| Agent runner | Claude Agent SDK | in-house loop + mock LLM | `AGENT_RUNNER` |
| Sandbox | Docker (**exercised for real**), E2B, Daytona | local (no isolation) | `SANDBOX_PROVIDER` |
| Media | fal.ai, Replicate; Remotion (**renders for real**) | sharp/ffmpeg local renders tagged MOCK | `MEDIA_PROVIDER` |
| Speech-to-text | ElevenLabs Scribe, Deepgram, Whisper/KB-Whisper | sha256 fixture registry | `STT_PROVIDER` |
| Meeting bots / calendar | Recall.ai, MeetStream, Vexa / Google, Microsoft | simulated lifecycle | `MEETING_BOT_PROVIDER`, `CALENDAR_PROVIDER` |
| Connectors | Composio, Nango, Pipedream | in-memory apps (results flagged `mock`) | `CONNECTOR_PROVIDER` |
| Billing | Stripe | in-memory ledger | `BILLING_PROVIDER` |
| DB branching | Neon; pg-clone (**exercised for real**) | mock | `DB_BRANCH_PROVIDER` |
| Deploy | Fly Machines; local Docker (**exercised for real**) | mock | `DEPLOY_PROVIDER` |
| Storage / email | S3 (SeaweedFS **real**), SMTP (Mailpit **real**) | local fs, in-memory | `STORAGE_PROVIDER`, `EMAIL_PROVIDER` |
| Vault keys | local master key, AWS KMS | ephemeral | `VAULT_KEY_PROVIDER` |
| Embeddings | OpenAI | hashing embedder (real algorithm, lexical) | `EMBEDDING_PROVIDER` |
| Errors / URL reputation | Sentry / Google Safe Browsing | in-memory / blocklist | `SENTRY_DSN`, `SAFE_BROWSING_API_KEY` |

## Costs

Benchmark provider cost is in `evals/results/latest.md`. With mock providers it is computed from list prices
applied to the estimated token, image and second counts, so it tracks what the same run would cost but no money
was spent. Price tables, each with its source, are in `packages/llm/src/pricing.ts`,
`packages/media/src/pricing.ts`, `packages/speech/src/pricing.ts`, `packages/meetings/src/pricing.ts`,
`packages/sandbox` metering and `packages/billing/src/pricing.ts`. The fal/Replicate and MeetStream prices could not
be re-checked against vendor pages from the build environment and must be verified before billing on them.

**Remotion license:** free for individuals, companies with up to 3 employees and non-profits. Any larger
company needs a Remotion company license (`REMOTION_LICENSE_KEY`); see `packages/media/README.md`.

## Known limitations

- **Mock LLM.** It implements only the spec's data model (CRUD plus a few domain rules) and does not act on
  free-text follow-ups or design critique beyond contrast tweaks. Real-model quality is unmeasured.
- **Isolation.** The Docker sandbox shares the host kernel (no gVisor) and has no disk quota; production should
  use E2B or Daytona microVMs. Railway has no Docker daemon, so builds on Railway need E2B or Daytona.
- **Sandbox and app databases.** Isolated sandboxes cannot reach the platform Postgres by design, so generated
  apps' DB migrations run only where the app DB is reachable (Neon in production). The gates (typecheck, lint,
  unit, RLS/auth/validation static analysis) do not need it.
- **OSV dependency audit.** It is skipped when the OSV API is unreachable; it is never reported as passed.
- **Untested surfaces.**
  - Native mobile (microphone streaming, background recording, SecureStore) is not device-tested.
  - The 3D WebGL scene is never rendered in headless tests.
  - The e2e and Lighthouse gates need a browser in the sandbox image.
- **Vendor guesses.** MeetStream's chat/audio/transcript endpoints and Vexa's chat endpoint are assumptions from
  public docs; they are marked in the code.
- **Admin, MCP and mock connectors.**
  - Admin has no pagination and no mutations beyond abuse resolution.
  - MCP tools are available to the build agent and API but not yet to scheduled user agents.
  - The mock connector keeps per-process state; the worker re-creates mock connections it doesn't know.
- **Docker images.** They are large: api about 2.5 GB, web about 3.8 GB, because the monorepo is installed with tsx
  instead of being bundled.
