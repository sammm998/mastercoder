import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env: { MOCK_LLM_COST: "estimate" }, include: ["test/**/*.int.test.ts"], testTimeout: 30000 } });
