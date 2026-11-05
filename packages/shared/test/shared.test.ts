import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, LocalObjectStore, extractJson, newId, redact, selectAdapter, stableStringify, sumEstimate, MemoryUsageSink } from "../src/index.js";

describe("shared", () => {
  it("selectAdapter picks by env and flags mock", () => {
    process.env.TEST_PROVIDER = "mock";
    const s = selectAdapter("TEST_PROVIDER", { real: () => 1, mock: () => 2 }, "real");
    expect(s).toEqual({ name: "mock", isMock: true, instance: 2 });
    delete process.env.TEST_PROVIDER;
    expect(selectAdapter("TEST_PROVIDER", { real: () => 1, mock: () => 2 }, "real").instance).toBe(1);
    process.env.TEST_PROVIDER = "nope";
    expect(() => selectAdapter("TEST_PROVIDER", { real: () => 1 }, "real")).toThrow(/Unknown/);
    delete process.env.TEST_PROVIDER;
  });
  it("newId is prefixed and unique", () => {
    const a = newId("prj");
    expect(a.startsWith("prj_")).toBe(true);
    expect(new Set(Array.from({ length: 500 }, () => newId("x"))).size).toBe(500);
  });
  it("event bus emits with ids and filters by type", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    bus.emit({ type: "message", projectId: "p", role: "assistant", text: "hi" });
    bus.emit({ type: "usage", projectId: "p", costUsd: 0.1, tokensIn: 1, tokensOut: 1 });
    expect(seen).toEqual(["message", "usage"]);
    expect(bus.ofType("usage")[0]?.costUsd).toBe(0.1);
  });
  it("local object store round-trips and blocks traversal", async () => {
    const s = new LocalObjectStore(mkdtempSync(join(tmpdir(), "forge-")));
    await s.put("a/b.txt", "hello");
    expect(Buffer.from(await s.get("a/b.txt")).toString()).toBe("hello");
    expect(await s.list("a/")).toEqual(["a/b.txt"]);
    await expect(s.put("../x", "y")).rejects.toThrow();
    await s.delete("a/b.txt");
    expect(await s.exists("a/b.txt")).toBe(false);
  });
  it("extractJson handles fences and prose", () => {
    expect(extractJson('Sure!\n```json\n{"a": [1, "}"]}\n```')).toEqual({ a: [1, "}"] });
    expect(extractJson('result: [1,2] done')).toEqual([1, 2]);
  });
  it("stableStringify sorts keys", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("redacts secret-looking fields", () => {
    expect(redact({ apiKey: "x", nested: { password: "p", ok: 1 } })).toEqual({ apiKey: "[redacted]", nested: { password: "[redacted]", ok: 1 } });
  });
  it("estimates and sinks", () => {
    expect(sumEstimate([{ label: "a", usd: 1 }], 0.5)).toMatchObject({ lowUsd: 0.5, highUsd: 1.5 });
    const sink = new MemoryUsageSink();
    sink.record({ kind: "sandbox_minutes", quantity: 2, costUsd: 0.02, provider: "docker" });
    expect(sink.totalUsd()).toBeCloseTo(0.02);
  });
});
