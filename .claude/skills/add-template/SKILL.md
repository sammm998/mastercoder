---
name: add-template
description: Add a new project starter template to packages/templates that the build agent can scaffold, verified to install, typecheck, test and start.
---
1. Create `packages/templates/files/<id>/` with a complete, minimal project (package.json/pyproject, README, tests, Dockerfile).
2. Include `forge.json`: `{ id, name, kind, install, dev, build, test, e2e?, port, lighthouse: bool }`.
3. The template must use design tokens from `src/styles/tokens.css` (or equivalent) so the design engine can restyle it.
4. Register it in `packages/templates/src/registry.ts` and add a test in `test/templates.test.ts` that validates the manifest.
5. Add an integration test (`*.int.test.ts`) that scaffolds into a sandbox and runs install + test.
