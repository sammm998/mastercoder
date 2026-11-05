import { defineConfig } from "vitest/config";
// Real docker: run files one at a time (they share the egress proxy) with generous timeouts for image pulls.
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/int-global-setup.ts"],
    testTimeout: 180000,
    hookTimeout: 600000,
    fileParallelism: false,
  },
});
