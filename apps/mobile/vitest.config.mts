import { defineConfig } from "vitest/config";

// Only pure logic in src/lib is unit-tested here (no React Native runtime in node).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
