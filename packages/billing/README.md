# @forge/billing

Plans, user-facing pricing, pre-work cost estimates, task settlement (no charge for agent errors),
spending caps, usage metering and the billing provider (Stripe or an in-memory mock ledger).

## Public API

```ts
// Plans
PLANS: Record<"free"|"pro"|"team"|"enterprise", Plan>   // monthlyUsd, includedCreditUsd, overage, limits, features
getPlan(id), planHasFeature(id, f), requireFeature(id, f) /* FORBIDDEN */, checkLimit(id, limit, current) /* RATE_LIMITED */

// Pricing
priceUsage(record) / priceRecords(records)   // user-facing USD
MARKUP, PLATFORM_FEE, PROVIDER_UNIT_COST, userUnitPrice(kind), usdToCredits(usd), USD_PER_CREDIT

// Estimates (shown before work starts)
estimateTask({ intents, complexity?, mediaSeconds?, images?, slides?, models? }): CostEstimate   // alias: estimate()

// Settlement
settleTask({ taskId, outcome, usage, estimate?, capToEstimate? }): Settlement
  // outcome: "succeeded" | "failed_agent_error" | "failed_provider" | "cancelled_by_user"

// Spending caps
new SpendGuard(usageRepo, capSource, { now?, periodStart? })
guard.spentThisPeriod({ userId?, workspaceId?, agentId? })
guard.check(subject, projectedUsd)            // throws ForgeError("SPEND_CAP", ..., { scope, id, capUsd, spentUsd, projectedUsd })
StaticSpendCaps, DrizzleSpendCapSource(db)    // users.spend_cap_usd, workspaces.spend_cap_usd, user_agents.definition.spendCapUsd
MemoryUsageRepo, DrizzleUsageRepo(db)         // usage_records (user filter joins tasks.user_id)

// Metering + provider
new UsageMeter({ repo, billing?, customerFor?, userIdFor? })   // implements UsageSink
meter.record(r), meter.settle({ taskId, outcome, estimate? }), meter.taskTotals(id), meter.workspaceTotals(ws, since?), meter.flush()
interface BillingProvider { createCustomer, createCheckoutSession, createPortalSession, reportUsage, parseWebhook }
createBillingProvider()                       // BILLING_PROVIDER=stripe|mock
```

### Pricing formula
```
priceUsd = providerCostUsd × (1 + MARKUP[kind]) + quantity × PLATFORM_FEE[kind]
```
Linear, so it applies exactly to per-kind aggregates (spend caps, settlement). Markups: LLM tokens 50%,
sandbox 100%, media/images 30%, transcription/bots 50%, hosting 100%; agent runs carry a $0.002/run
platform fee. `providerCostUsd` is the real cost on each `UsageRecord`; `PROVIDER_UNIT_COST` (with cited
vendor list prices in `src/pricing.ts`) is only used for estimates. Credits sent to the billing provider are
integers of $0.001.

### Estimates
Per-intent heuristic token budgets (`BUDGETS`: plan → build loop with ~80% cached context → review) ×
`costFor()` of the env-configured models (`getModels()`: planner/builder/fast/vision) × markup, plus sandbox
minutes, images (default 4), generated video seconds (default 10; Remotion = composition code + sandbox
render), slides (default 10). Complexity factor trivial 0.4 / normal 1 / complex 2.5; the band is
±25% / ±35% / ±50%. Typical normal-complexity highs with default models: app ≈ $3.3, website ≈ $2.9,
backend ≈ $1.6, 10 s video ≈ $1.9, 10 slides ≈ $0.7, 4 images ≈ $0.2, question ≈ $0.002.

### Settlement policy
| outcome | charge |
|---|---|
| `succeeded` | list price, capped at the quoted `estimate.highUsd` (the user never pays above the high end they accepted) |
| `failed_agent_error` (loop guard hit / gates never pass) | **0** — Forge absorbs the cost |
| `failed_provider` (upstream outage after retries) | **0** — Forge absorbs the cost |
| `cancelled_by_user` | consumed work **at provider cost, no markup**, capped at `estimate.highUsd` |

`UsageMeter` holds task usage until `settle()` (so failed tasks are never reported to Stripe), reports the
charge once per task (idempotency key `task_<id>`), forwards task-less usage (agent runs, hosting, bots)
immediately while carrying fractional credits, and queues failed reports for `flush()` so billing outages
never break the metered LLM/sandbox call.

### Spend caps
Spend = user-facing price of usage metered in the current period (calendar month, UTC). A user's spend is
the usage of tasks they created (`tasks.user_id`); workspace and agent spend use the record's ids. `check()`
evaluates agent → user → workspace caps and throws `SPEND_CAP` with details for the UI.

## Providers

| Adapter | Real / mock | Env vars |
|---|---|---|
| `StripeBillingProvider` (official `stripe` SDK: Customers, Checkout subscription, Customer Portal, `billing.meterEvents.create`, `webhooks.constructEvent`) | real | `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`*, `STRIPE_PRICE_TEAM`*, `STRIPE_PRICE_ENTERPRISE`*, `STRIPE_PRICE_USAGE`*, `STRIPE_METER_EVENT_NAME`* (default `forge_credits`), `STRIPE_AUTOMATIC_TAX`* |
| `MockBillingProvider` (in-memory ledger, HMAC-signed mock webhooks, deduped meter events) | mock (default) | `BILLING_PROVIDER=mock`, `BILLING_MOCK_WEBHOOK_SECRET`*, `APP_URL` |

\* new env vars (not yet in `.env.example`). Stripe setup: one recurring price per paid plan, one billing
meter with event name `forge_credits` (sum aggregation, payload `stripe_customer_id` + `value`) and a metered
price of $0.001/unit attached to it (`STRIPE_PRICE_USAGE`), added as a second checkout line item.

## Tests
- Unit: plans, pricing, estimates (budgets × `costFor`, complexity, models, media units), settlement for all
  outcomes, SpendGuard (period, per-scope caps), UsageMeter (MeteredLLM → meter → settle → mock ledger,
  retries), Stripe adapter via `vi.mock("stripe")`, mock webhook signing/verification.
- Integration (`test:integration`, docker Postgres): `DrizzleUsageRepo` + `UsageMeter` + `SpendGuard` with
  `DrizzleSpendCapSource` (user caps via tasks join, workspace caps, agent caps from the definition JSON).

## Limitations
- Included plan credit is not netted here: configure it as a Stripe credit grant (or apply it in the API layer).
- Spend caps count metered usage at list price, including usage of tasks later settled at $0 (conservative).
- Usage without a task id and without a workspace id is persisted but never billed.
- Estimates are heuristics; `settleTask` caps successful charges at the quoted high estimate to protect users.
- Seat counts for Team are passed at checkout; seat changes go through the Stripe portal.
