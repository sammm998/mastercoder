"use client";
import { healthState, sortByHealth, type HealthState } from "@/lib/health";
import { S } from "@/lib/strings";
import { trpc } from "@/lib/trpc";
import { Badge, PageHead, QueryState, Time, type Tone } from "@/components/ui";

const TONE: Record<HealthState, Tone> = { ok: "good", degraded: "warning", failing: "critical" };
const LABEL: Record<HealthState, string> = { ok: S.providers.ok, degraded: S.providers.degraded, failing: S.providers.failing };

export function ProvidersView() {
  const health = trpc.admin.providerHealth.useQuery(undefined, { refetchInterval: 30_000 });
  const rows = sortByHealth(health.data ?? []);

  return (
    <>
      <PageHead title={S.providers.title}>
        <button type="button" onClick={() => void health.refetch()} disabled={health.isFetching}>
          {S.common.refresh}
        </button>
      </PageHead>
      <p className="muted">{S.providers.explain}</p>
      <QueryState isLoading={health.isLoading} error={health.error} onRetry={() => void health.refetch()} />
      {health.data ? (
        <div className="table-wrap">
          <table aria-busy={health.isFetching}>
            <thead>
              <tr>
                <th scope="col">{S.providers.provider}</th>
                <th scope="col">{S.providers.kind}</th>
                <th scope="col">{S.providers.status}</th>
                <th scope="col" className="num">
                  {S.providers.latency}
                </th>
                <th scope="col" className="num">
                  {S.providers.failures}
                </th>
                <th scope="col">{S.providers.lastChecked}</th>
                <th scope="col">{S.providers.error}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    {S.providers.noChecks}
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const st = healthState(r);
                  return (
                    <tr key={r.provider} className={st === "failing" ? "row-critical" : undefined}>
                      <th scope="row" className="rowhead">
                        {r.provider}
                      </th>
                      <td>{r.kind}</td>
                      <td>
                        <Badge tone={TONE[st]}>{LABEL[st]}</Badge>
                      </td>
                      <td className="num">{r.latencyMs !== null && r.latencyMs !== undefined ? `${r.latencyMs} ms` : "–"}</td>
                      <td className="num">
                        {r.failures24h} / {r.checks24h}
                      </td>
                      <td>
                        <Time value={r.checkedAt} />
                      </td>
                      <td className="wrap mono">{r.error ?? <span className="muted">–</span>}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
