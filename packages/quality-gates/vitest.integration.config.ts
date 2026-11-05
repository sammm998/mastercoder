import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.int.test.ts"], testTimeout: 180000, hookTimeout: 600000, fileParallelism: false } });
