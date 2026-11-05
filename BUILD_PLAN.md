# Forge — Build plan

Task graph in waves. A task may start when every dependency is merged to the branch. Each package is
built in its own git worktree by a subagent and merged only after its typecheck/lint/tests pass.

## Wave 0 — Foundation (sequential, lead)
- F1 repo tooling: pnpm, turbo, tsconfig, eslint (vendor-SDK import rule), prettier, vitest
- F2 docker-compose (pgvector, redis, SeaweedFS S3, mailpit), .devcontainer, .env.example
- F3 `@forge/shared`: env/selectAdapter, ids, errors, intents, usage, events (ForgeEvent), ObjectStore (local + S3), logger, json
- F4 `@forge/llm`: LLMProvider, Anthropic SDK adapter (adaptive thinking, prompt caching, server fallbacks), OpenAI, Mock registry, pricing, MeteredLLM, structured(), defineTool()
- F5 `@forge/db`: Drizzle schema for every platform table + migrations + integration test
- F6 CLAUDE.md, BUILD_PLAN.md, PROGRESS.md, .claude/ (agents, hooks, skills), ADRs

## Wave 1 — Independent packages (parallel subagents)
| ID | Package(s) | Depends on |
|----|-----------|-----------|
| W1-A | sandbox (Docker real, E2B, Daytona, Local mock) + quality-gates | shared, llm |
| W1-B | templates (6 starters) + app-kit (kit files, deploy providers, DB branching, AI gateway, SEO/CMS) | shared |
| W1-C | design (art direction, tokens, motion/3D pattern library, visual QA, Lighthouse) | shared, llm |
| W1-D | media (fal, Replicate, mock, Remotion, moderation, job service) + slides (deck/doc JSON, PPTX/PDF/DOCX) | shared, llm |
| W1-E | speech (ElevenLabs, Deepgram, Whisper, mock, WER) + meetings (Recall, MeetStream, Vexa, mock, chunked uploads, pipeline) | shared, llm |
| W1-F | integrations (Composio, Nango, Pipedream, mock, OpenAPI import, MCP, vault) + billing (Stripe, mock, meter, caps) + intent-router | shared, llm, db |

## Wave 2 — Orchestration
- W2-A agent-core: loop PLAN→DESIGN→BUILD→VERIFY→REVIEW→FINISH, tools, model router, context engine (repo map + pgvector), loop guard, checkpoints — needs all of wave 1
- W2-B agents-runtime: definition generator, runner (Claude Agent SDK adapter + in-house loop + mock), triggers (cron/webhook/email/chat), approvals, evals, channels — needs integrations, llm

## Wave 3 — Apps
- W3-A apps/api: Fastify + tRPC routers + WS gateway (events via Redis pub/sub, Yjs rooms), auth (email+password, magic link, OAuth-ready, SSO-ready), rate limits, GDPR export/delete, audit log
- W3-B apps/agent-worker: BullMQ queues (build, media, transcription, meeting-bot, agent-run, deploy, scan), cron scheduler
- W3-C apps/web: Next.js platform UI (all pages in §5), i18n sv/en, award-level design
- W3-D apps/admin: users, projects, costs, abuse queue, provider health
- W3-E apps/mobile: Expo chat, voice, record meetings (chunked), preview

## Wave 4 — Verification
- W4-A evals/benchmark.md + runner (20 prompts), load test (50 concurrent), sandbox escape tests, insecure-app gate test, checkpoint restore test, two-browser Yjs test, cron agent approval test, speech WER
- W4-B observability (OTel traces per agent run, Sentry adapter), FINAL_REPORT.md

## Interface contracts (wave 1 must implement exactly; extend, don't break)

### sandbox (`@forge/sandbox`)
```ts
interface SandboxSpec { projectId: string; image?: string; cpu?: number; memoryMb?: number; timeoutSec?: number;
  egressAllowlist?: string[]; env?: Record<string,string>; template?: string }
interface ExecOptions { cwd?: string; timeoutMs?: number; env?: Record<string,string> }
interface ExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }
interface Sandbox { readonly id: string; readonly projectId: string; readonly workdir: string; // "/workspace"
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>; readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  listFiles(dir?: string, opts?: { recursive?: boolean }): Promise<string[]>;
  snapshot(label?: string): Promise<{ snapshotId: string }>; restore(snapshotId: string): Promise<void>;
  exposePort(port: number): Promise<{ url: string }>; pause(): Promise<void>; resume(): Promise<void>; destroy(): Promise<void> }
interface SandboxProvider { readonly name: string; readonly isMock: boolean; create(spec: SandboxSpec): Promise<Sandbox>; get(id: string): Promise<Sandbox | null> }
createSandboxProvider(): SandboxProvider   // SANDBOX_PROVIDER=e2b|daytona|docker|local
```

### quality-gates (`@forge/quality-gates`)
```ts
type GateName = "typecheck"|"lint"|"unit"|"integration"|"e2e"|"semgrep"|"gitleaks"|"osv"|"rls"|"auth"|"validation"|"client-secrets"|"lighthouse"|"visual-qa"
interface Finding { file?: string; line?: number; rule: string; message: string; severity: "error"|"warning" }
interface GateResult { gate: GateName; passed: boolean; skipped?: boolean; details: string; findings: Finding[]; fix?: string; durationMs: number }
interface GateReport { passed: boolean; results: GateResult[]; blockers: GateResult[] }
runGates(sandbox: Sandbox, opts: { gates?: GateName[]; previewUrl?: string; lighthouse?: (url)=>Promise<{performance:number;accessibility:number}>; visualScore?: number }): Promise<GateReport>
```

### design (`@forge/design`)
```ts
interface ArtDirection { id; name; mood: string; typography: { display: FontSpec; body: FontSpec; mono?: FontSpec; scale: number[] };
  palette: { bg; surface; text; muted; accent; accent2; border; ... }; grid: { columns; maxWidth; gutter };
  spacing: number[]; radius: number[]; motion: { language: string; easing: string; durations: { fast; base; slow } }; rationale: string }
generateDirections(llm, brief: DesignBrief, brand?: BrandInput): Promise<ArtDirection[]>  // exactly 3
pickDirection(dirs, brief): ArtDirection
tokensFromDirection(d): DesignTokens; tokensToCss(t): string; tokensToTailwind(t): object; tokensToJson(t)
patterns: PatternDef[] { id; name; description; files: Record<string,string>; dependencies: Record<string,string>; a11y: string[]; reducedMotion: string }
visualQA(llm, shots: Screenshot[], ctx): Promise<{ score: number; criteria: Record<Criterion, number>; notes: string; passed: boolean }>
captureScreenshots(url, viewports=[375,768,1440]): Promise<Screenshot[]>; runLighthouse(url)
```

### media / slides / speech / meetings / integrations / billing / intent-router
See each package's README (written by its subagent) — must export a `create<X>Provider()` factory selecting
real vs mock by env, an `estimate()` returning `CostEstimate`, and record usage into a `UsageSink`.

### Tools (`@forge/llm` defineTool)
```ts
defineTool({ name, description, input: zodSchema, run: async (input, ctx) => string | object }) → ForgeTool
toToolDef(tool) → ToolDef (JSON schema)
```
