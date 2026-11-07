import { and, desc, eq, gte, sql, agentRuns, approvals, userAgents, agentMemory, type Db } from "@forge/db";
import { ForgeError, newId, type UsageSink } from "@forge/shared";
import { validateDefinition, type AgentDefinition, type EvalCase } from "./definition.js";
import type { AgentRunner, RunContext, RunResult, RunState } from "./runner.js";
import type { EmailPort, LogEntry, MemoryStore, ToolExecutor } from "./ports.js";

export class DrizzleMemoryStore implements MemoryStore {
  constructor(private readonly db: Db) {}
  async get(agentId: string, key: string) {
    const [r] = await this.db.select().from(agentMemory).where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, key)));
    return r?.value ?? null;
  }
  async set(agentId: string, key: string, value: unknown) {
    await this.db.insert(agentMemory).values({ agentId, key, value: value as object }).onConflictDoUpdate({ target: [agentMemory.agentId, agentMemory.key], set: { value: value as object, updatedAt: new Date() } });
  }
  async count(agentId: string) {
    const [r] = await this.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(agentMemory).where(eq(agentMemory.agentId, agentId));
    return r?.n ?? 0;
  }
}

export interface AgentFailureAlert {
  (a: { agentId: string; runId: string; workspaceId: string; reason: string }): Promise<void> | void;
}

export interface AgentServiceDeps {
  db: Db;
  runner: AgentRunner;
  tools: ToolExecutor;
  memory: MemoryStore;
  email?: EmailPort;
  usage?: UsageSink;
  onFailure?: AgentFailureAlert;
  /** Called when a run pauses for approval (e.g. notify the workspace). */
  onApprovalRequested?: (a: { approvalId: string; agentId: string; workspaceId: string; action: string }) => Promise<void> | void;
  /** Company knowledge for the run (workspace profile + passages relevant to the input). */
  knowledge?: (workspaceId: string, query: string) => Promise<string>;
}

export interface RunRecord {
  runId: string;
  status: string;
  costUsd: number;
  output: string;
  approvalId?: string;
}

/** Persists agent runs, approvals, logs and cost; enforces pause/resume, monthly caps and failure alerts. */
export class AgentService {
  constructor(private readonly d: AgentServiceDeps) {}

  private async load(agentId: string) {
    const [a] = await this.d.db.select().from(userAgents).where(eq(userAgents.id, agentId));
    if (!a) throw new ForgeError("NOT_FOUND", "Agent not found");
    const v = validateDefinition(a.definition);
    if (!v.ok) throw new ForgeError("BAD_INPUT", `Stored agent definition is invalid: ${v.error}`);
    return { agent: a, def: v.definition };
  }

  async monthSpend(agentId: string): Promise<number> {
    const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [r] = await this.d.db.select({ s: sql<number>`coalesce(sum(${agentRuns.costUsd}),0)`.mapWith(Number) }).from(agentRuns).where(and(eq(agentRuns.agentId, agentId), gte(agentRuns.startedAt, start)));
    return r?.s ?? 0;
  }

  private ctx(agent: { id: string; workspaceId: string }, def: AgentDefinition, runId: string, trigger: string, input: unknown, companyKnowledge?: string): RunContext {
    return { workspaceId: agent.workspaceId, agentId: agent.id, runId, trigger, input, def, tools: this.d.tools, memory: this.d.memory, email: this.d.email, ...(companyKnowledge ? { companyKnowledge } : {}) };
  }

  private async knowledgeFor(workspaceId: string, def: AgentDefinition, input: unknown): Promise<string | undefined> {
    if (!this.d.knowledge) return undefined;
    const q = `${def.name} ${def.instructions.slice(0, 400)} ${typeof input === "string" ? input : JSON.stringify(input ?? "")}`.slice(0, 2000);
    return (await this.d.knowledge(workspaceId, q).catch(() => "")) || undefined;
  }

  private async persist(runId: string, agent: { id: string; workspaceId: string }, r: RunResult, prevLog: LogEntry[] = []): Promise<RunRecord> {
    const status = r.status === "cost_capped" ? "failed" : r.status;
    await this.d.db
      .update(agentRuns)
      .set({ status, log: [...prevLog, ...r.log], state: r.state as object | null, output: r.output, costUsd: r.costUsd, endedAt: status === "awaiting_approval" ? null : new Date() })
      .where(eq(agentRuns.id, runId));
    this.d.usage?.record({ kind: "agent_run", quantity: 1, costUsd: r.costUsd, provider: this.d.runner.name, agentId: agent.id, workspaceId: agent.workspaceId });
    let approvalId: string | undefined;
    if (r.status === "awaiting_approval" && r.pending) {
      approvalId = newId("apv");
      await this.d.db.insert(approvals).values({ id: approvalId, workspaceId: agent.workspaceId, agentRunId: runId, action: r.pending.tool, payload: { input: r.pending.input as object, preview: r.output.slice(0, 2000) } });
      await this.d.onApprovalRequested?.({ approvalId, agentId: agent.id, workspaceId: agent.workspaceId, action: r.pending.tool });
    }
    if (r.status === "failed" || r.status === "cost_capped") await this.d.onFailure?.({ agentId: agent.id, runId, workspaceId: agent.workspaceId, reason: r.status === "cost_capped" ? "cost cap reached" : r.output || "run failed" });
    return { runId, status, costUsd: r.costUsd, output: r.output, approvalId };
  }

  /** Start a run for a trigger (cron, webhook, email, chat, manual, test). */
  async trigger(agentId: string, trigger: string, input: unknown): Promise<RunRecord> {
    const { agent, def } = await this.load(agentId);
    if (agent.status !== "active" && trigger !== "test") throw new ForgeError("FORBIDDEN", "Agent is paused");
    const spent = await this.monthSpend(agentId);
    if (spent >= def.costCapUsdPerMonth) throw new ForgeError("SPEND_CAP", `Monthly cap of $${def.costCapUsdPerMonth} reached for this agent`);
    const runId = newId("run");
    await this.d.db.insert(agentRuns).values({ id: runId, agentId, version: agent.version, trigger, status: "running", input: input as object });
    try {
      return await this.persist(runId, agent, await this.d.runner.run(this.ctx(agent, def, runId, trigger, input, await this.knowledgeFor(agent.workspaceId, def, input))));
    } catch (e) {
      const r: RunResult = { status: "failed", output: (e as Error).message, costUsd: 0, log: [{ at: new Date().toISOString(), kind: "error", message: (e as Error).message }], state: null, pending: null, toolsCalled: [] };
      return this.persist(runId, agent, r);
    }
  }

  /** Continue a run after its approval was decided (approvals.status approved/rejected). */
  async resume(runId: string): Promise<RunRecord> {
    const [run] = await this.d.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    if (!run) throw new ForgeError("NOT_FOUND", "Run not found");
    if (run.status !== "awaiting_approval" || !run.state) throw new ForgeError("BAD_INPUT", "Run is not waiting for approval");
    const [ap] = await this.d.db.select().from(approvals).where(eq(approvals.agentRunId, runId)).orderBy(desc(approvals.createdAt)).limit(1);
    if (!ap || ap.status === "pending") throw new ForgeError("APPROVAL_REQUIRED", "Approval not decided yet");
    const { agent, def } = await this.load(run.agentId);
    await this.d.db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, runId));
    const r = await this.d.runner.resume(this.ctx(agent, def, runId, run.trigger, run.input, await this.knowledgeFor(agent.workspaceId, def, run.input)), run.state as RunState, { approved: ap.status === "approved", by: ap.decidedBy ?? undefined });
    return this.persist(runId, agent, r, run.log as LogEntry[]);
  }

  /**
   * Evals run with a dry-run tool executor: irreversible actions are never executed — reaching one
   * counts as "requires approval".
   */
  async runEvals(agentId: string): Promise<Array<{ name: string; passed: boolean; failures: string[]; costUsd: number }>> {
    const { agent, def } = await this.load(agentId);
    const out = [];
    for (const c of def.evals) out.push(await this.evalCase(agent, def, c));
    return out;
  }

  private async evalCase(agent: { id: string; workspaceId: string }, def: AgentDefinition, c: EvalCase) {
    // Dry run: nothing irreversible executes during evals, not even auto-approved actions.
    const dry: AgentDefinition = { ...def, approvals: { ...def.approvals, autoApprove: [], requireFor: ["send", "pay", "delete", "post", "update"] } };
    const r = await this.d.runner.run(this.ctx(agent, dry, `eval_${newId("r", 6)}`, "test", c.input));
    const failures: string[] = [];
    for (const s of c.expect.outputContains) if (!r.output.toLowerCase().includes(s.toLowerCase())) failures.push(`output missing "${s}"`);
    for (const t of c.expect.toolsCalled) if (t && !r.toolsCalled.includes(t)) failures.push(`expected tool ${t}`);
    for (const t of c.expect.toolsNotCalled) if (r.toolsCalled.includes(t)) failures.push(`unexpected tool ${t}`);
    if (c.expect.requiresApproval !== undefined && (r.status === "awaiting_approval") !== c.expect.requiresApproval) failures.push(`approval expected=${c.expect.requiresApproval} got=${r.status}`);
    return { name: c.name, passed: failures.length === 0, failures, costUsd: r.costUsd };
  }
}
