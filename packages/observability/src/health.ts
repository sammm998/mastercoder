import { desc, gte, providerHealth, sql, usageRecords, type Db } from "@forge/db";
import { newId, selectAdapter } from "@forge/shared";

export interface HealthCheck {
  provider: string;
  kind: "llm" | "sandbox" | "media" | "stt" | "meeting-bot" | "connector" | "billing" | "deploy" | "storage" | "db" | "queue";
  /** Resolve when healthy, throw when not. Must be cheap (no billable calls). */
  check(): Promise<void>;
}

export interface HealthResult {
  provider: string;
  kind: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function runHealthChecks(checks: HealthCheck[], timeoutMs = 5000): Promise<HealthResult[]> {
  return Promise.all(
    checks.map(async (c) => {
      const start = Date.now();
      try {
        await Promise.race([c.check(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs))]);
        return { provider: c.provider, kind: c.kind, ok: true, latencyMs: Date.now() - start };
      } catch (e) {
        return { provider: c.provider, kind: c.kind, ok: false, latencyMs: Date.now() - start, error: (e as Error).message.slice(0, 500) };
      }
    }),
  );
}

export async function recordHealth(db: Db, results: HealthResult[]): Promise<void> {
  if (!results.length) return;
  await db.insert(providerHealth).values(results.map((r) => ({ id: newId("hc"), provider: r.provider, kind: r.kind, ok: r.ok, latencyMs: r.latencyMs, error: r.error ?? null })));
}

/** HTTP reachability check for vendor status/health endpoints (no auth, no cost). */
export function httpCheck(provider: string, kind: HealthCheck["kind"], url: string): HealthCheck {
  return {
    provider,
    kind,
    async check() {
      const r = await fetch(url, { method: "GET" });
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    },
  };
}

export interface Alert {
  severity: "warning" | "critical";
  kind: "provider_down" | "cost_spike" | "agent_failure";
  title: string;
  details: Record<string, unknown>;
}

export interface AlertSink {
  readonly name: string;
  send(a: Alert): Promise<void>;
}

/** Slack (or any compatible) incoming webhook. */
export class WebhookAlertSink implements AlertSink {
  readonly name = "webhook";
  constructor(private readonly url: string) {}
  async send(a: Alert) {
    const r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `[${a.severity.toUpperCase()}] ${a.title}\n\`\`\`${JSON.stringify(a.details, null, 2)}\`\`\`` }) });
    if (!r.ok) throw new Error(`alert webhook ${r.status}`);
  }
}

export class MockAlertSink implements AlertSink {
  readonly name = "mock";
  readonly sent: Alert[] = [];
  async send(a: Alert) {
    this.sent.push(a);
  }
}

export function createAlertSink(): AlertSink {
  const url = process.env.ALERT_WEBHOOK_URL;
  return selectAdapter<AlertSink>("ALERT_PROVIDER", { webhook: () => new WebhookAlertSink(url ?? ""), mock: () => new MockAlertSink() }, url ? "webhook" : "mock").instance;
}

/** Provider is "down" when its last `n` checks all failed. */
export async function providersDown(db: Db, n = 3): Promise<string[]> {
  const rows = await db.select().from(providerHealth).where(gte(providerHealth.checkedAt, new Date(Date.now() - 3600_000))).orderBy(desc(providerHealth.checkedAt));
  const byProvider = new Map<string, boolean[]>();
  for (const r of rows) {
    const list = byProvider.get(r.provider) ?? [];
    if (list.length < n) list.push(r.ok);
    byProvider.set(r.provider, list);
  }
  return [...byProvider.entries()].filter(([, oks]) => oks.length >= n && oks.every((o) => !o)).map(([p]) => p);
}

/**
 * Cost spike: today's spend per provider vs the trailing 7-day daily mean. Flags when today exceeds
 * `factor` x the mean and an absolute floor (to ignore noise on tiny numbers).
 */
export function detectSpikes(daily: Array<{ day: string; provider: string; costUsd: number }>, today: string, factor = 2, floorUsd = 5): Array<{ provider: string; todayUsd: number; meanUsd: number }> {
  const providers = new Set(daily.map((d) => d.provider));
  const out: Array<{ provider: string; todayUsd: number; meanUsd: number }> = [];
  for (const p of providers) {
    const rows = daily.filter((d) => d.provider === p);
    const t = rows.filter((d) => d.day === today).reduce((a, d) => a + d.costUsd, 0);
    const prior = rows.filter((d) => d.day < today).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 7);
    const mean = prior.length ? prior.reduce((a, d) => a + d.costUsd, 0) / 7 : 0;
    if (t >= floorUsd && t > factor * Math.max(mean, 0.01)) out.push({ provider: p, todayUsd: t, meanUsd: mean });
  }
  return out;
}

export async function dailyCosts(db: Db, days = 8) {
  const day = sql<string>`to_char(date_trunc('day', ${usageRecords.at}), 'YYYY-MM-DD')`;
  return db
    .select({ day, provider: usageRecords.provider, costUsd: sql<number>`sum(${usageRecords.costUsd})`.mapWith(Number) })
    .from(usageRecords)
    .where(gte(usageRecords.at, new Date(Date.now() - days * 86400_000)))
    .groupBy(day, usageRecords.provider);
}

/** One monitoring tick: run checks, persist, alert on down providers and cost spikes. */
export async function monitorTick(db: Db, checks: HealthCheck[], alerts: AlertSink): Promise<{ results: HealthResult[]; down: string[]; spikes: ReturnType<typeof detectSpikes> }> {
  const results = await runHealthChecks(checks);
  await recordHealth(db, results);
  const down = await providersDown(db);
  for (const p of down) await alerts.send({ severity: "critical", kind: "provider_down", title: `Provider ${p} is failing health checks`, details: { provider: p } });
  const today = new Date().toISOString().slice(0, 10);
  const spikes = detectSpikes(await dailyCosts(db), today);
  for (const s of spikes) await alerts.send({ severity: "warning", kind: "cost_spike", title: `Cost spike on ${s.provider}`, details: s });
  return { results, down, spikes };
}
