import { getModels, textOf, toolUses, type ChatMessage, type ContentBlock, type LLMProvider, type ToolDef } from "@forge/llm";
import { needsApproval, toolName, type AgentDefinition, type ToolRef } from "./definition.js";
import type { EmailPort, LogEntry, MemoryStore, PendingCall, ToolExecutor } from "./ports.js";

export interface RunContext {
  workspaceId: string;
  agentId: string;
  runId: string;
  trigger: string;
  input: unknown;
  def: AgentDefinition;
  tools: ToolExecutor;
  memory: MemoryStore;
  email?: EmailPort;
  /** Knowledge search over def.knowledge (handbooks etc.). */
  now?: () => Date;
}

export interface RunState {
  messages: ChatMessage[];
  pending: PendingCall | null;
  /** Results for the other calls of the turn that contained the pending call. */
  pendingSiblings: Array<{ toolUseId: string; content: string; isError: boolean }>;
  costUsd: number;
  turns: number;
}

export type RunStatus = "succeeded" | "awaiting_approval" | "failed" | "cost_capped";

export interface RunResult {
  status: RunStatus;
  output: string;
  costUsd: number;
  log: LogEntry[];
  state: RunState | null;
  pending: PendingCall | null;
  toolsCalled: string[];
}

export interface AgentRunner {
  readonly name: string;
  run(ctx: RunContext): Promise<RunResult>;
  /** Continue a run paused for approval. `approved=false` tells the model the action was rejected. */
  resume(ctx: RunContext, state: RunState, decision: { approved: boolean; by?: string }): Promise<RunResult>;
}

const BUILTINS: Record<string, ToolDef> = {
  memory_get: { name: "memory_get", description: "Read a value from this agent's long-term memory.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  memory_set: { name: "memory_set", description: "Store a value in this agent's long-term memory (e.g. last processed id).", inputSchema: { type: "object", properties: { key: { type: "string" }, value: {} }, required: ["key", "value"] } },
  send_email: {
    name: "send_email",
    description: "Send an email. Irreversible: requires human approval unless allowed.",
    inputSchema: { type: "object", properties: { to: { type: "array", items: { type: "string" } }, subject: { type: "string" }, text: { type: "string" } }, required: ["to", "subject", "text"] },
  },
  http_get: { name: "http_get", description: "GET a public https URL and return its text (first 20k chars).", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  current_time: { name: "current_time", description: "Current date and time (ISO, Europe/Stockholm).", inputSchema: { type: "object", properties: {} } },
  knowledge_search: { name: "knowledge_search", description: "Search the agent's knowledge base (handbook, docs).", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
};

export function systemPrompt(ctx: RunContext): string {
  const d = ctx.def;
  return [
    `You are "${d.name}", an autonomous agent built with Forge.`,
    d.instructions,
    d.recipients.length ? `Default recipients: ${d.recipients.join(", ")}` : "",
    `Irreversible actions (sending, posting, paying, deleting) may pause for human approval; if an action is rejected, do not retry it — explain what you would have done.`,
    `Finish with a short plain-text report of what you did.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function isPrivateHost(host: string): boolean {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?|metadata\.google\.internal)/i.test(host);
}

/** Search knowledge snippets by keyword overlap. */
export function searchKnowledge(def: AgentDefinition, query: string, k = 3): Array<{ title: string; excerpt: string }> {
  const terms = query.toLowerCase().split(/[^a-zåäö0-9]+/).filter((t) => t.length > 2);
  return def.knowledge
    .flatMap((doc) => doc.content.split(/\n{2,}/).map((p) => ({ title: doc.title, excerpt: p.trim() })))
    .map((p) => ({ ...p, score: terms.reduce((a, t) => a + (p.excerpt.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ title, excerpt }) => ({ title, excerpt }));
}

/**
 * Forge's own agent loop over any LLMProvider (Anthropic, OpenAI or the offline mock). Intercepts
 * irreversible tool calls for approval, enforces the per-run cost cap and logs every tool call.
 */
export class InHouseAgentRunner implements AgentRunner {
  readonly name = "inhouse";
  constructor(
    private readonly llm: LLMProvider,
    private readonly maxTurns = 20,
  ) {}

  private async toolDefs(ctx: RunContext): Promise<Array<{ def: ToolDef; ref: ToolRef }>> {
    const out: Array<{ def: ToolDef; ref: ToolRef }> = [];
    for (const ref of ctx.def.tools) {
      if (ref.type === "builtin") {
        out.push({ def: BUILTINS[ref.name]!, ref });
      } else {
        const d = await ctx.tools.describe(ref);
        out.push({ def: { name: toolName(ref), description: d.description, inputSchema: d.inputSchema }, ref });
      }
    }
    if (ctx.def.memory.enabled && !out.some((t) => t.def.name === "memory_get")) {
      out.push({ def: BUILTINS.memory_get!, ref: { type: "builtin", name: "memory_get" } }, { def: BUILTINS.memory_set!, ref: { type: "builtin", name: "memory_set" } });
    }
    return out;
  }

  /** Execute one tool (used by this loop and by the Claude Agent SDK runner's MCP bridge). */
  executeTool(ctx: RunContext, ref: ToolRef, input: Record<string, unknown>): Promise<string> {
    return this.exec(ctx, ref, input);
  }

  private async exec(ctx: RunContext, ref: ToolRef, input: Record<string, unknown>): Promise<string> {
    if (ref.type !== "builtin") return JSON.stringify(await ctx.tools.execute(ref, input, { workspaceId: ctx.workspaceId, agentId: ctx.agentId }));
    switch (ref.name) {
      case "memory_get":
        return JSON.stringify(await ctx.memory.get(ctx.agentId, String(input.key)));
      case "memory_set":
        if ((await ctx.memory.count(ctx.agentId)) >= ctx.def.memory.maxKeys) throw new Error("Memory is full");
        await ctx.memory.set(ctx.agentId, String(input.key), input.value);
        return "stored";
      case "send_email": {
        if (!ctx.email) throw new Error("Email is not configured");
        const to = Array.isArray(input.to) ? input.to.map(String) : [String(input.to)];
        const r = await ctx.email.send({ to, subject: String(input.subject), text: String(input.text) });
        return `sent (${r.id})`;
      }
      case "http_get": {
        const u = new URL(String(input.url));
        if (u.protocol !== "https:" || isPrivateHost(u.hostname)) throw new Error("Only public https URLs are allowed");
        const r = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        return (await r.text()).slice(0, 20_000);
      }
      case "current_time":
        return (ctx.now?.() ?? new Date()).toISOString();
      case "knowledge_search":
        return JSON.stringify(searchKnowledge(ctx.def, String(input.query)));
    }
  }

  async run(ctx: RunContext): Promise<RunResult> {
    const state: RunState = {
      messages: [{ role: "user", content: `Trigger: ${ctx.trigger}\nTime: ${(ctx.now?.() ?? new Date()).toISOString()}\nInput:\n${JSON.stringify(ctx.input ?? null, null, 2)}` }],
      pending: null,
      pendingSiblings: [],
      costUsd: 0,
      turns: 0,
    };
    return this.loop(ctx, state, [{ at: new Date().toISOString(), kind: "start", message: `trigger=${ctx.trigger}` }]);
  }

  async resume(ctx: RunContext, state: RunState, decision: { approved: boolean; by?: string }): Promise<RunResult> {
    const log: LogEntry[] = [{ at: new Date().toISOString(), kind: "approval_decision", tool: state.pending?.tool, message: decision.approved ? `approved by ${decision.by ?? "user"}` : `rejected by ${decision.by ?? "user"}` }];
    if (!state.pending) return this.loop(ctx, state, log);
    const tools = await this.toolDefs(ctx);
    const t = tools.find((x) => x.def.name === state.pending!.tool);
    let content: string;
    let isError = false;
    if (!decision.approved) {
      content = "The user REJECTED this action. Do not retry it.";
      isError = true;
    } else if (!t) {
      content = `Tool ${state.pending.tool} is no longer available`;
      isError = true;
    } else {
      try {
        content = await this.exec(ctx, t.ref, state.pending.input as Record<string, unknown>);
        log.push({ at: new Date().toISOString(), kind: "tool_result", tool: t.def.name, ok: true, output: content.slice(0, 2000) });
      } catch (e) {
        content = (e as Error).message;
        isError = true;
        log.push({ at: new Date().toISOString(), kind: "tool_result", tool: t.def.name, ok: false, output: content });
      }
    }
    const results: ContentBlock[] = [
      ...state.pendingSiblings.map((s): ContentBlock => ({ type: "tool_result", toolUseId: s.toolUseId, content: s.content, isError: s.isError })),
      { type: "tool_result", toolUseId: state.pending.toolUseId, content, isError },
    ];
    const next: RunState = { ...state, messages: [...state.messages, { role: "user", content: results }], pending: null, pendingSiblings: [] };
    return this.loop(ctx, next, log);
  }

  private async loop(ctx: RunContext, state: RunState, log: LogEntry[]): Promise<RunResult> {
    const tools = await this.toolDefs(ctx);
    const model = ctx.def.modelTier === "fast" ? getModels().fast : ctx.def.modelTier === "planner" ? getModels().planner : getModels().builder;
    const called = new Set<string>();
    let output = "";
    const now = () => new Date().toISOString();
    while (state.turns < this.maxTurns) {
      state.turns++;
      const r = await this.llm.complete({ purpose: "agents.run", model, system: systemPrompt(ctx), messages: state.messages, tools: tools.map((t) => t.def), cache: true, maxTokens: 8000 });
      state.costUsd += r.costUsd;
      log.push({ at: now(), kind: "model", costUsd: r.costUsd, message: `turn ${state.turns}` });
      state.messages.push({ role: "assistant", content: r.content });
      const text = textOf(r).trim();
      if (text) output = text;
      if (state.costUsd > ctx.def.costCapUsdPerRun) {
        log.push({ at: now(), kind: "cost_cap", message: `Run cost $${state.costUsd.toFixed(4)} exceeded cap $${ctx.def.costCapUsdPerRun}` });
        return { status: "cost_capped", output, costUsd: state.costUsd, log, state: null, pending: null, toolsCalled: [...called] };
      }
      const calls = toolUses(r);
      if (!calls.length || r.stopReason !== "tool_use") break;
      const results: Array<{ toolUseId: string; content: string; isError: boolean }> = [];
      let pending: PendingCall | null = null;
      for (const c of calls) {
        const t = tools.find((x) => x.def.name === c.name);
        log.push({ at: now(), kind: "tool_call", tool: c.name, input: c.input });
        called.add(c.name);
        if (!t) {
          results.push({ toolUseId: c.id, content: `Unknown tool ${c.name}`, isError: true });
          continue;
        }
        if (!pending && needsApproval(ctx.def, t.ref)) {
          pending = { toolUseId: c.id, tool: c.name, input: c.input };
          log.push({ at: now(), kind: "approval_requested", tool: c.name, input: c.input });
          continue;
        }
        if (pending && needsApproval(ctx.def, t.ref)) {
          results.push({ toolUseId: c.id, content: "Only one irreversible action can be approved at a time; request it again after the current one.", isError: true });
          continue;
        }
        try {
          const out = await this.exec(ctx, t.ref, (c.input ?? {}) as Record<string, unknown>);
          results.push({ toolUseId: c.id, content: out, isError: false });
          log.push({ at: now(), kind: "tool_result", tool: c.name, ok: true, output: out.slice(0, 2000) });
        } catch (e) {
          results.push({ toolUseId: c.id, content: (e as Error).message, isError: true });
          log.push({ at: now(), kind: "tool_result", tool: c.name, ok: false, output: (e as Error).message });
        }
      }
      if (pending) {
        const paused: RunState = { ...state, pending, pendingSiblings: results };
        return { status: "awaiting_approval", output, costUsd: state.costUsd, log, state: paused, pending, toolsCalled: [...called] };
      }
      state.messages.push({ role: "user", content: results.map((x): ContentBlock => ({ type: "tool_result", toolUseId: x.toolUseId, content: x.content, isError: x.isError })) });
    }
    log.push({ at: now(), kind: "output", output: output.slice(0, 4000) });
    return { status: "succeeded", output, costUsd: state.costUsd, log, state: null, pending: null, toolsCalled: [...called] };
  }
}
