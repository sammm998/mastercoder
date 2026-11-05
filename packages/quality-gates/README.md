# @forge/quality-gates

Quality, security and performance gates that run against a project inside a `@forge/sandbox` sandbox and block
delivery when something fails. Every failing gate returns `findings` (file/line/rule/message/severity) and a
concrete `fix` text the builder agent can apply.

## Public API

```ts
import { runGates, formatGateReport, gateEvents, STATIC_GATES } from "@forge/quality-gates";

const report = await runGates(sandbox, {
  gates: ["typecheck", "lint", "unit", "semgrep", "gitleaks", "osv", "rls", "auth", "validation", "client-secrets"],
  previewUrl, lighthouse: (url) => runLighthouse(url), visualScore: 8.4,   // contract options
  externalTools: true, env: {}, commandTimeoutMs: 600_000, fetch, thresholds: { performance: 85, accessibility: 90, visual: 8 }, // extensions
});
report.passed; report.blockers;          // GateResult[] that failed (skipped gates never block)
formatGateReport(report);                // markdown table + findings + proposed fixes (UI / chat)
gateEvents(report, projectId, taskId);   // ForgeEventInput[] of type "gate.result" for an EventSink
```

Types (`GateName`, `Finding`, `GateResult`, `GateReport`) are exactly those in `BUILD_PLAN.md`. Also exported:
`detectProject`, `ForgeManifestSchema`, `collectFiles`, `findSecrets`/`SECRET_RULES`, `scanOwasp`,
`collectDependencies`/`queryOsv`, `findRoutes`/`matchesPublicRoute`, `analyzeRls`, `parseToolOutput`.

## Gates

| gate | what it does |
|---|---|
| typecheck / lint / unit / integration / e2e | Runs the project's command inside the sandbox (`CI=1`). Commands come from `forge.json` (`typecheck`, `lint`, `test`, `integration`, `e2e`; `null` disables) or are inferred from `package.json` scripts (pnpm/yarn/bun/npm by lockfile) or `pyproject.toml` (mypy/pyright, ruff/flake8, pytest). Skipped with the reason when not applicable. Output of tsc, eslint (stylish/unix), ruff/mypy/flake8, vitest/jest and pytest is parsed into file/line findings. |
| semgrep | `semgrep scan --config p/owasp-top-ten --json` when semgrep is on the sandbox or host PATH; otherwise built-in OWASP rules (details say so): SQL built by template/concatenation (error when request input is in reach; tagged `sql\`\`` and `$1` params are fine), `eval`/`new Function`, `child_process.exec` with interpolation / `shell: true`, `dangerouslySetInnerHTML` / `innerHTML` / `insertAdjacentHTML` without a sanitizer, disabled TLS verification, wildcard/reflected CORS with credentials, hardcoded JWT secrets, open redirects; Python f-string/`%`/`format` SQL, `subprocess(shell=True)`, `os.system`, `pickle.load(s)`, `yaml.load` without SafeLoader, `eval/exec`, `verify=False`. |
| gitleaks | `gitleaks detect --no-git --redact --report-format json` when installed; otherwise built-in secret rules: AWS key id + secret, Stripe `sk_/rk_ live/test`, GitHub, Slack tokens + webhooks, OpenAI, Anthropic, Google, SendGrid, private keys, hardcoded JWT/session secrets, generic high-entropy credential assignments (entropy ≥ 3.8, placeholders ignored). Secrets are redacted in findings. `gitleaks:allow` / `forge:allow-secret` on a line suppresses it; `.env.example` is ignored, `.env` is scanned. |
| osv | `osv-scanner --format json -r .` when installed; otherwise parses `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements*.txt`, `poetry.lock`, `uv.lock` (and `package.json` ranges when a dir has no lockfile) and queries `https://api.osv.dev/v1/querybatch` + `/v1/vulns/{id}` for summary, severity and fixed version. Unreachable API ⇒ skipped (visible, not silently passed). |
| rls | Every `CREATE TABLE` in `*.sql` migrations and every Drizzle `pgTable` needs `ENABLE ROW LEVEL SECURITY` (or Drizzle `.enableRLS()` / `pgTable.withRLS`) **and** ≥1 `CREATE POLICY` (or `pgPolicy`, incl. `.link(table)`). Reported per table with a ready SQL migration (owner column detected; `auth.uid()` for Supabase projects). Internal schemas (`drizzle`, `supabase_migrations`, …) and `_`-prefixed tables are skipped. |
| auth | Finds handlers — Next.js app router `route.ts` exports, `pages/api`, server actions (`"use server"` files and inline), Express/Fastify/Hono `app.get(...)`, FastAPI `@app.post`, Flask `@app.route` — and requires an auth check (`auth()`, `getServerSession`, `currentUser`, `jwtVerify`, `req.user`, auth middleware args, `app.use(auth…)`, Next `middleware.ts` with matcher, FastAPI `Depends(get_current_user)` / router dependencies, `@login_required`, …) unless public via `// forge:public` (file header, the lines above the handler, or inside it) or `forge.json` `publicRoutes` (`/api/health`, `/api/public/*`, `/blog/**`, `GET /path`). |
| validation | Every POST/PUT/PATCH handler and server action that reads input must validate it: zod/valibot `.parse/.safeParse`, yup `.validate`, `zValidator`, typia, Fastify `schema.body`, `validate*()`; FastAPI pydantic model parameters / `model_validate`. |
| client-secrets | Client code = `"use client"` files, Vite `src/` (non-server), Expo `app/`/`components/`, and built bundles (`dist/`, `build/`, `.next/static`, `out/_next/static`). Flags secret patterns, `process.env.X` / `import.meta.env.X` without a public prefix (`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, …), and secret-looking names exposed with a public prefix (`NEXT_PUBLIC_*_SECRET`, `VITE_SERVICE_ROLE_KEY`). |
| lighthouse | `opts.lighthouse(previewUrl)`; performance ≥ 85 and accessibility ≥ 90 (scores 0..1 or 0..100). |
| visual-qa | `opts.visualScore ≥ 8`. |

A gate that throws fails closed (blocker, details `gate crashed: …`).

## forge.json

```json
{ "kind": "nextjs", "typecheck": "pnpm tsc --noEmit", "lint": "pnpm eslint .", "test": "pnpm vitest run",
  "integration": null, "e2e": "pnpm playwright test", "build": "pnpm build", "publicRoutes": ["/api/health"] }
```

## Providers

| adapter | real/mock | env vars |
|---|---|---|
| semgrep / gitleaks / osv-scanner CLIs | real (used when on sandbox or host PATH) | – |
| built-in scanners | real local analysis (fallback; labelled in `details`) | – |
| OSV API (`fetch`) | real public API, no key (`https://api.osv.dev`) | – |
| lighthouse / visual QA | injected by the caller (`@forge/design`) | – |

No new env vars. Sandbox selection is the caller's (`@forge/sandbox`, `SANDBOX_PROVIDER`).

## Tests

- `pnpm --filter @forge/quality-gates test` — fixtures run through `LocalSandboxProvider`:
  `test/fixtures/insecure-app` (hardcoded AWS key, SQL injection, table without RLS, unauthenticated route,
  unvalidated POST, server secret in a client component, vulnerable lodash) is blocked on every static gate with
  the specific findings; `test/fixtures/secure-app` passes all static gates. Plus scanner/route/RLS/lockfile unit
  tests, command-gate parsing, fake semgrep/gitleaks/osv-scanner binaries, lighthouse/visual thresholds. The OSV
  API is stubbed with `vi.stubGlobal("fetch")`.
- `pnpm --filter @forge/quality-gates test:integration` — the same fixtures inside a real Docker sandbox.
- Fixtures are excluded from this package's tsconfig and ESLint (`eslint.config.mjs`).

## Limitations

- Built-in scanners are heuristic (regex + bracket matching, no type information); semgrep/gitleaks/osv-scanner
  are preferred when installed. Route discovery covers the listed frameworks only; custom routers may be missed.
- Auth detection checks for the presence of an auth call/middleware, not that its result is enforced.
- The OSV fallback needs outbound HTTPS from the Forge host (Node `fetch` does not use `HTTPS_PROXY`; pass an
  `opts.fetch` that does if your host requires a proxy).
- Command gates do not install dependencies; run the install step before `runGates`.
