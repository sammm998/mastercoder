import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MemoryUsageSink } from "@forge/shared";
import { MeteredLLM, MockLLMProvider, costFor, modelForComplexity, structured, textOf, toolUses } from "../src/index.js";

describe("llm", () => {
  it("prices Claude 5.5 models", () => {
    expect(costFor("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(4);
    expect(costFor("claude-haiku-5-5", { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0.5);
  });
  it("routes complexity to models", () => {
    const m = { planner: "P", builder: "B", fast: "F", vision: "V" };
    expect([modelForComplexity("trivial", m), modelForComplexity("normal", m), modelForComplexity("complex", m)]).toEqual(["F", "B", "P"]);
  });
  it("mock routes by purpose and errors when unhandled", async () => {
    const llm = new MockLLMProvider().on("greet", () => "hello").on(/^tool\./, () => [{ type: "tool_use", id: "t1", name: "x", input: {} }]);
    const r = await llm.complete({ purpose: "greet", model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] });
    expect(textOf(r)).toBe("hello");
    const t = await llm.complete({ purpose: "tool.run", model: "claude-haiku-5-5", messages: [] });
    expect(t.stopReason).toBe("tool_use");
    expect(toolUses(t)).toHaveLength(1);
    await expect(llm.complete({ purpose: "nope", model: "m", messages: [] })).rejects.toThrow(/no handler/);
  });
  it("structured retries on invalid output", async () => {
    let n = 0;
    const llm = new MockLLMProvider().on("s", () => (n++ === 0 ? "not json" : '{"a": 2}'));
    const { value, responses } = await structured(llm, { purpose: "s", model: "claude-haiku-5-5", messages: [{ role: "user", content: "x" }] }, z.object({ a: z.number() }));
    expect(value.a).toBe(2);
    expect(responses).toHaveLength(2);
  });
  it("metered wrapper records usage", async () => {
    const sink = new MemoryUsageSink();
    const llm = new MeteredLLM(new MockLLMProvider().on("x", () => "y".repeat(400)), sink, { projectId: "p1" });
    await llm.complete({ purpose: "x", model: "claude-sonnet-5-5", messages: [{ role: "user", content: "q".repeat(400) }] });
    expect(sink.records.every((r) => r.projectId === "p1")).toBe(true);
    expect(sink.totalUsd()).toBeCloseTo(llm.totalCostUsd, 8);
    expect(llm.totalOutput).toBeGreaterThan(0);
  });
});
