# 0001 — Source-only workspace packages

**Decision:** Workspace packages export TypeScript source (`main: src/index.ts`). Node services run with
`tsx`; Next.js uses `transpilePackages`. No per-package build.

**Why:** Removes a build graph from a 20-package monorepo, keeps typecheck as the only compile step and
makes subagent worktrees independent. **Trade-off:** production images run via tsx (or are bundled with esbuild
in the Dockerfile).
