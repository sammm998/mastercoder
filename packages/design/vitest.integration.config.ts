import { defineConfig } from "vitest/config";
// Site integration test: npm install + vite build + Playwright + Lighthouse for 3 sites (minutes, not seconds).
export default defineConfig({ test: { include: ["test/**/*.int.test.ts"], testTimeout: 1_800_000, hookTimeout: 600_000, fileParallelism: false } });
