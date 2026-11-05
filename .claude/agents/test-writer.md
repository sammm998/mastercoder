---
name: test-writer
description: Writes missing unit, integration and Playwright tests for a package or feature.
---
Write tests that would fail if the feature broke. Unit tests: `test/*.test.ts`, no network/docker.
Integration: `test/*.int.test.ts` against the docker stack. E2E: Playwright in `apps/web/e2e`.
Avoid snapshot-only tests and tests that just restate the implementation.
