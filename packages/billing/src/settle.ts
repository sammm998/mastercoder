import { z } from "zod";
import { ForgeError, round4, type CostEstimate, type UsageKind, type UsageRecord } from "@forge/shared";
import { priceFor } from "./pricing.js";

export const TaskOutcome = z.enum(["succeeded", "failed_agent_error", "failed_provider", "cancelled_by_user"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

export interface SettleInput {
  taskId: string;
  outcome: TaskOutcome;
  usage: UsageRecord[];
  /** Estimate shown to the user before the task started; caps the charge (see policy). */
  estimate?: Pick<CostEstimate, "lowUsd" | "highUsd">;
  /** Cap the charge at estimate.highUsd (default true when an estimate is given). */
  capToEstimate?: boolean;
}

export interface Settlement {
  taskId: string;
  outcome: TaskOutcome;
  charged: boolean;
  chargedUsd: number;
  /** What Forge paid providers. */
  providerCostUsd: number;
  /** Full user-facing price of the usage (before outcome policy and cap). */
  listPriceUsd: number;
  policy: string;
  lines: Array<{ kind: UsageKind; quantity: number; costUsd: number; priceUsd: number }>;
}

/**
 * Settlement policy (what the user pays when a task ends):
 * - succeeded: list price of the metered usage (pricing.ts formula), capped at the quoted estimate.highUsd —
 *   the user never pays more than the high end of the estimate they accepted.
 * - failed_agent_error (loop guard hit, quality gates never passed): no charge. Forge absorbs the cost.
 * - failed_provider (upstream LLM/media/sandbox outage after retries): no charge; Forge absorbs the cost.
 * - cancelled_by_user: partial charge = provider cost of the work consumed until cancellation, WITHOUT markup,
 *   capped at estimate.highUsd. The user pays only what was really spent on their behalf.
 */
export function settleTask(input: SettleInput): Settlement {
  const outcome = TaskOutcome.parse(input.outcome);
  const foreign = input.usage.find((r) => r.taskId !== undefined && r.taskId !== input.taskId);
  if (foreign) throw new ForgeError("BAD_INPUT", `Usage record for task ${foreign.taskId} passed to settlement of ${input.taskId}`);
  const byKind = new Map<UsageKind, { quantity: number; costUsd: number }>();
  for (const r of input.usage) {
    const a = byKind.get(r.kind) ?? { quantity: 0, costUsd: 0 };
    a.quantity += r.quantity;
    a.costUsd += r.costUsd;
    byKind.set(r.kind, a);
  }
  const lines = [...byKind.entries()].map(([kind, a]) => ({ kind, quantity: a.quantity, costUsd: round4(a.costUsd), priceUsd: round4(priceFor(kind, a.costUsd, a.quantity)) }));
  const providerCost = [...byKind.values()].reduce((s, a) => s + a.costUsd, 0);
  const listPrice = [...byKind.entries()].reduce((s, [k, a]) => s + priceFor(k, a.costUsd, a.quantity), 0);
  const cap = input.estimate && (input.capToEstimate ?? true) ? input.estimate.highUsd : Infinity;
  let charged = 0;
  let policy: string;
  switch (outcome) {
    case "succeeded":
      charged = Math.min(listPrice, cap);
      policy = charged < listPrice ? "succeeded: list price capped at the quoted estimate" : "succeeded: list price";
      break;
    case "failed_agent_error":
      policy = "no charge: the agent failed (loop guard or quality gates never passed)";
      break;
    case "failed_provider":
      policy = "no charge: an upstream provider failed; Forge absorbs the cost";
      break;
    case "cancelled_by_user":
      charged = Math.min(providerCost, cap);
      policy = "cancelled by user: consumed work at provider cost (no markup), capped at the quoted estimate";
      break;
  }
  const chargedUsd = round4(charged);
  return { taskId: input.taskId, outcome, charged: chargedUsd > 0, chargedUsd, providerCostUsd: round4(providerCost), listPriceUsd: round4(listPrice), policy, lines };
}
