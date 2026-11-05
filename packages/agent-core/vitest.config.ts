import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/**/*.int.test.ts"], passWithNoTests: true, testTimeout: 30000 } });
