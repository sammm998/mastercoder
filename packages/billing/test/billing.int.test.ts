import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, runMigrations, users, workspaces, projects, tasks, userAgents, usageRecords, eq, type DbHandle } from "@forge/db";
import { DrizzleSpendCapSource, DrizzleUsageRepo, MockBillingProvider, SpendGuard, UsageMeter } from "../src/index.js";

let h: DbHandle;
const run = `b${Date.now().toString(36)}`;
const ids = { user: `usr_${run}`, other: `usr_${run}_2`, ws: `ws_${run}`, prj: `prj_${run}`, t1: `tsk_${run}_1`, t2: `tsk_${run}_2`, agent: `agt_${run}` };

beforeAll(async () => {
  await runMigrations();
  h = connect();
  await h.db.insert(users).values([
    { id: ids.user, email: `${ids.user}@test.local`, spendCapUsd: 5 },
    { id: ids.other, email: `${ids.other}@test.local` },
  ]);
  await h.db.insert(workspaces).values({ id: ids.ws, name: "Billing int", spendCapUsd: 50 });
  await h.db.insert(projects).values({ id: ids.prj, workspaceId: ids.ws, name: "P", createdBy: ids.user });
  await h.db.insert(tasks).values([
    { id: ids.t1, projectId: ids.prj, userId: ids.user, prompt: "build" },
    { id: ids.t2, projectId: ids.prj, userId: ids.other, prompt: "build 2" },
  ]);
  await h.db.insert(userAgents).values({ id: ids.agent, workspaceId: ids.ws, name: "Weekly", definition: { spendCapUsd: 1 } });
});

afterAll(async () => {
  await h.db.delete(usageRecords).where(eq(usageRecords.workspaceId, ids.ws));
  await h.db.delete(workspaces).where(eq(workspaces.id, ids.ws));
  await h.db.delete(users).where(eq(users.id, ids.user));
  await h.db.delete(users).where(eq(users.id, ids.other));
  await h.close();
});

describe("billing on Postgres", () => {
  it("meters into usage_records, aggregates and enforces caps", async () => {
    const repo = new DrizzleUsageRepo(h.db);
    const billing = new MockBillingProvider();
    const { customerId } = await billing.createCustomer({ workspaceId: ids.ws, email: "x@example.com" });
    const meter = new UsageMeter({ repo, billing, customerFor: () => customerId });
    await meter.record({ kind: "llm_output_tokens", quantity: 200_000, costUsd: 2, provider: "anthropic", model: "claude-sonnet-5-5", workspaceId: ids.ws, projectId: ids.prj, taskId: ids.t1 });
    await meter.record({ kind: "sandbox_minutes", quantity: 20, costUsd: 0.0552, provider: "e2b", workspaceId: ids.ws, projectId: ids.prj, taskId: ids.t1 });
    await meter.record({ kind: "llm_input_tokens", quantity: 1_000_000, costUsd: 2, provider: "anthropic", workspaceId: ids.ws, projectId: ids.prj, taskId: ids.t2 });
    await meter.record({ kind: "agent_run", quantity: 1, costUsd: 0.4, provider: "forge", workspaceId: ids.ws, agentId: ids.agent });

    const t1 = await repo.aggregate({ taskId: ids.t1 });
    expect(t1.map((a) => a.kind).sort()).toEqual(["llm_output_tokens", "sandbox_minutes"]);
    expect((await repo.list({ workspaceId: ids.ws })).length).toBe(4);
    const settlement = await meter.settle({ taskId: ids.t1, outcome: "succeeded" });
    expect(settlement.chargedUsd).toBeCloseTo(3 + 0.1104, 4);
    expect(billing.usageCredits(customerId)).toBe(3110 + 402); // task charge + agent run (0.4 * 1 + 0.002 fee)

    const guard = new SpendGuard(repo, new DrizzleSpendCapSource(h.db));
    const spent = await guard.spentThisPeriod({ userId: ids.user, workspaceId: ids.ws, agentId: ids.agent });
    expect(spent.userUsd).toBeCloseTo(3.1104, 4); // only tasks created by this user
    expect(spent.workspaceUsd).toBeCloseTo(3.1104 + 3 + 0.402, 4);
    expect(spent.agentUsd).toBeCloseTo(0.402, 4);
    expect((await guard.check({ userId: ids.user, workspaceId: ids.ws }, 1)).remaining.userUsd).toBeCloseTo(5 - 4.1104, 4);
    await expect(guard.check({ userId: ids.user, workspaceId: ids.ws }, 2)).rejects.toMatchObject({ code: "SPEND_CAP", details: { scope: "user", capUsd: 5 } });
    await expect(guard.check({ workspaceId: ids.ws, agentId: ids.agent }, 0.7)).rejects.toMatchObject({ code: "SPEND_CAP", details: { scope: "agent", capUsd: 1 } });
    await expect(guard.check({ workspaceId: ids.ws }, 45)).rejects.toMatchObject({ code: "SPEND_CAP", details: { scope: "workspace", capUsd: 50 } });
    const nextMonth = new SpendGuard(repo, new DrizzleSpendCapSource(h.db), { now: () => new Date(Date.now() + 40 * 86_400_000) });
    expect((await nextMonth.spentThisPeriod({ workspaceId: ids.ws })).workspaceUsd).toBe(0);
  });
});
