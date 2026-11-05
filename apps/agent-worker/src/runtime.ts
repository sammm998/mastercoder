import type { Redis } from "ioredis";
import { eq, events as eventsTable, tasks, usageRecords, type Db } from "@forge/db";
import { ForgeEventSchema, eventChannel, newId, type EventSink, type ForgeEvent, type ForgeEventInput, type UsageRecord, type UsageSink } from "@forge/shared";

/** Persists every usage record to usage_records (the billing source of truth). */
export class DbUsageSink implements UsageSink {
  readonly pending: Promise<unknown>[] = [];
  constructor(
    private readonly db: Db,
    private readonly defaults: Partial<UsageRecord> = {},
  ) {}
  record(r: UsageRecord): void {
    const row = { ...this.defaults, ...r };
    this.pending.push(
      this.db.insert(usageRecords).values({
        id: newId("use"),
        workspaceId: row.workspaceId ?? null,
        projectId: row.projectId ?? null,
        taskId: row.taskId ?? null,
        agentId: row.agentId ?? null,
        kind: row.kind,
        quantity: row.quantity,
        costUsd: row.costUsd,
        provider: row.provider,
        model: row.model ?? null,
      }),
    );
  }
  async flush(): Promise<void> {
    await Promise.all(this.pending.splice(0));
  }
  withDefaults(d: Partial<UsageRecord>): DbUsageSink {
    return new DbUsageSink(this.db, { ...this.defaults, ...d });
  }
}

/**
 * Event sink used by workers: assigns ids, persists durable events and publishes to Redis so the
 * API's WebSocket gateway streams them to browsers. emit() is synchronous for callers; writes are
 * chained to preserve order.
 */
export class WorkerEventSink implements EventSink {
  private chain: Promise<void> = Promise.resolve();
  private listeners = new Set<(e: ForgeEvent) => void>();
  constructor(
    private readonly db: Db,
    private readonly redis: Redis | null,
  ) {}
  /** Optional rewrite before persisting/publishing (e.g. internal preview URL → signed public proxy link). */
  transform: ((e: ForgeEventInput) => ForgeEventInput) | null = null;
  emit(raw: ForgeEventInput): void {
    const input = this.transform ? this.transform(raw) : raw;
    const parsed = ForgeEventSchema.safeParse({ ...input, id: newId("evt", 8), at: new Date().toISOString() });
    if (!parsed.success) return;
    const e = parsed.data;
    for (const l of this.listeners) l(e);
    this.chain = this.chain
      .then(async () => {
        if (e.type !== "message.delta" && e.type !== "presence") {
          await this.db.insert(eventsTable).values({ id: e.id, projectId: e.projectId, taskId: e.taskId ?? null, type: e.type, payload: e, at: new Date(e.at) });
        }
        if (this.redis) await this.redis.publish(eventChannel(e.projectId), JSON.stringify(e));
      })
      .catch(() => undefined);
  }
  onEvent(fn: (e: ForgeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async flush(): Promise<void> {
    await this.chain;
  }
}

export type TaskOutcome = "succeeded" | "failed_agent_error" | "failed_provider" | "cancelled_by_user" | "awaiting_approval";

export interface Settlement {
  chargedUsd: number;
  charged: boolean;
}

/** Billing policy hook (from @forge/billing). Default: charge provider cost only for successful tasks. */
export type Settler = (input: { taskId: string; outcome: TaskOutcome; costUsd: number }) => Promise<Settlement> | Settlement;

export const defaultSettler: Settler = ({ outcome, costUsd }) =>
  outcome === "succeeded" ? { charged: true, chargedUsd: Math.round(costUsd * 1.25 * 10000) / 10000 } : { charged: false, chargedUsd: 0 };

export async function markTaskRunning(db: Db, taskId: string): Promise<void> {
  await db.update(tasks).set({ status: "running", startedAt: new Date() }).where(eq(tasks.id, taskId));
}

export async function settleTask(db: Db, settle: Settler, input: { taskId: string; outcome: TaskOutcome; costUsd: number; reason?: string; spec?: unknown }): Promise<Settlement> {
  if (input.outcome === "awaiting_approval") {
    await db.update(tasks).set({ status: "awaiting_approval", spec: input.spec ?? null, costUsd: input.costUsd }).where(eq(tasks.id, input.taskId));
    return { charged: false, chargedUsd: 0 };
  }
  const s = await settle(input);
  const status = input.outcome === "succeeded" ? "succeeded" : input.outcome === "cancelled_by_user" ? "cancelled" : "failed";
  await db
    .update(tasks)
    .set({ status, costUsd: input.costUsd, chargedUsd: s.chargedUsd, charged: s.charged, failureReason: input.reason ?? null, completedAt: new Date(), ...(input.spec ? { spec: input.spec } : {}) })
    .where(eq(tasks.id, input.taskId));
  return s;
}
