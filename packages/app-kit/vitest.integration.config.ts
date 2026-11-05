import { defineConfig } from "vitest/config";
// Docker Postgres, docker build/run and real npm installs: long timeouts, one file at a time.
export default defineConfig({ test: { include: ["test/**/*.int.test.ts"], testTimeout: 900_000, hookTimeout: 900_000, fileParallelism: false } });
