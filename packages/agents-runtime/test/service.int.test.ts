import { describe, it, expect, afterAll } from "vitest";
import { connect, runMigrations, eq, users, workspaces, userAgents, agentRuns, approvals } from "@forge/db";
import { MockLLMProvider } from "@forge/llm";
import { newId } from "@forge/shared";
import { AgentService, DrizzleMemoryStore, InHouseAgentRunner, mockDefinition, type ToolExecutor } from "../src/index.js";

const h = connect(undefined, 3);
afterAll(() => h.close());

const tools: ToolExecutor = {
  describe: async () => ({ description: "x", inputSchema: { type: "object", properties: {} } }),
  execute: async () => ({ leads: [{ name: "Anna", company: "Nordlys AB" }] }),
};

async function setup(def = mockDefinition("Every Monday at 8, summarize new HubSpot leads from the past week and email the sales team.")) {
  await runMigrations();
  const ws = newId("ws");
  const agentId = newId("agt");
  await h.db.insert(users).values({ id: newId("usr"), email: `${ws}@t.local` });
  await h.db.insert(workspaces).values({ id: ws, name: "w" });
  await h.db.insert(userAgents).values({ id: agentId, workspaceId: ws, name: def.name, definition: { ...def, recipients: ["sales@forge.test"] } });
  return { ws, agentId };
}

describe("AgentService (Definition of Done #6)", () => {
  it("cron run asks for approval before sending, logs every tool call and cost, resumes after approval", async () => {
    const { agentId } = await setup();
    const sent: string[] = [];
    const svc = new AgentService({ db: h.db, runner: new InHouseAgentRunner(new MockLLMProvider()), tools, memory: new DrizzleMemoryStore(h.db), email: { send: async (m) => (sent.push(m.subject), { id: "1" }) } });
    const r = await svc.trigger(agentId, "cron", { firedAt: "2026-11-09T07:00:00Z" });
    expect(r.status).toBe("awaiting_approval");
    expect(r.approvalId).toBeTruthy();
    expect(sent).toHaveLength(0);
    const [run] = await h.db.select().from(agentRuns).where(eq(agentRuns.id, r.runId));
    expect(run?.trigger).toBe("cron");
    expect(run?.costUsd).toBeGreaterThan(0);
    const kinds = (run?.log as Array<{ kind: string; tool?: string }>).map((l) => `${l.kind}:${l.tool ?? ""}`);
    expect(kinds).toEqual(expect.arrayContaining(["tool_call:hubspot__list_recent_leads", "tool_result:hubspot__list_recent_leads", "approval_requested:send_email"]));
    await expect(svc.resume(r.runId)).rejects.toThrow(/not decided/);

    await h.db.update(approvals).set({ status: "approved", decidedBy: "usr_x", decidedAt: new Date() }).where(eq(approvals.id, r.approvalId!));
    const done = await svc.resume(r.runId);
    expect(done.status).toBe("succeeded");
    expect(sent).toEqual(["Weekly summary"]);
    const [after] = await h.db.select().from(agentRuns).where(eq(agentRuns.id, r.runId));
    expect((after?.log as Array<{ kind: string }>).some((l) => l.kind === "approval_decision")).toBe(true);
    expect(after?.endedAt).not.toBeNull();
    expect(after!.costUsd).toBeGreaterThan(run!.costUsd);
  });

  it("refuses paused agents and enforces the monthly cap; evals never execute irreversible actions", async () => {
    const { agentId } = await setup();
    const sent: string[] = [];
    const svc = new AgentService({ db: h.db, runner: new InHouseAgentRunner(new MockLLMProvider()), tools, memory: new DrizzleMemoryStore(h.db), email: { send: async (m) => (sent.push(m.subject), { id: "1" }) } });
    const evals = await svc.runEvals(agentId);
    expect(evals.every((e) => e.passed)).toBe(true);
    expect(sent).toHaveLength(0);
    await h.db.update(userAgents).set({ status: "paused" }).where(eq(userAgents.id, agentId));
    await expect(svc.trigger(agentId, "cron", null)).rejects.toThrow(/paused/);
    await h.db.update(userAgents).set({ status: "active", definition: { ...mockDefinition("x every day"), costCapUsdPerMonth: 0.0000001 } }).where(eq(userAgents.id, agentId));
    await h.db.insert(agentRuns).values({ id: newId("run"), agentId, version: 1, trigger: "manual", status: "succeeded", costUsd: 1 });
    await expect(svc.trigger(agentId, "manual", null)).rejects.toThrow(/Monthly cap/);
  });
});
