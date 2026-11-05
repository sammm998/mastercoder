# Rules for package subagents

You build part of Forge inside a git worktree. Read `CLAUDE.md` and `BUILD_PLAN.md` (contracts) first and
skim `packages/shared/src` and `packages/llm/src` to reuse: `selectAdapter`, `ForgeEvent`/`EventSink`/`EventBus`,
`UsageSink`/`UsageRecord`/`MemoryUsageSink`, `CostEstimate`/`sumEstimate`, `ObjectStore`/`LocalObjectStore`,
`ForgeError`, `newId`, `createLogger`, `extractJson`; `LLMProvider`, `MockLLMProvider`, `registerMockHandler`,
`structured`, `defineTool`/`toToolDef`/`runTool`, `getModels`, `costFor`, `MeteredLLM`.

## Environment
- Run `pnpm install` at the worktree root first.
- Docker services already run on localhost: Postgres+pgvector :5432 (user/pass/db forge/forge/forge), Redis :6379,
  S3 (SeaweedFS) :9000 (forge/forgeforge, create buckets with `ensureBuckets` from `@forge/shared/src/adapters/s3.js`),
  Mailpit SMTP :1025 / UI :8025. Docker CLI works (`docker run ...`).
- Chromium + Playwright are preinstalled: `require('playwright')` works and `chromium.launch()` needs no options.
  Do NOT run `playwright install`. Chromium binary for other tools: look under `/opt/pw-browsers/` (pass --headless --no-sandbox).
- Outbound HTTPS goes through a proxy (HTTPS_PROXY env, CA at /root/.ccr/ca-bundle.crt). npm/pip work. Vendor APIs
  have no keys here: never call them for real; unit-test adapters with a stubbed `fetch` (`vi.stubGlobal`) or `vi.mock`.

## Rules
- Only create/modify files inside your assigned package directories (and any extra dirs your brief names).
  Do NOT edit `packages/shared`, `packages/llm`, `packages/db`, root configs, `.env*`. If you need a change there,
  implement it locally in your package and list it in your final report.
- Create a package with `scripts/new-package.sh <name> "<description>"`; add deps to that package.json
  (`"@forge/shared": "workspace:*"`, etc.) and run `pnpm install` at the root.
- TypeScript strict, ESM, relative imports end in `.js`, zod for all external input.
- Vendor SDKs only under `src/adapters/` (ESLint enforces). Every provider = interface + >=1 real adapter
  (official SDK or `fetch` against the vendor's documented REST API; EU endpoints when available) + adapter named
  `mock` (class name starts with `Mock`), selected via `selectAdapter("<X>_PROVIDER", {...}, "mock")`.
- Mocks are deterministic and clearly labeled. They may do real local work (e.g. render a PNG with sharp) but never
  pretend to be the vendor. Never fake an implementation: no TODO stubs, no hardcoded demo data presented as real.
- If your package calls an LLM, register rule-based handlers for each `purpose` you use in `src/mock-llm.ts`
  (`registerMockHandler`) and import it from `src/index.ts`, so `LLM_PROVIDER=mock` works end-to-end.
- Every billable call records a `UsageRecord` with a real `costUsd` (cite the price source in a comment).
- Tests: unit `test/*.test.ts` (no network, no docker); integration `test/*.int.test.ts` with
  `vitest.integration.config.ts` + `vitest.config.ts` copied from `packages/db`, and a `test:integration` script.
- Must be green for each of your packages: `pnpm --filter @forge/<pkg> typecheck`, `... lint`, `... test`
  (and `... test:integration` if present).
- Write `packages/<pkg>/README.md`: purpose, public API, Providers table (adapter | real/mock | env vars), new env vars,
  limitations.
- A PostToolUse hook typechecks/lints after edits; errors from half-finished multi-file work are expected mid-change.
- Commit in your worktree with conventional commits (`git add` only your dirs + `pnpm-lock.yaml`). Do NOT push.
  End each commit message with the line: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Final report (concise): what you built, public API, test counts, real vs mock, limitations, needed changes elsewhere.
