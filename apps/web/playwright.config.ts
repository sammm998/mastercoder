import { defineConfig, devices } from "@playwright/test";

/**
 * E2E: starts the real API (Postgres + Redis from docker compose must be running) and the web app.
 * Ports default to 4410/3410 so a developer's own dev servers on 3000/4000 are left alone.
 * E2E_WEB_MODE=dev uses `next dev` (faster startup); the default is a production build.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 4410);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3410);
const API_URL = `http://localhost:${API_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const dev = process.env.E2E_WEB_MODE === "dev";
const reuse = !process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: "pnpm --filter @forge/api start",
      url: `${API_URL}/health`,
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: {
        API_PORT: String(API_PORT),
        APP_URL: WEB_URL,
        API_URL,
        EMAIL_PROVIDER: process.env.EMAIL_PROVIDER ?? "smtp",
        RATE_LIMIT_PER_MIN_IP: "5000",
        RATE_LIMIT_PER_MIN_USER: "5000",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: dev ? `pnpm exec next dev --webpack --port ${WEB_PORT}` : `pnpm exec next build --webpack && pnpm exec next start --port ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: reuse,
      timeout: 360_000,
      env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_TELEMETRY_DISABLED: "1" },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
