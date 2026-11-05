import { eq, tasks, usageRecords, type Db } from "@forge/db";
import { settleTask } from "@forge/billing";
import type { Settler } from "./runtime.js";

/** Billing policy from @forge/billing: no charge on agent/provider failure, capped at the quoted estimate. */
export function billingSettler(db: Db): Settler {
  return async ({ taskId, outcome }) => {
    const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.taskId, taskId));
    const s = settleTask({
      taskId,
      outcome: outcome as Parameters<typeof settleTask>[0]["outcome"],
      usage: usage.map((u) => ({ kind: u.kind as never, quantity: u.quantity, costUsd: u.costUsd, provider: u.provider, taskId })),
      estimate: t?.estimateHighUsd ? { lowUsd: t.estimateLowUsd ?? 0, highUsd: t.estimateHighUsd, breakdown: [] } : undefined,
    } as Parameters<typeof settleTask>[0]);
    return { charged: s.charged, chargedUsd: s.chargedUsd };
  };
}
