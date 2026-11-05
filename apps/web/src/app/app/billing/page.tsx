"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate, formatNumber, formatUsd } from "@/i18n/format";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC } from "@/lib/trpc";
import { atLeast } from "@/lib/roles";
import { ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { useWorkspace } from "../workspace-context";

export default function BillingPage() {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const params = useSearchParams();
  const { workspace } = useWorkspace();
  const isOwner = atLeast(workspace.role, "owner");
  const summary = useQuery(trpc.billing.summary.queryOptions({ workspaceId: workspace.id }));
  const tasks = useQuery(trpc.billing.taskCosts.queryOptions({ workspaceId: workspace.id, limit: 50 }));
  const plans = useQuery(trpc.billing.plans.queryOptions());
  const checkout = useMutation(trpc.billing.checkout.mutationOptions({ onSuccess: (r) => window.location.assign(r.url) }));
  const portal = useMutation(trpc.billing.portal.mutationOptions({ onSuccess: (r) => window.location.assign(r.url) }));
  const setCap = useMutation(trpc.workspace.setSpendCap.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.billing.summary.queryKey({ workspaceId: workspace.id }) }) }));
  const [cap, setCapText] = useState("");
  useEffect(() => {
    if (summary.data) setCapText(summary.data.spendCapUsd === null ? "" : String(summary.data.spendCapUsd));
  }, [summary.data]);

  const s = summary.data;
  const providerTotal = s?.usage.reduce((acc, u) => acc + u.costUsd, 0) ?? 0;
  const spent = s?.priceUsd ?? s?.chargedUsd ?? 0;
  const capPct = s?.spendCapUsd ? Math.min(100, (spent / s.spendCapUsd) * 100) : null;
  const checkoutState = params.get("checkout");

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("billing.title")}</h1>
          <p className="muted" style={{ maxWidth: 640 }}>
            {t("billing.lede")}
          </p>
        </div>
        {isOwner && (
          <button type="button" className="btn" disabled={portal.isPending} onClick={() => portal.mutate({ workspaceId: workspace.id })}>
            {t("billing.portal")}
          </button>
        )}
      </header>
      {checkoutState === "success" && <p className="notice notice-ok">{t("billing.checkoutSuccess")}</p>}
      {checkoutState === "cancelled" && <p className="notice">{t("billing.checkoutCancelled")}</p>}
      <ErrorNotice error={portal.error ?? checkout.error} service="billing" />

      {summary.isPending ? (
        <LoadingBlock rows={4} />
      ) : summary.isError ? (
        <ErrorNotice error={summary.error} />
      ) : (
        s && (
          <>
            <section className="stats" aria-label={t("billing.plan")}>
              <div className="stat">
                <span className="eyebrow">{t("billing.plan")}</span>
                <span className="stat-value" style={{ textTransform: "capitalize" }}>
                  {s.plan}
                </span>
                <span className="hint">{t("billing.period", { date: formatDate(s.periodStart, locale, false) })}</span>
              </div>
              <div className="stat">
                <span className="eyebrow">{t("billing.spend")}</span>
                <span className="stat-value">{formatUsd(spent, locale)}</span>
                {capPct !== null && (
                  <div className="bar" aria-label={`${Math.round(capPct)}%`}>
                    <span style={{ width: `${capPct}%`, background: capPct > 90 ? "var(--danger)" : undefined }} />
                  </div>
                )}
              </div>
              <div className="stat">
                <span className="eyebrow">{t("billing.charged")}</span>
                <span className="stat-value">{formatUsd(s.chargedUsd, locale)}</span>
              </div>
              <div className="stat">
                <span className="eyebrow">{t("billing.notCharged")}</span>
                <span className="stat-value" data-testid="not-charged">
                  {s.failedTasksNotCharged}
                </span>
                <span className="hint">{t("billing.notChargedHint", { count: s.failedTasksNotCharged })}</span>
              </div>
            </section>

            <div className="split">
              <section className="card stack">
                <h2 className="section-title-sm">{t("billing.usage")}</h2>
                {s.usage.length === 0 ? (
                  <p className="hint">{t("billing.usageEmpty")}</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t("billing.kind")}</th>
                          <th style={{ textAlign: "right" }}>{t("billing.quantity")}</th>
                          <th style={{ textAlign: "right" }}>{t("billing.providerCost")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.usage.map((u) => (
                          <tr key={u.kind}>
                            <td className="mono">{u.kind}</td>
                            <td style={{ textAlign: "right" }} className="mono">
                              {formatNumber(u.quantity, locale)}
                            </td>
                            <td style={{ textAlign: "right" }} className="mono">
                              {formatUsd(u.costUsd, locale, { precise: true })}
                            </td>
                          </tr>
                        ))}
                        <tr>
                          <td>
                            <strong>{t("common.total")}</strong>
                          </td>
                          <td />
                          <td style={{ textAlign: "right" }} className="mono">
                            <strong>{formatUsd(providerTotal, locale, { precise: true })}</strong>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
                {s.priceUsd !== null && (
                  <p className="hint">
                    {t("billing.priced")}: <strong className="mono">{formatUsd(s.priceUsd, locale)}</strong>
                  </p>
                )}
              </section>
              <form
                className="card stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = cap.trim() === "" ? null : Number(cap);
                  if (v === null || (Number.isFinite(v) && v >= 0)) setCap.mutate({ workspaceId: workspace.id, capUsd: v });
                }}
              >
                <h2 className="section-title-sm">{t("billing.capTitle")}</h2>
                <p className="muted">{t("billing.capLede")}</p>
                <div className="field" style={{ maxWidth: 240 }}>
                  <label htmlFor="cap">{t("billing.cap")}</label>
                  <input id="cap" className="input mono" type="number" min={0} step="1" placeholder={t("billing.noCap")} value={cap} onChange={(e) => setCapText(e.target.value)} disabled={!isOwner} />
                </div>
                {isOwner ? (
                  <button type="submit" className="btn btn-sm btn-ink" style={{ justifySelf: "start" }} disabled={setCap.isPending}>
                    {t("billing.saveCap")}
                  </button>
                ) : (
                  <p className="hint">{t("billing.ownerOnly")}</p>
                )}
                {setCap.isSuccess && <p className="notice notice-ok">{t("billing.capSaved")}</p>}
                <ErrorNotice error={setCap.error} compact />
              </form>
            </div>
          </>
        )
      )}

      <section className="card stack">
        <div>
          <h2 className="section-title-sm">{t("billing.tasks")}</h2>
          <p className="muted">{t("billing.tasksLede")}</p>
        </div>
        {tasks.isPending ? (
          <LoadingBlock rows={3} />
        ) : tasks.isError ? (
          <ErrorNotice error={tasks.error} />
        ) : tasks.data.length === 0 ? (
          <p className="hint">{t("billing.noTasks")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("billing.task")}</th>
                  <th>{t("common.status")}</th>
                  <th style={{ textAlign: "right" }}>{t("billing.estimate")}</th>
                  <th style={{ textAlign: "right" }}>{t("billing.chargedCol")}</th>
                  <th>{t("common.created")}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.data.map((x) => (
                  <tr key={x.id}>
                    <td style={{ maxWidth: 380 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.prompt}</span>
                      <span className="hint">{x.projectName}</span>
                    </td>
                    <td>
                      <span className={`badge ${x.status === "succeeded" ? "badge-ok" : x.status === "failed" ? "badge-bad" : ""}`}>{t(`project.chat.status.${x.status}` as MessageKey)}</span>
                    </td>
                    <td className="mono" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {x.estimateLowUsd !== null && x.estimateHighUsd !== null ? `${formatUsd(x.estimateLowUsd, locale)} – ${formatUsd(x.estimateHighUsd, locale)}` : "—"}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {x.status === "failed" && !x.charged ? <span className="badge badge-ok">{t("billing.notCharged")}</span> : formatUsd(x.chargedUsd, locale)}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatDate(x.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack">
        <h2 className="section-title-sm">{t("billing.plans")}</h2>
        {plans.isPending ? (
          <LoadingBlock rows={2} />
        ) : plans.isError ? (
          <ErrorNotice error={plans.error} service="billing" />
        ) : (
          <ul className="grid-cards" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {plans.data.map((p) => (
              <li key={p.id} className="tile" data-current={p.id === s?.plan}>
                <div className="row-between">
                  <h3>{p.name}</h3>
                  {p.id === s?.plan && <span className="badge badge-accent">{t("billing.currentBadge")}</span>}
                </div>
                <p>
                  <span className="stat-value">{formatUsd(p.monthlyUsd, locale)}</span> <span className="hint">{t("billing.perMonth")}</span>
                </p>
                <p className="hint">{t("billing.includes", { amount: formatUsd(p.includedUsd, locale) })}</p>
                <ul style={{ margin: 0, paddingLeft: "1.1em", fontSize: "0.86rem", display: "grid", gap: 4 }}>
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {isOwner && p.id !== s?.plan && (p.id === "pro" || p.id === "team" || p.id === "enterprise") && (
                  <div className="tile-foot">
                    <span />
                    <button type="button" className="btn btn-sm btn-primary" disabled={checkout.isPending} onClick={() => checkout.mutate({ workspaceId: workspace.id, plan: p.id as "pro" | "team" | "enterprise" })}>
                      {t("billing.choose", { plan: p.name })}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
