"use client";
import Link from "next/link";
import { formatUsdPrecise } from "@/lib/chart";
import { pivotDaily, spikeReport } from "@/lib/costs";
import { healthState } from "@/lib/health";
import { S } from "@/lib/strings";
import { trpc } from "@/lib/trpc";
import { Badge, PageHead, QueryState } from "@/components/ui";

export function OverviewView() {
  const stats = trpc.admin.stats.useQuery(undefined, { refetchInterval: 30_000 });
  const costs = trpc.admin.costs.useQuery({ days: 8 });
  const health = trpc.admin.providerHealth.useQuery();

  const daily = costs.data ? pivotDaily(costs.data, { days: 8 }) : null;
  const spike = daily ? spikeReport(daily) : null;
  const failing = (health.data ?? []).filter((r) => healthState(r) === "failing");
  const s = stats.data;
  const failPct = s && s.tasks24h > 0 ? `${((s.failedTasks24h / s.tasks24h) * 100).toFixed(1)}%` : "0%";

  return (
    <>
      <PageHead title={S.overview.title} />
      <QueryState isLoading={stats.isLoading} error={stats.error} onRetry={() => void stats.refetch()} />
      {s ? (
        <section aria-label={S.overview.title} className="grid tiles">
          <Tile label={S.overview.users} value={s.users} href="/users" />
          <Tile label={S.overview.workspaces} value={s.workspaces} />
          <Tile label={S.overview.projects} value={s.projects} href="/projects" />
          <Tile label={S.overview.tasks24h} value={s.tasks24h} />
          <Tile
            label={S.overview.failedTasks24h}
            value={s.failedTasks24h}
            sub={S.overview.failureRate(failPct)}
            tone={s.failedTasks24h > 0 && s.tasks24h > 0 && s.failedTasks24h / s.tasks24h > 0.2 ? "critical" : undefined}
          />
          <Tile label={S.overview.agentRuns24h} value={s.agentRuns24h} />
          <Tile
            label={S.overview.openAbuse}
            value={s.openAbuse}
            href="/abuse"
            sub={s.openAbuse > 0 ? S.overview.reviewQueue : undefined}
            tone={s.openAbuse > 0 ? "critical" : undefined}
          />
        </section>
      ) : null}

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", marginTop: 10 }}>
        <Link href="/costs" className="card tile">
          <span className="label">{S.overview.costToday}</span>
          {spike ? (
            <>
              <span className="value">{formatUsdPrecise(spike.total.today)}</span>
              <span className="sub">
                {spike.total.flagged ? <Badge tone="critical">{S.overview.costSpike}</Badge> : <Badge tone="good">{S.overview.costNormal}</Badge>}{" "}
                {S.costs.trailingMean} {formatUsdPrecise(spike.total.trailingMean)}
              </span>
            </>
          ) : (
            <QueryState isLoading={costs.isLoading} error={costs.error} />
          )}
        </Link>
        <Link href="/providers" className="card tile">
          <span className="label">{S.nav.providers}</span>
          {health.data ? (
            <span className="sub" style={{ marginTop: 6 }}>
              {failing.length > 0 ? (
                <Badge tone="critical">{S.overview.providersFailing(failing.length)}</Badge>
              ) : (
                <Badge tone="good">{S.overview.providersOk}</Badge>
              )}
              {failing.length > 0 ? <span className="muted"> {failing.map((f) => f.provider).join(", ")}</span> : null}
            </span>
          ) : (
            <QueryState isLoading={health.isLoading} error={health.error} />
          )}
        </Link>
      </section>
    </>
  );
}

function Tile({ label, value, sub, href, tone }: { label: string; value: number; sub?: string; href?: string; tone?: "critical" }) {
  const body = (
    <>
      <span className="label">{label}</span>
      <span className="value" style={tone === "critical" ? { color: "var(--critical-ink)" } : undefined}>
        {value.toLocaleString("en-US")}
      </span>
      {sub ? <span className="sub">{sub}</span> : null}
    </>
  );
  return href ? (
    <Link href={href} className="card tile">
      {body}
    </Link>
  ) : (
    <div className="card tile">{body}</div>
  );
}
