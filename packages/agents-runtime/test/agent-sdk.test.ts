import { describe, it, expect, vi } from "vitest";

const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, description: string, shape: unknown, handler: (a: Record<string, unknown>) => Promise<unknown>) => ({ name, description, shape, handler }),
  createSdkMcpServer: (o: { name: string; tools: unknown[] }) => ({ type: "sdk", name: o.name, tools: o.tools }),
  query: ({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
    calls.push({ prompt, options });
    return (async function* () {
      const server = (options.mcpServers as Record<string, { tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }> }>).forge!;
      if (!options.resume) {
        // Simulate Claude reading leads (allowed) and then trying to send (needs approval).
        await server.tools.find((t) => t.name === "hubspot__list_recent_leads")!.handler({ sinceDays: 7 });
        const canUse = options.canUseTool as (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }>;
        const d = await canUse("mcp__forge__send_email", { to: ["sales@forge.test"], subject: "Weekly", text: "x" });
        yield { type: "system", session_id: "sess_1" };
        yield { type: "result", subtype: d.behavior === "deny" ? "error_during_execution" : "success", total_cost_usd: 0.02, session_id: "sess_1" };
      } else {
        yield { type: "result", subtype: "success", result: "Sent the weekly summary.", total_cost_usd: 0.01, session_id: "sess_1" };
      }
    })();
  },
}));

const { ClaudeAgentSdkRunner, InHouseAgentRunner, InMemoryMemoryStore, mockDefinition } = await import("../src/index.js");
const { MockLLMProvider } = await import("@forge/llm");

describe("ClaudeAgentSdkRunner", () => {
  it("exposes Forge tools over MCP, disables built-ins, and pauses irreversible actions for approval", async () => {
    const sent: unknown[] = [];
    const executed: string[] = [];
    const def = { ...mockDefinition("Every Monday at 8, summarize new HubSpot leads and email the sales team"), recipients: ["sales@forge.test"] };
    const ctx = {
      workspaceId: "ws",
      agentId: "agt",
      runId: "run",
      trigger: "cron",
      input: null,
      def,
      tools: { describe: async () => ({ description: "d", inputSchema: { type: "object", properties: { sinceDays: { type: "number" } } } }), execute: async (r: { type: string }) => (executed.push(r.type), { leads: [] }) },
      memory: new InMemoryMemoryStore(),
      email: { send: async (m: unknown) => (sent.push(m), { id: "e1" }) },
    };
    const runner = new ClaudeAgentSdkRunner(new InHouseAgentRunner(new MockLLMProvider()));
    const r = await runner.run(ctx);
    expect(r.status).toBe("awaiting_approval");
    expect(r.pending?.tool).toBe("send_email");
    expect(sent).toHaveLength(0);
    expect(executed).toEqual(["integration"]);
    expect(calls[0]!.options.tools).toEqual([]);
    expect(calls[0]!.options.allowedTools).not.toContain("mcp__forge__send_email");
    const done = await runner.resume(ctx, r.state!, { approved: true });
    expect(done.status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    expect(calls[1]!.options.resume).toBe("sess_1");
    expect(done.costUsd).toBeCloseTo(0.03);
  });
});
