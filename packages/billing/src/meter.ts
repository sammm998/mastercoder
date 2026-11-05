import { ForgeError, UsageRecordSchema, createLogger, newId, round4, type CostEstimate, type UsageRecord, type UsageSink } from "@forge/shared";
import { priceRecords, priceUsage, USD_PER_CREDIT } from "./pricing.js";
import { settleTask, type Settlement, type TaskOutcome } from "./settle.js";
import type { BillingProvider, UsageReport } from "./provider.js";
import type { StoredUsage, UsageFilter, UsageRepo } from "./usage-repo.js";

export interface UsageMeterOptions {
  repo: UsageRepo;
  billing?: BillingProvider;
  /** Billing customer for a workspace (e.g. workspaces.stripe_customer_id); undefined = not billable. */
  customerFor?: (workspaceId: string) => Promise<string | undefined> | string | undefined;
  /** Attach the task owner to records (in-memory repo user filters). */
  userIdFor?: (r: UsageRecord) => string | undefined;
}

export interface UsageTotals {
  records: number;
  providerCostUsd: number;
  listPriceUsd: number;
}

const log = createLogger({ pkg: "billing", component: "usage-meter" });

/**
 * UsageSink that persists every record, aggregates per task/workspace and forwards billable quantities
 * to the BillingProvider as integer credits ($0.001):
 * - usage without a task (agent runs, hosting, bots) is forwarded as it arrives (fractions carried over);
 * - task usage is held until `settle()`, which applies the outcome policy (no charge for agent errors)
 *   and reports the charged amount once (idempotency key `task_<id>`).
 * Billing failures never break the metered call: reports are queued and retried by `flush()`.
 */
export class UsageMeter implements UsageSink {
  private readonly carry = new Map<string, number>();
  private readonly pending: UsageReport[] = [];
  private readonly settled = new Map<string, Settlement>();

  constructor(private readonly opts: UsageMeterOptions) {}

  async record(r: UsageRecord): Promise<void> {
    const parsed = UsageRecordSchema.safeParse(r);
    if (!parsed.success) throw new ForgeError("BAD_INPUT", `Invalid usage record: ${parsed.error.message}`);
    const userId = this.opts.userIdFor?.(parsed.data);
    const row: StoredUsage = { ...parsed.data, id: newId("use"), at: parsed.data.at ?? new Date().toISOString(), ...(userId ? { userId } : {}) };
    await this.opts.repo.insert([row]);
    if (!row.taskId && row.workspaceId) await this.forward(row.workspaceId, priceUsage(row), row.id, true);
  }

  /** Settle a finished task: applies the outcome policy and reports the charge. Idempotent per task. */
  async settle(input: { taskId: string; outcome: TaskOutcome; estimate?: Pick<CostEstimate, "lowUsd" | "highUsd"> }): Promise<Settlement> {
    const done = this.settled.get(input.taskId);
    if (done) return done;
    const usage = await this.opts.repo.list({ taskId: input.taskId });
    const s = settleTask({ taskId: input.taskId, outcome: input.outcome, usage, ...(input.estimate ? { estimate: input.estimate } : {}) });
    this.settled.set(input.taskId, s);
    const ws = usage.find((u) => u.workspaceId)?.workspaceId;
    if (s.chargedUsd > 0 && ws) await this.forward(ws, s.chargedUsd, `task_${input.taskId}`, false);
    return s;
  }

  async taskTotals(taskId: string): Promise<UsageTotals> {
    return this.totals({ taskId });
  }

  async workspaceTotals(workspaceId: string, since?: Date): Promise<UsageTotals> {
    return this.totals({ workspaceId, ...(since ? { since } : {}) });
  }

  private async totals(f: UsageFilter): Promise<UsageTotals> {
    const rows = await this.opts.repo.list(f);
    return { records: rows.length, providerCostUsd: round4(rows.reduce((a, r) => a + r.costUsd, 0)), listPriceUsd: priceRecords(rows) };
  }

  /** Reports that failed earlier and are waiting for retry. */
  get queued(): readonly UsageReport[] {
    return this.pending;
  }

  /** Retry queued reports; returns how many are still pending. */
  async flush(): Promise<number> {
    const batch = this.pending.splice(0);
    for (const r of batch) await this.send(r);
    return this.pending.length;
  }

  private async forward(workspaceId: string, usd: number, identifier: string, carryFractions: boolean): Promise<void> {
    if (!this.opts.billing || usd <= 0) return;
    const customerId = await this.opts.customerFor?.(workspaceId);
    if (!customerId) return;
    let credits: number;
    if (carryFractions) {
      const acc = (this.carry.get(customerId) ?? 0) + usd / USD_PER_CREDIT;
      credits = Math.floor(acc + 1e-9);
      this.carry.set(customerId, acc - credits);
    } else credits = Math.round(usd / USD_PER_CREDIT);
    if (credits <= 0) return;
    await this.send({ customerId, credits, identifier, timestamp: new Date() });
  }

  private async send(r: UsageReport): Promise<void> {
    try {
      await this.opts.billing!.reportUsage(r);
    } catch (e) {
      log.warn("usage report failed; queued for retry", { identifier: r.identifier, error: (e as Error).message });
      this.pending.push(r);
    }
  }
}
