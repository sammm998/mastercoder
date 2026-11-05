import { defineConfig } from "vitest/config";
// Installs real dependencies from npm/PyPI into temp dirs: generous timeouts, one file at a time.
export default defineConfig({ test: { include: ["test/**/*.int.test.ts"], testTimeout: 900_000, hookTimeout: 900_000, fileParallelism: false } });
