import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { MockLLMProvider } from "@forge/llm";
import { InHouseAgentRunner, InMemoryMemoryStore, cronFromText, handleSlackEvent, mockDefinition, needsApproval, nextRuns, searchKnowledge, validateDefinition, verifySlackSignature, widgetScript, type RunContext, type ToolExecutor } from "../src/index.js";

const leads = [
  { name: "Anna Svensson", company: "Nordlys AB", createdAt: "2026-11-02" },
  { name: "Erik Lind", company: "Fjord Tech", createdAt: "2026-11-03" },
];

export const fakeTools: ToolExecutor & { executed: string[] } = {
  executed: [],
  async describe(ref) {
    return { description: `${ref.type} tool`, inputSchema: { type: "object", properties: { sinceDays: { type: "number" }, channel: { type: "string" }, text: { type: "string" } } } };
  },
  async execute(ref, input) {
    const name = ref.type === "integration" ? `${ref.app}__${ref.action}` : ref.type;
    this.executed.push(name);
    if (name === "hubspot__list_recent_leads") return { leads };
    if (name === "slack__post_message") return { ok: true, posted: input };
    return { ok: true };
  },
};

describe("definitions", () => {
  it("parses schedules from Swedish and English", () => {
    expect(cronFromText("Every Monday at 8, summarize leads")).toBe("0 8 * * 1");
    expect(cronFromText("varje fredag kl 16:30")).toBe("30 16 * * 5");
    expect(cronFromText("every weekday at 7am")).toBe("0 7 * * 1-5");
    expect(cronFromText("whenever I ask")).toBeNull();
  });
  it("generates the weekly HubSpot email agent with approval before sending", () => {
    const d = mockDefinition("Every Monday at 8, summarize new HubSpot leads from the past week and email the sales team.");
    const v = validateDefinition(d);
    expect(v.ok).toBe(true);
    expect(d.triggers[0]).toMatchObject({ type: "cron", cron: "0 8 * * 1", timezone: "Europe/Stockholm" });
    const send = d.tools.find((t) => t.type === "builtin" && t.name === "send_email")!;
    expect(needsApproval(d, send)).toBe(true);
    const next = nextRuns("0 8 * * 1", "Europe/Stockholm", 2, new Date("2026-11-05T12:00:00Z"));
    expect(next[0]!.toISOString()).toBe("2026-11-09T07:00:00.000Z");
  });
  it("rejects invalid cron", () => {
    const d = { ...mockDefinition("x"), triggers: [{ type: "cron", cron: "61 * * * *", timezone: "UTC" }] };
    expect(validateDefinition(d)).toMatchObject({ ok: false });
  });
});

function ctx(def = mockDefinition("Every Monday at 8, summarize new HubSpot leads and email the sales team"), emails: string[][] = []): RunContext {
  return {
    workspaceId: "ws",
    agentId: "agt",
    runId: "run",
    trigger: "cron",
    input: null,
    def: { ...def, recipients: ["sales@forge.test"] },
    tools: fakeTools,
    memory: new InMemoryMemoryStore(),
    email: { send: async (m) => (emails.push(m.to), { id: `m${emails.length}` }) },
  };
}

describe("in-house runner", () => {
  it("pauses before sending, then sends once approved", async () => {
    const runner = new InHouseAgentRunner(new MockLLMProvider());
    const emails: string[][] = [];
    const c = ctx(undefined, emails);
    const r = await runner.run(c);
    expect(r.status).toBe("awaiting_approval");
    expect(r.pending?.tool).toBe("send_email");
    expect(emails).toHaveLength(0);
    expect(r.log.map((l) => l.kind)).toEqual(expect.arrayContaining(["tool_call", "tool_result", "approval_requested"]));
    const done = await runner.resume(c, r.state!, { approved: true, by: "usr_1" });
    expect(done.status).toBe("succeeded");
    expect(emails).toEqual([["sales@forge.test"]]);
    expect(done.costUsd).toBeGreaterThan(r.costUsd);
  });
  it("does not send when rejected", async () => {
    const runner = new InHouseAgentRunner(new MockLLMProvider());
    const emails: string[][] = [];
    const c = ctx(undefined, emails);
    const r = await runner.run(c);
    const done = await runner.resume(c, r.state!, { approved: false });
    expect(done.status).toBe("succeeded");
    expect(emails).toHaveLength(0);
    expect(done.output).toMatch(/rejected/);
  });
  it("enforces the per-run cost cap", async () => {
    const runner = new InHouseAgentRunner(new MockLLMProvider());
    const c = ctx();
    c.def = { ...c.def, costCapUsdPerRun: 0.000001 };
    expect((await runner.run(c)).status).toBe("cost_capped");
  });
  it("Slack handbook agent answers in channel (auto-approved post)", async () => {
    const def = { ...mockDefinition("Create a Slack agent that answers questions about our company handbook in #help."), knowledge: [{ title: "Handbook", content: "Vacation: everyone has 30 days of paid vacation per year.\n\nExpenses: submit receipts within 30 days." }] };
    expect(def.approvals.autoApprove).toContain("slack__post_message");
    const c = { ...ctx(def), input: { text: "How many vacation days do I get?", channel: "C123" } };
    fakeTools.executed.length = 0;
    const r = await new InHouseAgentRunner(new MockLLMProvider()).run(c);
    expect(r.status).toBe("succeeded");
    expect(fakeTools.executed).toContain("slack__post_message");
    expect(searchKnowledge(def, "vacation days")[0]?.excerpt).toMatch(/30 days/);
  });
});

describe("channels", () => {
  it("verifies Slack signatures and maps events", () => {
    const secret = "s3cret";
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "<@U1> hi", channel: "C1", user: "U2", ts: "1.2" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
    expect(verifySlackSignature(secret, ts, body, sig)).toBe(true);
    expect(verifySlackSignature(secret, ts, body + "x", sig)).toBe(false);
    expect(verifySlackSignature(secret, String(Number(ts) - 1000), body, sig)).toBe(false);
    expect(handleSlackEvent(JSON.parse(body))).toEqual({ kind: "run", input: { text: "hi", channel: "C1", user: "U2", threadTs: "1.2" } });
    expect(handleSlackEvent({ type: "url_verification", challenge: "abc" })).toEqual({ kind: "challenge", challenge: "abc" });
    expect(handleSlackEvent({ type: "event_callback", event: { type: "message", bot_id: "B1", text: "x" } }).kind).toBe("ignore");
  });
  it("builds an accessible widget without secrets", () => {
    const js = widgetScript("https://api.forge.eu");
    expect(js).toContain("aria-live");
    expect(js).toContain("/v1/widget/");
    expect(js).not.toMatch(/secret|token/i);
  });
});
