import { UsageKind, type UsageRecord } from "@forge/shared";
import { usageRecords, tasks, and, eq, gte, lte, sql, asc, type Db } from "@forge/db";

export interface StoredUsage extends UsageRecord {
  id: string;
  at: string;
  /** Owner of the task (in Postgres resolved through tasks.user_id; stored inline in memory). */
  userId?: string;
}

export interface UsageFilter {
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  agentId?: string;
  /** Usage of tasks created by this user. */
  userId?: string;
  since?: Date;
  until?: Date;
}

export interface UsageAggregate {
  kind: UsageKind;
  quantity: number;
  costUsd: number;
}

export interface UsageRepo {
  insert(rows: StoredUsage[]): Promise<void>;
  aggregate(f: UsageFilter): Promise<UsageAggregate[]>;
  list(f: UsageFilter, limit?: number): Promise<StoredUsage[]>;
}

function matches(r: StoredUsage, f: UsageFilter): boolean {
  if (f.workspaceId && r.workspaceId !== f.workspaceId) return false;
  if (f.projectId && r.projectId !== f.projectId) return false;
  if (f.taskId && r.taskId !== f.taskId) return false;
  if (f.agentId && r.agentId !== f.agentId) return false;
  if (f.userId && r.userId !== f.userId) return false;
  const t = Date.parse(r.at);
  if (f.since && t < f.since.getTime()) return false;
  if (f.until && t > f.until.getTime()) return false;
  return true;
}

function group(rows: Array<Pick<StoredUsage, "kind" | "quantity" | "costUsd">>): UsageAggregate[] {
  const m = new Map<UsageKind, UsageAggregate>();
  for (const r of rows) {
    const a = m.get(r.kind) ?? { kind: r.kind, quantity: 0, costUsd: 0 };
    a.quantity += r.quantity;
    a.costUsd += r.costUsd;
    m.set(r.kind, a);
  }
  return [...m.values()];
}

export class MemoryUsageRepo implements UsageRepo {
  readonly rows: StoredUsage[] = [];
  async insert(rows: StoredUsage[]): Promise<void> {
    this.rows.push(...rows.map((r) => ({ ...r })));
  }
  async aggregate(f: UsageFilter): Promise<UsageAggregate[]> {
    return group(this.rows.filter((r) => matches(r, f)));
  }
  async list(f: UsageFilter, limit = 10_000): Promise<StoredUsage[]> {
    return this.rows.filter((r) => matches(r, f)).slice(0, limit);
  }
}

/** UsageRepo on the `usage_records` table; user filters join `tasks` (usage_records has no user column). */
export class DrizzleUsageRepo implements UsageRepo {
  constructor(private readonly db: Db) {}

  async insert(rows: StoredUsage[]): Promise<void> {
    if (!rows.length) return;
    await this.db.insert(usageRecords).values(
      rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId ?? null,
        projectId: r.projectId ?? null,
        taskId: r.taskId ?? null,
        agentId: r.agentId ?? null,
        kind: r.kind,
        quantity: r.quantity,
        costUsd: r.costUsd,
        provider: r.provider,
        model: r.model ?? null,
        at: new Date(r.at),
      })),
    );
  }

  private where(f: UsageFilter) {
    const c = [];
    if (f.workspaceId) c.push(eq(usageRecords.workspaceId, f.workspaceId));
    if (f.projectId) c.push(eq(usageRecords.projectId, f.projectId));
    if (f.taskId) c.push(eq(usageRecords.taskId, f.taskId));
    if (f.agentId) c.push(eq(usageRecords.agentId, f.agentId));
    if (f.userId) c.push(eq(tasks.userId, f.userId));
    if (f.since) c.push(gte(usageRecords.at, f.since));
    if (f.until) c.push(lte(usageRecords.at, f.until));
    return c.length ? and(...c) : undefined;
  }

  async aggregate(f: UsageFilter): Promise<UsageAggregate[]> {
    const base = this.db
      .select({ kind: usageRecords.kind, quantity: sql<number>`coalesce(sum(${usageRecords.quantity}), 0)::float8`, costUsd: sql<number>`coalesce(sum(${usageRecords.costUsd}), 0)::float8` })
      .from(usageRecords);
    const q = f.userId ? base.innerJoin(tasks, eq(tasks.id, usageRecords.taskId)) : base;
    const rows = await q.where(this.where(f)).groupBy(usageRecords.kind);
    return rows.map((r) => ({ kind: UsageKind.parse(r.kind), quantity: Number(r.quantity), costUsd: Number(r.costUsd) }));
  }

  async list(f: UsageFilter, limit = 10_000): Promise<StoredUsage[]> {
    const base = this.db.select({ u: usageRecords }).from(usageRecords);
    const q = f.userId ? base.innerJoin(tasks, eq(tasks.id, usageRecords.taskId)) : base;
    const rows = await q.where(this.where(f)).orderBy(asc(usageRecords.at)).limit(limit);
    return rows.map(({ u }) => ({
      id: u.id,
      kind: UsageKind.parse(u.kind),
      quantity: u.quantity,
      costUsd: u.costUsd,
      provider: u.provider,
      ...(u.model ? { model: u.model } : {}),
      ...(u.workspaceId ? { workspaceId: u.workspaceId } : {}),
      ...(u.projectId ? { projectId: u.projectId } : {}),
      ...(u.taskId ? { taskId: u.taskId } : {}),
      ...(u.agentId ? { agentId: u.agentId } : {}),
      at: u.at.toISOString(),
    }));
  }
}
