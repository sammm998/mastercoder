"use client";
import { useState } from "react";
import { assignSlots, formatUsdPrecise } from "@/lib/chart";
import { OTHER, pivotDaily, spikeReport } from "@/lib/costs";
import { S } from "@/lib/strings";
import { trpc } from "@/lib/trpc";
import { Badge, PageHead, QueryState } from "@/components/ui";
import { StackedBarChart, seriesColor } from "@/components/StackedBarChart";

const RANGES = [7, 14, 30, 90] as const;

export function CostsView() {
  const [days, setDays] = useState<number>(14);
  // Always fetch at least 8 days so today's spike check has a full 7-day baseline.
  const fetchDays = Math.max(days, 8);
  const costs = trpc.admin.costs.useQuery({ days: fetchDays }, { placeholderData: (prev) => prev, refetchInterval: 60_000 });

  const full = costs.data ? pivotDaily(costs.data, { days: fetchDays }) : null;
  const spike = full ? spikeReport(full) : null;
  const view = costs.data ? pivotDaily(costs.data, { days }) : null;
  const grand = view ? view.totals.reduce((a, b) => a + b, 0) : 0;
  const slots = view ? assignSlots(view.providers, OTHER) : {};

  return (
    <>
      <PageHead title={S.costs.title}>
        <div className="segmented" role="group" aria-label={S.costs.range}>
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)}>
              {S.costs.days(r)}
            </button>
          ))}
        </div>
      </PageHead>
      <QueryState isLoading={costs.isLoading} error={costs.error} onRetry={() => void costs.refetch()} />

      {spike ? (
        <section aria-labelledby="spike-h" className={`alert ${spike.total.flagged ? "critical" : ""}`} style={{ marginBottom: 10 }}>
          <h2 id="spike-h" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {S.costs.spikeTitle}{" "}
            {spike.total.flagged ? <Badge tone="critical">{S.costs.flagged}</Badge> : <Badge tone="good">{S.costs.normal}</Badge>}
          </h2>
          <p className="muted">{S.costs.spikeExplain}</p>
          <dl className="kv">
            <dt>{S.costs.today}</dt>
            <dd className="num" style={{ textAlign: "left" }}>
              {formatUsdPrecise(spike.total.today)}
            </dd>
            <dt>{S.costs.trailingMean}</dt>
            <dd>{formatUsdPrecise(spike.total.trailingMean)}</dd>
            <dt>{S.costs.ratio}</dt>
            <dd>{spike.total.ratio !== null ? `${spike.total.ratio.toFixed(2)}×` : spike.total.flagged ? S.costs.newSpend : "–"}</dd>
          </dl>
          <h3 style={{ fontSize: 13, margin: "6px 0 4px" }}>{S.costs.flaggedProviders}</h3>
          {spike.providers.length === 0 ? (
            <p className="muted">{S.costs.noFlaggedProviders}</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {spike.providers.map((p) => (
                <li key={p.provider}>
                  <strong>{p.provider}</strong>: {formatUsdPrecise(p.today)} vs {formatUsdPrecise(p.trailingMean)}{" "}
                  {p.ratio !== null ? `(${p.ratio.toFixed(1)}×)` : `(${S.costs.newSpend})`}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {view ? (
        <div className="grid two-col">
          <section className="card" aria-labelledby="chart-h">
            <h2 id="chart-h">
              {S.costs.chartTitle} <span className="muted">· {formatUsdPrecise(grand)}</span>
            </h2>
            {grand === 0 ? (
              <p className="muted">{S.costs.noData}</p>
            ) : (
              <StackedBarChart
                title={S.costs.chartTitle}
                description={S.costs.chartDesc(days, formatUsdPrecise(grand))}
                days={view.days}
                keys={view.providers}
                series={view.series}
                totals={view.totals}
                spikeIndex={spike?.total.flagged ? view.days.length - 1 : null}
              />
            )}
          </section>
          <section className="table-wrap" aria-labelledby="prov-h">
            <table>
              <caption id="prov-h">{S.costs.byProvider}</caption>
              <thead>
                <tr>
                  <th scope="col">{S.costs.provider}</th>
                  <th scope="col" className="num">
                    {S.costs.total}
                  </th>
                  <th scope="col" className="num">
                    {S.costs.share}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.providers.map((p) => {
                  const t = view.providerTotals[p] ?? 0;
                  return (
                    <tr key={p}>
                      <td>
                        <span
                          aria-hidden="true"
                          style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, marginRight: 8, background: seriesColor(slots[p] ?? 0) }}
                        />
                        {p}
                      </td>
                      <td className="num">{formatUsdPrecise(t)}</td>
                      <td className="num">{grand > 0 ? `${((t / grand) * 100).toFixed(1)}%` : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>
      ) : null}
    </>
  );
}
