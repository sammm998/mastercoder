import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env: { MOCK_LLM_COST: "estimate" }, include: ["test/**/*.test.ts"], exclude: ["test/**/*.int.test.ts"], passWithNoTests: true } });
