---
name: add-provider-adapter
description: Add a new external provider adapter (LLM, sandbox, media, STT, meeting bot, connector, billing, deploy) to Forge behind its existing interface, with a mock and tests.
---
1. Find the interface: `grep -rn "interface .*Provider" packages/<pkg>/src`.
2. Create `packages/<pkg>/src/adapters/<vendor>.ts` implementing it. Vendor SDK imports are allowed ONLY under `adapters/`.
   Prefer the vendor's official SDK; otherwise `fetch` with typed zod-parsed responses. EU region/endpoint by default.
3. Read credentials from env in the factory, never in module scope. Add every new variable to `.env.example` with a comment.
4. Register in the package factory: `selectAdapter("<PKG>_PROVIDER", { <vendor>: () => new X(...), mock: ... }, "mock")`.
5. Meter usage: every billable call records a `UsageRecord` with real `costUsd` (document the price source in a comment).
6. Tests: unit-test request mapping with a stubbed `fetch` (`vi.stubGlobal("fetch", ...)`); never hit the network in unit tests.
7. Update the package README "Providers" table and FINAL_REPORT.md real-vs-mock list.
