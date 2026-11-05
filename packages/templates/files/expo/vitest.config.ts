import { defineConfig } from "vitest/config";

// Logic tests only (pure TS, no React Native runtime). UI is verified on device / Expo web.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node" } });
