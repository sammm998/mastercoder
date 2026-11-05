"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import { useTRPC } from "@/lib/trpc";
import type { ForgeEvent } from "@/lib/events";
import { ErrorNotice, EmptyState, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";

interface GateRow {
  gate: string;
  passed: boolean;
  skipped?: boolean;
  details: string;
  fix?: string;
}

/** Blockers from a stored gate report (`deployments.gate_report`) or live gate.result events. */
export function blockersFrom(report: unknown, events: ForgeEvent[]): GateRow[] {
  const fromReport = (report as { results?: unknown } | null)?.results;
  if (Array.isArray(fromReport)) return (fromReport as GateRow[]).filter((r) => r && r.passed === false && !r.skipped);
  const latest = new Map<string, GateRow>();
  for (const e of events) if (e.type === "gate.result") latest.set(e.gate, { gate: e.gate, passed: e.passed, details: e.details, fix: e.fix });
  return [...latest.values()].filter((g) => !g.passed);
}

const STATUS_BADGE: Record<string, string> = { live: "badge-ok", blocked: "badge-bad", failed: "badge-bad", pending: "badge-warn", rolled_back: "", taken_down: "badge-bad" };

export function DeployPanel({ projectId, events, canDeploy }: { projectId: string; events: ForgeEvent[]; canDeploy: boolean }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery({ ...trpc.deploy.list.queryOptions({ projectId }), enabled: canDeploy });
  const domains = useQuery({ ...trpc.deploy.domains.queryOptions({ projectId }), enabled: canDeploy });
  const inv = () => qc.invalidateQueries({ queryKey: trpc.deploy.list.queryKey({ projectId }) });
  const deploy = useMutation(trpc.deploy.deploy.mutationOptions({ onSuccess: inv }));
  const rollback = useMutation(trpc.deploy.rollback.mutationOptions({ onSuccess: inv }));
  const invDomains = () => qc.invalidateQueries({ queryKey: trpc.deploy.domains.queryKey({ projectId }) });
  const [records, setRecords] = useState<Record<string, Array<{ type: string; name: string; value: string }>>>({});
  const addDomain = useMutation(
    trpc.deploy.addDomain.mutationOptions({
      onSuccess: (r, v) => {
        setRecords((cur) => ({ ...cur, [v.hostname.toLowerCase()]: r.records }));
        void invDomains();
      },
    }),
  );
  const checkDomain = useMutation(trpc.deploy.checkDomain.mutationOptions({ onSuccess: invDomains }));
  const removeDomain = useMutation(trpc.deploy.removeDomain.mutationOptions({ onSuccess: invDomains }));
  const exportGh = useMutation(trpc.deploy.exportGithub.mutationOptions());
  const [hostname, setHostname] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");

  const lastDeployEvent = useMemo(() => [...events].reverse().find((e) => e.type === "deploy.status")?.id, [events]);
  useEffect(() => {
    if (lastDeployEvent) void inv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastDeployEvent]);

  const latest = list.data?.[0];
  const blockers = blockersFrom(latest?.status === "blocked" ? latest.gateReport : null, latest?.status === "blocked" ? [] : events);
  const showBlockers = latest?.status === "blocked" || (blockers.length > 0 && deploy.isSuccess);

  if (!canDeploy) return <div className="panel-pad"><p className="notice">{t("errors.forbidden")}</p></div>;

  return (
    <div className="panel-pad stack-lg" data-testid="deploy-panel">
      <section className="card stack">
        <div className="row-between">
          <div>
            <h2 className="section-title-sm">{t("deploy.title")}</h2>
            <p className="muted">{t("deploy.lede")}</p>
          </div>
          <button type="button" className="btn btn-primary" disabled={deploy.isPending} onClick={() => deploy.mutate({ projectId, branch: "main" })}>
            <Icon name="rocket" size={16} /> {deploy.isPending ? t("deploy.queueing") : t("deploy.deploy")}
          </button>
        </div>
        {deploy.isSuccess && <p className="notice notice-ok" role="status">{t("deploy.queued")}</p>}
        <ErrorNotice error={deploy.error} />
        {showBlockers && blockers.length > 0 && (
          <div className="stack" style={{ gap: 8 }} data-testid="deploy-blockers">
            <p className="notice notice-bad">
              <span>
                <strong>{t("deploy.blocked")}</strong>
                {t("deploy.blockedBody", { count: blockers.length })}
              </span>
            </p>
            <ul className="list">
              {blockers.map((b) => (
                <li key={b.gate} style={{ alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="badge badge-bad">{b.gate}</span>
                    <p>{b.details}</p>
                    {b.fix && (
                      <p className="hint">
                        <strong>{t("deploy.fix")}:</strong> {b.fix}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h3 className="section-title-sm" style={{ marginBottom: 12 }}>
          {t("deploy.history")}
        </h3>
        {list.isPending ? (
          <LoadingBlock rows={3} />
        ) : list.isError ? (
          <ErrorNotice error={list.error} />
        ) : list.data.length === 0 ? (
          <EmptyState title={t("deploy.emptyTitle")} body={t("deploy.emptyBody")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("common.status")}</th>
                  <th>{t("deploy.url")}</th>
                  <th>{t("deploy.region")}</th>
                  <th>{t("common.created")}</th>
                  <th>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((d, i) => (
                  <tr key={d.id}>
                    <td>
                      <span className={`badge ${STATUS_BADGE[d.status] ?? ""}`}>{d.status in STATUS_BADGE ? t(`deploy.status.${d.status as keyof typeof STATUS_BADGE & ("pending" | "blocked" | "live" | "rolled_back" | "failed" | "taken_down")}`) : d.status}</span>
                    </td>
                    <td className="mono">
                      {d.url ? (
                        <a href={d.url} target="_blank" rel="noreferrer noopener">
                          {d.url.replace(/^https?:\/\//, "")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="mono">
                      {d.provider} · {d.region}
                    </td>
                    <td>{formatDate(d.createdAt, locale)}</td>
                    <td>
                      {i > 0 && (d.status === "live" || d.status === "rolled_back") && (
                        <button type="button" className="btn btn-sm" disabled={rollback.isPending} onClick={() => window.confirm(t("deploy.rollbackConfirm")) && rollback.mutate({ projectId, deploymentId: d.id })}>
                          {t("deploy.rollback")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rollback.isSuccess && <p className="notice notice-ok">{t("deploy.rollbackQueued")}</p>}
        <ErrorNotice error={rollback.error} />
      </section>

      <section className="split">
        <div className="card stack">
          <h3 className="section-title-sm">{t("deploy.domains")}</h3>
          <form
            className="row"
            style={{ flexWrap: "nowrap" }}
            onSubmit={(e) => {
              e.preventDefault();
              if (hostname.trim()) addDomain.mutate({ projectId, hostname: hostname.trim() }, { onSuccess: () => setHostname("") });
            }}
          >
            <label htmlFor="domain" className="sr-only">
              {t("deploy.hostname")}
            </label>
            <input id="domain" className="input" placeholder="app.example.se" value={hostname} onChange={(e) => setHostname(e.target.value)} />
            <button type="submit" className="btn btn-sm btn-ink" disabled={!hostname.trim() || addDomain.isPending}>
              {t("common.add")}
            </button>
          </form>
          <ErrorNotice error={addDomain.error} service="domains" compact />
          {domains.isPending ? (
            <LoadingBlock rows={2} />
          ) : domains.isError ? (
            <ErrorNotice error={domains.error} />
          ) : domains.data.length === 0 ? (
            <p className="hint">{t("deploy.noDomains")}</p>
          ) : (
            <ul className="list">
              {domains.data.map((d) => {
                const recs = records[d.hostname] ?? [{ type: "TXT", name: `_forge-verify.${d.hostname}`, value: d.verificationToken }];
                return (
                  <li key={d.id} style={{ display: "grid", gap: 8 }}>
                    <div className="row-between">
                      <strong className="mono">{d.hostname}</strong>
                      <div className="row" style={{ gap: 6 }}>
                        <span className={`badge ${d.verified ? "badge-ok" : "badge-warn"}`}>{d.verified ? t("deploy.verified") : t("deploy.unverified")}</span>
                        <span className={`badge ${d.tlsStatus === "active" || d.tlsStatus === "issued" ? "badge-ok" : ""}`}>TLS · {d.tlsStatus}</span>
                      </div>
                    </div>
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>{t("deploy.recordType")}</th>
                            <th>{t("deploy.recordName")}</th>
                            <th>{t("deploy.recordValue")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recs.map((r, i) => (
                            <tr key={i}>
                              <td className="mono">{r.type}</td>
                              <td className="mono">{r.name}</td>
                              <td className="mono" style={{ wordBreak: "break-all" }}>
                                {r.value}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button type="button" className="btn btn-sm" disabled={checkDomain.isPending} onClick={() => checkDomain.mutate({ projectId, hostname: d.hostname })}>
                        {t("deploy.check")}
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => window.confirm(t("deploy.removeConfirm", { host: d.hostname })) && removeDomain.mutate({ projectId, hostname: d.hostname })}>
                        {t("common.remove")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <ErrorNotice error={checkDomain.error ?? removeDomain.error} service="domains" compact />
        </div>
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^[\w.-]+\/[\w.-]+$/.test(repo)) exportGh.mutate({ projectId, repo, branch: branch || "main" });
          }}
        >
          <h3 className="section-title-sm">
            <Icon name="github" size={18} /> {t("deploy.github")}
          </h3>
          <p className="muted">{t("deploy.githubLede")}</p>
          <div className="field">
            <label htmlFor="gh-repo">{t("deploy.repo")}</label>
            <input id="gh-repo" className="input mono" placeholder="org/repo" value={repo} onChange={(e) => setRepo(e.target.value)} aria-invalid={!!repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)} />
          </div>
          <div className="field">
            <label htmlFor="gh-branch">{t("deploy.branch")}</label>
            <input id="gh-branch" className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-ink btn-sm" style={{ justifySelf: "start" }} disabled={!/^[\w.-]+\/[\w.-]+$/.test(repo) || exportGh.isPending}>
            {t("deploy.export")}
          </button>
          {exportGh.isSuccess && <p className="notice notice-ok">{t("deploy.exportQueued")}</p>}
          <ErrorNotice error={exportGh.error} compact />
        </form>
      </section>
    </div>
  );
}
