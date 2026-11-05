# @forge/app-kit

What every generated app gets, plus the platform services that build, ship and watch it.

1. **Kit files**: real source files copied into generated projects (`kit/`), wired through each
   template's kit slot and merged into its `package.json` / `requirements.txt` / `.env.example` /
   `forge.json`.
2. **Platform services** (TypeScript, used by the agent and the API): database branching, deploy
   providers, the Forge AI gateway handler, GitHub export, production error ingest with
   approval-gated fix suggestions, and Expo/EAS helpers.

## Kit features

`kitFilesFor(templateId, features, opts?) → Record<path, content>` (sync). Required features are added
automatically (`auth` → `db` + `email`, `cms` → `auth` + `db` + `email`). Unsupported combinations throw
`ForgeError("BAD_INPUT")`. `applyKit(templateId, features, io)` merges into an existing project;
`scaffoldWithKit(templateId, dir, vars, features)` does template + kit in one go.

| Feature          | nextjs | hono-api | vite-react-ts | astro-site | expo | fastapi | What it is                                                                                 |
| ---------------- | :----: | :------: | :-----------: | :--------: | :--: | :-----: | ------------------------------------------------------------------------------------------ |
| `auth`           |   ✓    |    ✓     |               |            |      |         | Better Auth 1.7: email+password, magic link, Google, Microsoft (Entra); sign-in page (next) |
| `db`             |   ✓    |    ✓     |               |            |      |         | Drizzle + postgres.js, `drizzle/` migrations, RLS helper SQL, `withUser(db, userId, fn)`    |
| `storage`        |   ✓    |    ✓     |               |            |      |         | S3-compatible client: put/get/delete, presigned upload/download URLs                        |
| `ai`             |   ✓    |    ✓     |               |            |      |    ✓    | Forge AI gateway client (chat/image/stt/tts), server-side only                              |
| `payments`       |   ✓    |    ✓     |               |            |      |         | Stripe Checkout route + webhook with signature verification, idempotent handlers            |
| `email`          |   ✓    |    ✓     |               |            |      |         | `EmailProvider`: SMTP (nodemailer), Resend, Postmark                                        |
| `cron`           |   ✓    |    ✓     |               |            |      |    ✓    | Jobs file mirrored into forge.json `crons`; route protected by `CRON_SECRET`                 |
| `seo`            |   ✓    |          |       ✓       |  built-in  |      |         | Metadata helpers, sitemap.xml, robots.txt, Open Graph, JSON-LD                              |
| `analytics`      |   ✓    |          |       ✓       |     ✓      |      |         | Cookieless Plausible-compatible pageview beacon; honours DNT/GPC                            |
| `cookie-consent` |   ✓    |          |       ✓       |     ✓      |      |         | Accessible banner; `text/plain` + `data-consent` scripts stay blocked until accepted        |
| `i18n`           |   ✓    |    ✓     |       ✓       |            |  ✓   |         | sv/en dictionaries, `t()`, Accept-Language negotiation, `<html lang>`                       |
| `cms`            |   ✓    |          |               |            |      |         | Zod content model, DB-backed store, `/admin` editor (auth + `CMS_ADMIN_EMAILS`)             |
| `observability`  |   ✓    |    ✓     |       ✓       |            |  ✓   |    ✓    | Errors → `FORGE_ERROR_INGEST_URL` (server token server-side; public ingest key in clients)  |

The integration test proves the kit is real code: nextjs with **every** feature installs, typechecks,
lints, tests, generates + applies Drizzle migrations on docker Postgres and builds; hono-api with all
server features is booted and exercised (Better Auth sign-up writes a user, cron secret enforced,
a correctly signed Stripe webhook is handled, a forged one rejected); vite/astro/fastapi with their
features pass their toolchains. `kit/` is excluded from this package's tsconfig and ESLint.

## Platform services — public API

```ts
// Database branching (checkpoints)
interface DbBranchProvider { createBranch(projectRoot, name, fromBranch?) → { branchId, connectionUrl };
  restoreBranch(projectRoot, branchId); deleteBranch(projectRoot, branchId); listBranches(projectRoot) → DbBranch[] }
createDbBranchProvider()  // DB_BRANCH_PROVIDER=neon|pgclone|mock
PgCloneBranchProvider.createDatabase(name) / dropProject(root) / close()
NeonBranchProvider.createProject(name)  // region aws-eu-central-1

// Deploy
interface DeployProvider { deploy({ projectId, dir | image, branch, env?, port?, healthPath? }) → { deploymentId, url, region, image };
  rollback(projectId, deploymentId); addDomain(projectId, hostname) → { verification: DnsRecord[], tlsStatus, configured };
  checkDomain; removeDomain; logs(deploymentId) → string[] }
createDeployProvider()    // DEPLOY_PROVIDER=fly|local|mock
LocalDeployProvider.listDeployments(projectId) / destroy(projectId)

// AI gateway (framework-agnostic: Request → Response)
handleGatewayRequest(req, { verifyToken, spend: SpendTracker, providers: { chat?, image?, stt?, tts? }, usage: UsageSink })
createProjectToken(claims, secret) / verifyProjectToken(token, secret, scope?)
LLMChatProvider(llm)  MemorySpendTracker  Mock{Image,Stt,Tts}GatewayProvider
ChatRequestSchema, ImageRequestSchema, SttRequestSchema, TtsRequestSchema  // wire protocol

// GitHub export
exportToGitHub({ files, owner, repo, branch, token, message }) → { commitSha, commitUrl, files, skipped, addedDockerfile }
createGitExporter()       // GIT_EXPORT_PROVIDER=github|mock

// Production feedback
new ErrorIngest({ llm?, usage?, events?, store? })
  .ingest(projectId, event) → { group, isNew }
  .suggestFix(groupId, files?) → SuggestedFix (status "pending_approval", emits approval.required)
  .approveFix(fixId, userId) / .rejectFix / .applyFix(fixId, files)  // throws APPROVAL_REQUIRED unless approved
handleErrorIngestRequest(req, { ingest, verifyToken })   // the FORGE_ERROR_INGEST_URL endpoint
parseStack, fingerprint, normalizeMessage, mockSuggestFix

// Expo
easBuild({ platform, profile, wait?, message?, autoSubmit? }) → { argv, command, cwd, requiredEnv: ["EXPO_TOKEN"], env }
parseEasBuildOutput(stdout); expoPreviewQr(url) → SVG string (qrcode)
```

Gateway behaviour: POST `/v1/{chat,image,stt,tts}`; `Authorization: Bearer <project token>`; requests
carrying `Origin`/`Sec-Fetch-Site` (browsers) get 403; zod validation (400); spend cap checked with the
provider's upper-bound estimate before the call (402); usage metered as `llm_input/output_tokens`,
`image_count`, `transcription_minutes`, `media_seconds` with the provider's `costUsd` (chat cost from
`@forge/llm` `costFor`, whose price table cites its source); provider errors → 502 without details.

ErrorIngest uses `@forge/llm` `structured()` with purpose `appkit.suggest_fix` (wrapped in `MeteredLLM`
when a `UsageSink` is given). `src/mock-llm.ts` registers rule-based handlers for `appkit.suggest_fix`
(null-property access → optional chaining patch, not-a-function → guarded call, network errors → no
patch) and `appkit.gateway.chat`; all mock output is labeled `[mock]`. Patches are exact search/replace,
restricted to files shown to the model, applied all-or-nothing, and refused if the file changed.

## Providers

| Interface         | Adapter          | Real/mock | Env vars                                                                 |
| ----------------- | ---------------- | --------- | ------------------------------------------------------------------------ |
| DbBranchProvider  | `neon`           | real (Neon API v2 REST, `fetch`) | `NEON_API_KEY`, `NEON_DATABASE_NAME` (neondb), `NEON_ROLE_NAME` (neondb_owner) |
| DbBranchProvider  | `pgclone`        | real (`CREATE DATABASE … TEMPLATE`) | `DATABASE_ADMIN_URL` (falls back to `DATABASE_URL`)                     |
| DbBranchProvider  | `mock`           | mock (in-memory, `mock://` URLs) | –                                                                        |
| DeployProvider    | `fly`            | real (Machines REST + GraphQL certs; registry push via docker) | `FLY_API_TOKEN`, `FLY_ORG`, `FLY_REGION` (arn/ams/fra/cdg only) |
| DeployProvider    | `local`          | real (docker build/run on this host) | `DEPLOY_BUILD_CA_FILE` (or `NODE_EXTRA_CA_CERTS`), `HTTPS_PROXY` passthrough |
| DeployProvider    | `mock`           | mock (`*.mock.forge.invalid`) | –                                                                        |
| GitExporter       | `github`         | real (REST git data API, `fetch`) | token passed per call                                               |
| GitExporter       | `mock`           | mock (real blob SHAs, in-memory) | –                                                                        |
| Gateway chat      | `LLMChatProvider`| real via `@forge/llm` (`LLM_PROVIDER`) | `MODEL_FAST` / `MODEL_BUILDER` / `MODEL_PLANNER` per tier               |
| Gateway image/stt/tts | `MockGateway*Provider` | mock (labeled SVG, placeholder transcript, silent WAV; cost 0) | real adapters are injected by the platform from media/speech |

## New env vars

`DB_BRANCH_PROVIDER`, `DEPLOY_PROVIDER`, `NEON_API_KEY`, `FLY_API_TOKEN`, `FLY_ORG`, `FLY_REGION` (already
in `.env.example`); new: `DATABASE_ADMIN_URL`, `NEON_DATABASE_NAME`, `NEON_ROLE_NAME`, `DEPLOY_BUILD_CA_FILE`,
`GIT_EXPORT_PROVIDER`. Generated apps read `FORGE_AI_GATEWAY_URL`, `FORGE_PROJECT_TOKEN`,
`FORGE_ERROR_INGEST_URL` plus the per-feature vars listed in their `.env.example` / `KIT.md`.

## Tests

- `pnpm --filter @forge/app-kit test` — 71 unit tests (no network/docker): kit registry/wiring/import
  resolution for every template × feature, Neon/Fly/GitHub adapters against stubbed `fetch`, local
  deployer with a fake docker runner, gateway auth/validation/cap/metering, tokens, error grouping and
  the approval flow, EAS command builder and QR.
- `pnpm --filter @forge/app-kit test:integration` — docker Postgres branch → modify → restore (DoD #4)
  and RLS isolation with a non-superuser role; local Docker deploy of hono-api with v2 + rollback; the
  kit toolchain runs described above.

## Limitations

- Fly, Neon and GitHub adapters are verified against stubbed HTTP only (no keys in this environment).
  Fly's logs endpoint (`api.fly.io/api/v1/apps/<app>/logs`) is the one flyctl uses, not a documented API.
- `PgCloneBranchProvider` makes full physical copies (fine for dev-sized databases); it terminates open
  connections to the source while copying and needs a role with CREATEDB.
- Local deploys serve plain HTTP on a host port; custom domains there only check DNS (`tlsStatus:
  "not_applicable"`).
- `MemorySpendTracker` / `MemoryErrorStore` are in-process; the platform should back them with billing's
  ledger and `@forge/db`.
- Payment handlers ship logging defaults and an in-process idempotency set; apps must persist fulfilment.
- `cms` is Next.js-only (websites that need editing should use the nextjs template); Expo kit covers
  i18n + observability; vite SEO is client-side (meta tags set at runtime).
- Mock image/stt/tts gateway providers exist so the gateway runs offline; they never claim vendor output.
