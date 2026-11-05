import { describe, it, expect, afterAll } from "vitest";
import { connect, runMigrations } from "@forge/db";
import { monitorTick, MockAlertSink } from "../src/index.js";

const h = connect(undefined, 2);
afterAll(() => h.close());

describe("monitorTick", () => {
  it("persists health and alerts when a provider fails 3 checks in a row", async () => {
    await runMigrations();
    const alerts = new MockAlertSink();
    const name = `flaky-${Date.now()}`;
    const checks = [{ provider: name, kind: "media" as const, check: async () => { throw new Error("down"); } }];
    for (let i = 0; i < 3; i++) await monitorTick(h.db, checks, alerts);
    expect(alerts.sent.some((a) => a.kind === "provider_down" && a.details.provider === name)).toBe(true);
  });
});
