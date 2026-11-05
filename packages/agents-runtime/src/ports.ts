import type { ToolRef } from "./definition.js";

/** Executes integration/OpenAPI/MCP tools for an agent (backed by @forge/integrations). */
export interface ToolExecutor {
  describe(ref: ToolRef): Promise<{ description: string; inputSchema: Record<string, unknown> }>;
  execute(ref: ToolRef, input: unknown, ctx: { workspaceId: string; agentId: string }): Promise<unknown>;
}

export interface EmailPort {
  send(msg: { to: string[]; subject: string; text: string }): Promise<{ id: string }>;
}

export interface MemoryStore {
  get(agentId: string, key: string): Promise<unknown>;
  set(agentId: string, key: string, value: unknown): Promise<void>;
  count(agentId: string): Promise<number>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private m = new Map<string, unknown>();
  async get(agentId: string, key: string) {
    return this.m.get(`${agentId}:${key}`) ?? null;
  }
  async set(agentId: string, key: string, value: unknown) {
    this.m.set(`${agentId}:${key}`, value);
  }
  async count(agentId: string) {
    return [...this.m.keys()].filter((k) => k.startsWith(`${agentId}:`)).length;
  }
}

export interface PendingCall {
  toolUseId: string;
  tool: string;
  input: unknown;
}

export interface LogEntry {
  at: string;
  kind: "start" | "model" | "tool_call" | "tool_result" | "approval_requested" | "approval_decision" | "output" | "error" | "cost_cap";
  tool?: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
  costUsd?: number;
  message?: string;
}
