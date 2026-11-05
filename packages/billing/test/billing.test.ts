import { describe, it, expect } from "vitest";
import { MemoryUsageSink, type UsageRecord } from "@forge/shared";
import { MeteredLLM, MockLLMProvider, costFor } from "@forge/llm";
import {
  BUDGETS,
  MARKUP,
  MemoryUsageRepo,
  MockBillingProvider,
  PLANS,
  SpendGuard,
  StaticSpendCaps,
  UsageMeter,
  checkLimit,
  estimate,
  estimateTask,
  getPlan,
  monthStartUtc,
  priceRecords,
  priceUsage,
  requireFeature,
  settleTask,
  userUnitPrice,
  usdToCredits,
} from "../src/index.js";

const models = { planner: "claude-opus-5-5", builder: "claude-sonnet-5-5", fast: "claude-haiku-5-5", vision: "claude-sonnet-5-5" };

describe("plans", () => {
  it("defines Free/Pro/Team/Enterprise with prices, credit, limits and features", () => {
    expect(Object.keys(PLANS)).toEqual(["free", "pro", "team", "enterprise"]);
    expect([PLANS.free.monthlyUsd, PLANS.pro.monthlyUsd, PLANS.team.monthlyUsd, PLANS.enterprise.monthlyUsd]).toEqual([0, 25, 99, null]);
    const order = ["free", "pro", "team", "enterprise"] as const;
    for (let i = 1; i < order.length; i++) {
      const a = PLANS[order[i - 1]!];
      const b = PLANS[order[i]!];
      expect(b.includedCreditUsd).toBeGreaterThan(a.includedCreditUsd);
      for (const k of Object.keys(a.limits) as Array<keyof typeof a.limits>) expect(b.limits[k]).toBeGreaterThanOrEqual(a.limits[k]);
      for (const f of a.features) expect(b.features).toContain(f);
    }
    expect(PLANS.free.overage).toBe(false);
    expect(() => getPlan("platinum")).toThrow(/Unknown plan/);
    expect(() => requireFeature("free", "video")).toThrow(/does not include video/);
    expect(() => requireFeature("enterprise", "sso")).not.toThrow();
    expect(() => checkLimit("free", "concurrentBuilds", 1)).toThrow(/limit reached/);
    expect(() => checkLimit("pro", "concurrentBuilds", 2)).not.toThrow();
  });
});

describe("pricing", () => {
  it("applies markup + platform fee linearly", () => {
    const r = { kind: "llm_output_tokens" as const, quantity: 1_000_000, costUsd: 10 };
    expect(priceUsage(r)).toBe(15);
    expect(priceUsage({ kind: "sandbox_minutes", quantity: 10, costUsd: 0.0276 })).toBeCloseTo(0.0552, 4);
    expect(priceUsage({ kind: "agent_run", quantity: 3, costUsd: 0 })).toBe(0.006);
    const rs = [r, { kind: "image_count" as const, quantity: 4, costUsd: 0.12 }];
    expect(priceRecords(rs)).toBeCloseTo(15 + 0.156, 6);
    for (const k of Object.keys(MARKUP)) expect(MARKUP[k as keyof typeof MARKUP]).toBeGreaterThanOrEqual(0);
    expect(userUnitPrice("bot_hours")).toBe(0.75);
    expect(usdToCredits(1.2345)).toBe(1235);
  });
});

describe("estimateTask", () => {
  it("is built from token budgets × costFor model prices × markup + sandbox", () => {
    const e = estimateTask({ intents: ["question"], models });
    const b = BUDGETS.question.steps[0]!;
    const expected = costFor("claude-haiku-5-5", { inputTokens: b.input, outputTokens: b.output, cacheReadTokens: 0, cacheWriteTokens: 0 }) * 1.5;
    const total = e.breakdown.reduce((a, p) => a + p.usd, 0);
    expect(total).toBeCloseTo(expected, 4);
    expect(e.lowUsd).toBeLessThan(total);
    expect(e.highUsd).toBeGreaterThan(total);
  });

  it("scales with complexity and model choice, and sums multiple intents", () => {
    const t = estimateTask({ intents: ["app"], complexity: "trivial", models });
    const n = estimateTask({ intents: ["app"], complexity: "normal", models });
    const c = estimateTask({ intents: ["app"], complexity: "complex", models });
    expect(t.highUsd).toBeLessThan(n.highUsd);
    expect(n.highUsd).toBeLessThan(c.highUsd);
    expect(n.highUsd).toBeGreaterThan(1);
    expect(n.highUsd).toBeLessThan(10);
    const cheaper = estimateTask({ intents: ["app"], models: { ...models, builder: "claude-haiku-5-5", planner: "claude-haiku-5-5" } });
    expect(cheaper.highUsd).toBeLessThan(n.highUsd / 5);
    const multi = estimateTask({ intents: ["website", "video", "slides"], models });
    const sum = ["website", "video", "slides"].reduce((a, k) => a + estimateTask({ intents: [k as "website"], models }).highUsd, 0);
    expect(multi.highUsd).toBeCloseTo(sum, 2);
    expect(estimateTask({ intents: ["app", "app"], models }).highUsd).toBe(n.highUsd);
    expect(n.breakdown.some((p) => /sandbox/.test(p.label))).toBe(true);
  });

  it("prices media units: images, generated seconds, remotion render, slides", () => {
    const img4 = estimateTask({ intents: ["image"], models });
    const img8 = estimateTask({ intents: ["image"], images: 8, models });
    expect(img8.highUsd - img4.highUsd).toBeCloseTo(4 * 0.03 * 1.3 * 1.35, 3);
    const gen10 = estimateTask({ intents: [{ kind: "video" }], mediaSeconds: 10, models });
    const gen20 = estimateTask({ intents: [{ kind: "video" }], mediaSeconds: 20, models });
    expect(gen20.highUsd).toBeGreaterThan(gen10.highUsd);
    expect(gen10.breakdown.find((p) => p.label === "video: 10 s generation")!.usd).toBeCloseTo(1.3, 3);
    const rem = estimateTask({ intents: [{ kind: "video", hint: "remotion" }], mediaSeconds: 20, models });
    expect(rem.breakdown.some((p) => /render 20 s/.test(p.label))).toBe(true);
    expect(estimateTask({ intents: ["slides"], slides: 20, models }).highUsd).toBeGreaterThan(estimateTask({ intents: ["slides"], slides: 5, models }).highUsd);
    expect(() => estimateTask({ intents: [] })).toThrow();
    expect(() => estimateTask({ intents: ["image"], images: -1 })).toThrow();
    expect(estimate).toBe(estimateTask);
  });
});

const rec = (over: Partial<UsageRecord>): UsageRecord => ({ kind: "llm_output_tokens", quantity: 100_000, costUsd: 1, provider: "anthropic", taskId: "tsk_1", workspaceId: "ws_1", ...over });

describe("settleTask", () => {
  const usage = [rec({}), rec({ kind: "sandbox_minutes", quantity: 10, costUsd: 0.05 })];
  it("charges list price on success, capped at the quoted high estimate", () => {
    const s = settleTask({ taskId: "tsk_1", outcome: "succeeded", usage });
    expect(s).toMatchObject({ charged: true, chargedUsd: 1.6, providerCostUsd: 1.05, listPriceUsd: 1.6 });
    expect(s.lines).toHaveLength(2);
    const capped = settleTask({ taskId: "tsk_1", outcome: "succeeded", usage, estimate: { lowUsd: 0.5, highUsd: 1.2 } });
    expect(capped.chargedUsd).toBe(1.2);
    expect(capped.policy).toMatch(/capped/);
    expect(settleTask({ taskId: "tsk_1", outcome: "succeeded", usage, estimate: { lowUsd: 0.5, highUsd: 1.2 }, capToEstimate: false }).chargedUsd).toBe(1.6);
  });
  it("never charges for agent errors or provider failures", () => {
    for (const outcome of ["failed_agent_error", "failed_provider"] as const) {
      const s = settleTask({ taskId: "tsk_1", outcome, usage });
      expect(s).toMatchObject({ charged: false, chargedUsd: 0, providerCostUsd: 1.05 });
    }
  });
  it("charges cancelled tasks at provider cost without markup", () => {
    expect(settleTask({ taskId: "tsk_1", outcome: "cancelled_by_user", usage }).chargedUsd).toBe(1.05);
    expect(settleTask({ taskId: "tsk_1", outcome: "cancelled_by_user", usage, estimate: { lowUsd: 0.1, highUsd: 0.9 } }).chargedUsd).toBe(0.9);
  });
  it("rejects usage from other tasks", () => {
    expect(() => settleTask({ taskId: "tsk_1", outcome: "succeeded", usage: [rec({ taskId: "tsk_2" })] })).toThrow(/tsk_2/);
    expect(() => settleTask({ taskId: "tsk_1", outcome: "maybe" as "succeeded", usage: [] })).toThrow();
  });
});

describe("SpendGuard", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  async function seeded() {
    const repo = new MemoryUsageRepo();
    await repo.insert([
      { ...rec({ costUsd: 4, agentId: "agt_1" }), id: "u1", at: "2026-11-02T00:00:00Z", userId: "usr_1" },
      { ...rec({ costUsd: 2, workspaceId: "ws_1" }), id: "u2", at: "2026-11-10T00:00:00Z", userId: "usr_2" },
      { ...rec({ costUsd: 100 }), id: "u3", at: "2026-10-31T23:59:59Z", userId: "usr_1" }, // previous period
      { ...rec({ costUsd: 50, workspaceId: "ws_9" }), id: "u4", at: "2026-11-05T00:00:00Z", userId: "usr_9" },
    ]);
    return repo;
  }
  it("computes spend this period at user-facing price per user, workspace and agent", async () => {
    const g = new SpendGuard(await seeded(), new StaticSpendCaps(), { now: () => now });
    expect(monthStartUtc(now).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(await g.spentThisPeriod({ userId: "usr_1", workspaceId: "ws_1", agentId: "agt_1" })).toEqual({ userUsd: 6, workspaceUsd: 9, agentUsd: 6 });
  });
  it("throws SPEND_CAP when a cap would be exceeded", async () => {
    const caps = new StaticSpendCaps({ users: { usr_1: 10 }, workspaces: { ws_1: 20 }, agents: { agt_1: 7 } });
    const g = new SpendGuard(await seeded(), caps, { now: () => now });
    const ok = await g.check({ userId: "usr_1", workspaceId: "ws_1" }, 3);
    expect(ok.remaining).toEqual({ agentUsd: null, userUsd: 1, workspaceUsd: 8 });
    await expect(g.check({ userId: "usr_1", workspaceId: "ws_1" }, 4.5)).rejects.toMatchObject({ code: "SPEND_CAP", details: { scope: "user", capUsd: 10, spentUsd: 6 } });
    await expect(g.check({ workspaceId: "ws_1", agentId: "agt_1" }, 1.5)).rejects.toMatchObject({ code: "SPEND_CAP", details: { scope: "agent" } });
    await expect(g.check({ workspaceId: "ws_1" }, 11.5)).rejects.toMatchObject({ code: "SPEND_CAP", details: { scope: "workspace" } });
    await expect(g.check({ workspaceId: "ws_1" }, -1)).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect((await new SpendGuard(await seeded(), new StaticSpendCaps(), { now: () => now }).check({ userId: "usr_1" }, 1000)).ok).toBe(true);
    const defaults = new SpendGuard(await seeded(), new StaticSpendCaps({ defaults: { workspaceUsd: 5 } }), { now: () => now });
    await expect(defaults.check({ workspaceId: "ws_1" }, 0)).rejects.toMatchObject({ code: "SPEND_CAP" });
  });
});

describe("UsageMeter", () => {
  it("persists records, holds task usage until settlement and forwards credits", async () => {
    const repo = new MemoryUsageRepo();
    const billing = new MockBillingProvider();
    const { customerId } = await billing.createCustomer({ workspaceId: "ws_1", email: "owner@example.com" });
    const meter = new UsageMeter({ repo, billing, customerFor: (ws) => (ws === "ws_1" ? customerId : undefined) });
    const llm = new MeteredLLM(new MockLLMProvider().on("x", () => "y".repeat(4000)), meter, { workspaceId: "ws_1", taskId: "tsk_a" });
    await llm.complete({ purpose: "x", model: "claude-sonnet-5-5", messages: [{ role: "user", content: "q".repeat(40_000) }] });
    expect(repo.rows.length).toBe(2);
    expect(billing.meterEvents.size).toBe(0); // held until settlement
    const totals = await meter.taskTotals("tsk_a");
    expect(totals.providerCostUsd).toBeCloseTo(llm.totalCostUsd, 4);
    const s = await meter.settle({ taskId: "tsk_a", outcome: "succeeded" });
    expect(s.chargedUsd).toBeCloseTo(llm.totalCostUsd * 1.5, 4);
    expect(billing.usageCredits(customerId)).toBe(usdToCredits(s.chargedUsd));
    expect(await meter.settle({ taskId: "tsk_a", outcome: "succeeded" })).toBe(s); // idempotent
    expect(billing.meterEvents.size).toBe(1);

    await meter.record(rec({ taskId: "tsk_b", costUsd: 3 }));
    const failed = await meter.settle({ taskId: "tsk_b", outcome: "failed_agent_error" });
    expect(failed.chargedUsd).toBe(0);
    expect(billing.meterEvents.size).toBe(1);

    // task-less usage (agent runs) forwards immediately, carrying fractions of a credit
    for (let i = 0; i < 3; i++) await meter.record({ kind: "agent_run", quantity: 1, costUsd: 0.0001, provider: "forge", workspaceId: "ws_1", agentId: "agt_1", taskId: undefined });
    // each run = 0.0001 + 0.002 fee = $0.0021 = 2.1 credits -> 2, 2, 2 (+0.3 carried)
    expect(billing.usageCredits(customerId)).toBe(usdToCredits(s.chargedUsd) + 6);
    expect((await meter.workspaceTotals("ws_1")).records).toBe(6);
    await expect(meter.record({ kind: "nope", quantity: 1, costUsd: 0, provider: "x" } as unknown as UsageRecord)).rejects.toThrow(/Invalid usage record/);
  });

  it("queues failed billing reports and retries on flush", async () => {
    const billing = new MockBillingProvider();
    let fail = true;
    const flaky = Object.assign(Object.create(billing) as MockBillingProvider, {
      reportUsage: async (r: Parameters<MockBillingProvider["reportUsage"]>[0]) => {
        if (fail) throw new Error("stripe down");
        return billing.reportUsage(r);
      },
    });
    const meter = new UsageMeter({ repo: new MemoryUsageRepo(), billing: flaky, customerFor: () => "cus_1" });
    await meter.record(rec({ taskId: "tsk_c", costUsd: 1 }));
    await meter.settle({ taskId: "tsk_c", outcome: "succeeded" });
    expect(meter.queued).toHaveLength(1);
    fail = false;
    expect(await meter.flush()).toBe(0);
    expect(billing.usageCredits("cus_1")).toBe(1500);
  });

  it("works as a plain UsageSink alongside MemoryUsageSink semantics", async () => {
    const sink = new MemoryUsageSink();
    const meter = new UsageMeter({ repo: new MemoryUsageRepo() });
    await meter.record(rec({ taskId: "tsk_d" }));
    sink.record(rec({ taskId: "tsk_d" }));
    expect((await meter.taskTotals("tsk_d")).providerCostUsd).toBe(sink.totalUsd());
  });
});
