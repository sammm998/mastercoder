import { describe, it, expect, afterAll } from "vitest";
import { initTracing, withSpan, spanEventRecorder, detectSpikes, runHealthChecks, MockErrorReporter } from "../src/index.js";

const t = initTracing("test-service");
afterAll(() => t.shutdown());

describe("tracing", () => {
  it("records nested spans with agent events and errors", async () => {
    await withSpan("agent.run", { "forge.task_id": "tsk_1" }, async (span) => {
      const rec = spanEventRecorder(span);
      rec({ type: "phase.started", phase: "plan" });
      rec({ type: "usage", costUsd: 0.12, tokensIn: 10, tokensOut: 5 });
      await withSpan("tool.write_file", { path: "a.ts" }, async () => undefined);
    });
    await expect(withSpan("boom", {}, async () => { throw new Error("x"); })).rejects.toThrow("x");
    const spans = t.memory!.getFinishedSpans();
    const run = spans.find((s) => s.name === "agent.run")!;
    const child = spans.find((s) => s.name === "tool.write_file")!;
    expect(child.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(run.events.map((e) => e.name)).toEqual(["phase.started", "usage"]);
    expect(run.attributes["forge.cost_usd"]).toBeCloseTo(0.12);
    expect(spans.find((s) => s.name === "boom")!.status.code).toBe(2);
  });
});

describe("alerts", () => {
  it("detects cost spikes against the trailing mean", () => {
    const daily = [
      ...Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-0${i + 1}`.replace("0010", "10"), provider: "fal", costUsd: 10 })),
      { day: "2026-11-08", provider: "fal", costUsd: 45 },
      { day: "2026-11-08", provider: "anthropic", costUsd: 3 },
    ];
    expect(detectSpikes(daily, "2026-11-08")).toEqual([{ provider: "fal", todayUsd: 45, meanUsd: 10 }]);
  });
  it("runs health checks with timeouts", async () => {
    const r = await runHealthChecks([
      { provider: "ok", kind: "llm", check: async () => undefined },
      { provider: "bad", kind: "llm", check: async () => { throw new Error("503"); } },
      { provider: "slow", kind: "llm", check: () => new Promise((res) => setTimeout(res, 500)) },
    ], 100);
    expect(r.map((x) => [x.provider, x.ok])).toEqual([["ok", true], ["bad", false], ["slow", false]]);
    expect(r[2]!.error).toMatch(/timeout/);
  });
  it("mock error reporter captures", () => {
    const m = new MockErrorReporter();
    expect(m.capture(new Error("e"), { tags: { a: "b" } })).toBe("err_1");
    expect(m.captured[0]?.message).toBe("e");
  });
});
