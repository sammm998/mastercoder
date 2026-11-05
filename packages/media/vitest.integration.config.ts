import { defineConfig } from "vitest/config";
// Remotion bundling (webpack) + Chromium rendering is slow on first run.
export default defineConfig({ test: { include: ["test/**/*.int.test.ts"], testTimeout: 300000, hookTimeout: 300000 } });
