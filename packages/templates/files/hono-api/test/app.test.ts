import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

const app = createApp(loadEnv({ NODE_ENV: "test" }));

describe("api", () => {
  it("reports health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("validates request bodies with zod", async () => {
    const ok = await app.request("/v1/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hej", uppercase: true }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ message: "HEJ" });

    const bad = await app.request("/v1/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "" }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_body" });
  });

  it("returns JSON 404s", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });

  it("rejects invalid configuration", () => {
    expect(() => loadEnv({ PORT: "not-a-port" })).toThrow(/PORT/);
  });
});
