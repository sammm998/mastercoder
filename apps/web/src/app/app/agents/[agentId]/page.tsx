"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate, formatUsd } from "@/i18n/format";
import { useTRPC } from "@/lib/trpc";
import { ErrorNotice, EmptyState, LoadingBlock } from "@/components/Feedback";
import { CopyField } from "@/components/CopyField";
import { Icon } from "@/components/Icon";
import { DefinitionForm, type Definition } from "@/features/agents/DefinitionForm";
import { describeLogEntry } from "@/features/agents/run-log";
import { AgentChat } from "@/features/agents/AgentChat";

export default function AgentDetail({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = use(params);
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const agent = useQuery(trpc.agents.get.queryOptions({ agentId }));
  const runs = useQuery({ ...trpc.agents.runs.queryOptions({ agentId, limit: 50 }), refetchInterval: 10_000 });
  const inv = () => qc.invalidateQueries({ queryKey: trpc.agents.get.queryKey({ agentId }) });
  const setStatus = useMutation(trpc.agents.setStatus.mutationOptions({ onSuccess: inv }));
  const runNow = useMutation(trpc.agents.runNow.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.agents.runs.queryKey({ agentId }) }) }));
  const evals = useMutation(trpc.agents.runEvals.mutationOptions());
  const update = useMutation(trpc.agents.update.mutationOptions({ onSuccess: inv }));
  const rollback = useMutation(trpc.agents.rollback.mutationOptions({ onSuccess: inv }));
  const [def, setDef] = useState<Definition | null>(null);
  const [valid, setValid] = useState(true);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (agent.data) {
      setDef(agent.data.definition as Definition);
      setDirty(false);
    }
  }, [agent.data]);

  if (agent.isPending)
    return (
      <div className="page">
        <LoadingBlock rows={6} />
      </div>
    );
  if (agent.isError)
    return (
      <div className="page">
        <ErrorNotice error={agent.error} />
      </div>
    );
  const a = agent.data;
  const paused = a.status === "paused";

  return (
    <div className="page">
      <header className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <Link href="/app/agents" className="eyebrow" style={{ textDecoration: "none" }}>
            ← {t("agents.back")}
          </Link>
          <h1 className="page-title">{a.name}</h1>
          <div className="row" style={{ gap: 8 }}>
            <span className={`badge ${paused ? "badge-warn" : "badge-ok"}`}>{t(`agents.status.${paused ? "paused" : "active"}`)}</span>
            <span className="badge mono">{t("agents.version", { n: a.version })}</span>
          </div>
        </div>
        <div className="row">
          <button type="button" className="btn" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ agentId, status: paused ? "active" : "paused" })}>
            <Icon name={paused ? "play" : "pause"} size={14} /> {paused ? t("agents.resume") : t("agents.pause")}
          </button>
          <button type="button" className="btn" disabled={runNow.isPending} onClick={() => runNow.mutate({ agentId, test: true })}>
            {t("agents.testRun")}
          </button>
          <button type="button" className="btn btn-primary" disabled={runNow.isPending || paused} onClick={() => runNow.mutate({ agentId, test: false })}>
            <Icon name="play" size={14} /> {t("agents.runNow")}
          </button>
        </div>
      </header>
      {(runNow.isSuccess || evals.isSuccess) && (
        <p className="notice notice-ok" role="status">
          {evals.isSuccess ? t("agents.evalsQueued") : t("agents.runQueued")}
        </p>
      )}
      <ErrorNotice error={setStatus.error ?? runNow.error ?? evals.error} />

      <AgentChat agentId={agentId} agentName={a.name} disabled={paused} />

      <div className="split">
        <section className="stack-lg">
          <div className="card stack">
            <div className="row-between">
              <h2 className="section-title-sm">{t("agents.runs")}</h2>
              <button type="button" className="btn btn-sm" disabled={evals.isPending} onClick={() => evals.mutate({ agentId })}>
                {t("agents.runEvals")}
              </button>
            </div>
            {runs.isPending ? (
              <LoadingBlock rows={3} />
            ) : runs.isError ? (
              <ErrorNotice error={runs.error} />
            ) : runs.data.length === 0 ? (
              <p className="hint">{t("agents.runsEmpty")}</p>
            ) : (
              <ul className="list">
                {runs.data.map((r) => {
                  const log = Array.isArray(r.log) ? (r.log as unknown[]) : [];
                  const dur = r.endedAt ? Math.round((new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()) / 100) / 10 : null;
                  return (
                    <li key={r.id} style={{ display: "block" }}>
                      <details>
                        <summary className="row-between" style={{ cursor: "pointer" }}>
                          <span className="row" style={{ gap: 8 }}>
                            <span className={`badge ${r.status === "succeeded" ? "badge-ok" : r.status === "failed" ? "badge-bad" : "badge-warn"}`}>{r.status}</span>
                            <span className="mono hint">{r.trigger}</span>
                            <span className="hint">{formatDate(r.startedAt, locale)}</span>
                          </span>
                          <span className="row" style={{ gap: 8 }}>
                            <span className="hint">{t("agents.runSteps", { count: log.length })}</span>
                            {dur !== null && <span className="hint mono">{dur}s</span>}
                            <strong className="mono">{formatUsd(r.costUsd, locale, { precise: true })}</strong>
                          </span>
                        </summary>
                        <ol className="timeline" style={{ marginTop: 12 }}>
                          {log.map((entry, i) => {
                            const d = describeLogEntry(entry);
                            return (
                              <li key={i}>
                                <div className="row-between">
                                  <span className="mono" style={{ fontSize: "0.8rem" }}>
                                    {d.title}
                                  </span>
                                  {d.costUsd !== null && <span className="mono hint">{formatUsd(d.costUsd, locale, { precise: true })}</span>}
                                </div>
                                {d.detail && <pre className="code" style={{ maxHeight: 160, marginTop: 4 }}>{d.detail}</pre>}
                              </li>
                            );
                          })}
                        </ol>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="card stack">
            <h2 className="section-title-sm">{t("agents.channelsTitle")}</h2>
            <CopyField label={t("agents.widget")} value={a.channels.widgetSnippet} multiline />
            <CopyField label={t("agents.webhook")} value={a.channels.webhookUrl} hint={t("agents.webhookHint")} />
            <CopyField label={t("agents.rest")} value={a.channels.restUrl} hint={t("agents.restHint")} />
            <CopyField label={t("agents.email")} value={a.channels.inboundEmail} />
          </div>
        </section>
        <section className="stack-lg">
          <form
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (def && valid) update.mutate({ agentId, definition: def });
            }}
          >
            <h2 className="section-title-sm">{t("agents.definition")}</h2>
            {def && (
              <DefinitionForm
                value={def}
                onChange={(d) => {
                  setDef(d);
                  setDirty(true);
                }}
                onValidity={setValid}
              />
            )}
            <ErrorNotice error={update.error} />
            {update.isSuccess && <p className="notice notice-ok">{t("agents.savedVersion", { n: update.data.version })}</p>}
            <button type="submit" className="btn btn-ink" style={{ justifySelf: "start" }} disabled={!dirty || !valid || update.isPending}>
              {t("agents.save")}
            </button>
          </form>
          <div className="card stack">
            <h2 className="section-title-sm">{t("agents.versions")}</h2>
            {a.versions.length === 0 ? (
              <EmptyState title={t("agents.versions")} />
            ) : (
              <ul className="list">
                {a.versions.map((v) => (
                  <li key={v.version}>
                    <span>
                      <strong className="mono">{t("agents.version", { n: v.version })}</strong> <span className="hint">· {formatDate(v.createdAt, locale)}</span>
                    </span>
                    {v.version !== a.version && (
                      <button type="button" className="btn btn-sm" disabled={rollback.isPending} onClick={() => window.confirm(t("agents.rollbackConfirm", { n: v.version })) && rollback.mutate({ agentId, version: v.version })}>
                        {t("agents.rollback", { n: v.version })}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <ErrorNotice error={rollback.error} compact />
          </div>
        </section>
      </div>
    </div>
  );
}
