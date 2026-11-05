import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getModels } from "@forge/llm";
import { needsApproval, toolName, type ToolRef } from "../definition.js";
import type { AgentRunner, RunContext, RunResult, RunState } from "../runner.js";
import { systemPrompt, InHouseAgentRunner } from "../runner.js";
import type { LogEntry, PendingCall } from "../ports.js";

const SERVER = "forge";

/** Top-level JSON-schema properties → permissive zod shape (validation stays in the executor). */
function shapeFrom(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const props = (schema.properties ?? {}) as Record<string, { description?: string }>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(props)) {
    const base = z.any().describe(v.description ?? k);
    shape[k] = required.has(k) ? base : base.optional();
  }
  return shape;
}

interface SdkState extends RunState {
  sessionId?: string;
}

/**
 * Runs user agents on the Claude Agent SDK. Forge tools are exposed through an in-process MCP server;
 * Claude Code's built-in tools are disabled. `canUseTool` intercepts irreversible actions: the call is
 * denied with interrupt, recorded as pending, and on approval Forge executes it and resumes the session.
 */
export class ClaudeAgentSdkRunner implements AgentRunner {
  readonly name = "claude-agent-sdk";
  /** Reuses the in-house tool executor for built-ins and integrations. */
  private readonly exec: InHouseAgentRunner;
  constructor(exec: InHouseAgentRunner) {
    this.exec = exec;
  }

  private async tools(ctx: RunContext) {
    const out: Array<{ name: string; ref: ToolRef; description: string; schema: Record<string, unknown> }> = [];
    for (const ref of ctx.def.tools) {
      const d = ref.type === "builtin" ? { description: `Forge built-in ${ref.name}`, inputSchema: { type: "object", properties: {} } } : await ctx.tools.describe(ref);
      out.push({ name: toolName(ref), ref, description: d.description, schema: d.inputSchema });
    }
    return out;
  }

  private async drive(ctx: RunContext, prompt: string, resumeSession: string | undefined, log: LogEntry[], prior: number): Promise<RunResult> {
    const defs = await this.tools(ctx);
    let pending: PendingCall | null = null;
    const server = createSdkMcpServer({
      name: SERVER,
      version: "1.0.0",
      tools: defs.map((d) =>
        tool(d.name, d.description, shapeFrom(d.schema), async (args: Record<string, unknown>) => {
          log.push({ at: new Date().toISOString(), kind: "tool_call", tool: d.name, input: args });
          try {
            const out = await this.exec.executeTool(ctx, d.ref, args);
            log.push({ at: new Date().toISOString(), kind: "tool_result", tool: d.name, ok: true, output: out.slice(0, 2000) });
            return { content: [{ type: "text" as const, text: out }] };
          } catch (e) {
            log.push({ at: new Date().toISOString(), kind: "tool_result", tool: d.name, ok: false, output: (e as Error).message });
            return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
          }
        }),
      ),
    });
    const model = ctx.def.modelTier === "fast" ? getModels().fast : ctx.def.modelTier === "planner" ? getModels().planner : getModels().builder;
    const q = query({
      prompt,
      options: {
        model,
        systemPrompt: systemPrompt(ctx),
        mcpServers: { [SERVER]: server },
        tools: [],
        allowedTools: defs.filter((d) => !needsApproval(ctx.def, d.ref)).map((d) => `mcp__${SERVER}__${d.name}`),
        maxTurns: 20,
        maxBudgetUsd: Math.max(0.01, ctx.def.costCapUsdPerRun - prior),
        persistSession: true,
        ...(resumeSession ? { resume: resumeSession } : {}),
        canUseTool: async (name: string, input: Record<string, unknown>) => {
          const d = defs.find((x) => `mcp__${SERVER}__${x.name}` === name);
          if (!d) return { behavior: "deny" as const, message: "Tool not allowed for this agent" };
          if (needsApproval(ctx.def, d.ref)) {
            pending = { toolUseId: name, tool: d.name, input };
            log.push({ at: new Date().toISOString(), kind: "approval_requested", tool: d.name, input });
            return { behavior: "deny" as const, message: "Paused: this irreversible action is waiting for human approval.", interrupt: true };
          }
          return { behavior: "allow" as const, updatedInput: input };
        },
      },
    });
    let sessionId = resumeSession;
    let output = "";
    let costUsd = prior;
    let failed = false;
    for await (const m of q) {
      const msg = m as { type: string; session_id?: string; subtype?: string; result?: string; total_cost_usd?: number };
      if (msg.session_id) sessionId = msg.session_id;
      if (msg.type === "result") {
        costUsd = prior + (msg.total_cost_usd ?? 0);
        if (msg.subtype === "success") output = msg.result ?? "";
        else failed = !pending;
      }
    }
    log.push({ at: new Date().toISOString(), kind: "model", costUsd: costUsd - prior, message: "agent sdk session" });
    if (pending) {
      const state: SdkState = { messages: [], pending, pendingSiblings: [], costUsd, turns: 0, sessionId };
      return { status: "awaiting_approval", output, costUsd, log, state, pending, toolsCalled: log.filter((l) => l.kind === "tool_call").map((l) => l.tool!) };
    }
    if (costUsd > ctx.def.costCapUsdPerRun) return { status: "cost_capped", output, costUsd, log, state: null, pending: null, toolsCalled: [] };
    return { status: failed ? "failed" : "succeeded", output, costUsd, log, state: null, pending: null, toolsCalled: log.filter((l) => l.kind === "tool_call").map((l) => l.tool!) };
  }

  run(ctx: RunContext): Promise<RunResult> {
    const prompt = `Trigger: ${ctx.trigger}\nTime: ${new Date().toISOString()}\nInput:\n${JSON.stringify(ctx.input ?? null, null, 2)}`;
    return this.drive(ctx, prompt, undefined, [{ at: new Date().toISOString(), kind: "start", message: `trigger=${ctx.trigger} runner=agent-sdk` }], 0);
  }

  async resume(ctx: RunContext, state: RunState, decision: { approved: boolean; by?: string }): Promise<RunResult> {
    const s = state as SdkState;
    const log: LogEntry[] = [{ at: new Date().toISOString(), kind: "approval_decision", tool: s.pending?.tool, message: decision.approved ? "approved" : "rejected" }];
    let note = "The pending action was rejected by the user. Do not retry it; finish with your report.";
    if (decision.approved && s.pending) {
      const ref = ctx.def.tools.find((t) => toolName(t) === s.pending!.tool);
      if (ref) {
        const out = await this.exec.executeTool(ctx, ref, s.pending.input as Record<string, unknown>);
        log.push({ at: new Date().toISOString(), kind: "tool_result", tool: s.pending.tool, ok: true, output: out.slice(0, 2000) });
        note = `The user approved ${s.pending.tool}; Forge executed it. Result: ${out.slice(0, 4000)}\nContinue and finish with your report.`;
      }
    }
    return this.drive(ctx, note, s.sessionId, log, s.costUsd);
  }
}
