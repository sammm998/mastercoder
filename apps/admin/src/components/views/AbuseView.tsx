"use client";
import { useCallback, useState } from "react";
import { extractLinks, prettyJson, scalarFields } from "@/lib/evidence";
import { S } from "@/lib/strings";
import { errorMessage, trpc, type RouterOutputs } from "@/lib/trpc";
import { Badge, ConfirmDialog, PageHead, QueryState, Time, formatDate } from "@/components/ui";

type Status = "open" | "dismissed" | "taken_down";
type Report = RouterOutputs["admin"]["abuseQueue"][number];
const STATUSES: Status[] = ["open", "taken_down", "dismissed"];

export function AbuseView() {
  const [status, setStatus] = useState<Status>("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<"takedown" | "dismiss" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const queue = trpc.admin.abuseQueue.useQuery({ status }, { refetchInterval: status === "open" ? 30_000 : false });
  const resolve = trpc.admin.resolveAbuse.useMutation({
    onSuccess: async (_d, vars) => {
      setNotice(S.abuse.done(vars.action));
      setPending(null);
      setSelectedId(null);
      await Promise.all([utils.admin.abuseQueue.invalidate(), utils.admin.stats.invalidate()]);
    },
  });

  const reports = queue.data ?? [];
  const selected = reports.find((r) => r.id === selectedId) ?? null;
  const cancel = useCallback(() => setPending(null), []);

  return (
    <>
      <PageHead title={S.abuse.title}>
        <div className="segmented" role="group" aria-label={S.abuse.status}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => {
                setStatus(s);
                setSelectedId(null);
                setNotice(null);
              }}
            >
              {S.abuse.statuses[s]}
            </button>
          ))}
        </div>
      </PageHead>
      <p role="status" className="muted" style={{ minHeight: 20 }}>
        {notice}
      </p>
      <QueryState isLoading={queue.isLoading} error={queue.error} onRetry={() => void queue.refetch()} />
      {queue.data ? (
        <div className="grid two-col">
          <div className="table-wrap">
            <table aria-label={`${S.abuse.title}: ${S.abuse.statuses[status]}`}>
              <thead>
                <tr>
                  <th scope="col">{S.abuse.category}</th>
                  <th scope="col">{S.abuse.source}</th>
                  <th scope="col">{S.abuse.project}</th>
                  <th scope="col">{S.abuse.reported}</th>
                </tr>
              </thead>
              <tbody>
                {reports.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      {S.abuse.empty(status)}
                    </td>
                  </tr>
                ) : (
                  reports.map((r) => (
                    <tr key={r.id} aria-selected={r.id === selectedId}>
                      <td>
                        <button type="button" className="row-button" onClick={() => setSelectedId(r.id)} aria-label={`${r.category} ${r.id}`}>
                          <Badge tone={status === "open" ? "critical" : "neutral"}>{r.category}</Badge>
                        </button>
                      </td>
                      <td>{r.source}</td>
                      <td className="mono">{r.projectId ?? "–"}</td>
                      <td>
                        <Time value={r.createdAt} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <section className="card" aria-labelledby="evidence-h" aria-live="polite">
            <h2 id="evidence-h">{S.abuse.evidence}</h2>
            {selected ? <Evidence report={selected} onAction={setPending} busy={resolve.isPending} /> : <p className="muted">{S.abuse.select}</p>}
            {resolve.error ? (
              <p className="error-text" role="alert">
                {errorMessage(resolve.error)}
              </p>
            ) : null}
          </section>
        </div>
      ) : null}
      <ConfirmDialog
        open={pending !== null && !!selected}
        title={pending === "takedown" ? S.abuse.confirmTakedownTitle : S.abuse.confirmDismissTitle}
        body={pending === "takedown" ? S.abuse.confirmTakedownBody : S.abuse.confirmDismissBody}
        confirmLabel={pending === "takedown" ? S.abuse.takedown : S.abuse.dismiss}
        danger={pending === "takedown"}
        busy={resolve.isPending}
        onCancel={cancel}
        onConfirm={() => selected && pending && resolve.mutate({ reportId: selected.id, action: pending })}
      />
    </>
  );
}

function Evidence({ report, onAction, busy }: { report: Report; onAction: (a: "takedown" | "dismiss") => void; busy: boolean }) {
  const links = extractLinks(report.evidence);
  const fields = scalarFields(report.evidence);
  return (
    <>
      <dl className="kv">
        <dt>ID</dt>
        <dd className="mono">{report.id}</dd>
        <dt>{S.abuse.category}</dt>
        <dd>{report.category}</dd>
        <dt>{S.abuse.source}</dt>
        <dd>{report.source}</dd>
        <dt>{S.abuse.project}</dt>
        <dd className="mono">{report.projectId ?? "–"}</dd>
        <dt>{S.abuse.deployment}</dt>
        <dd className="mono">{report.deploymentId ?? "–"}</dd>
        <dt>{S.abuse.reported}</dt>
        <dd>{formatDate(report.createdAt)}</dd>
        {report.resolvedAt ? (
          <>
            <dt>{S.abuse.resolved}</dt>
            <dd>{formatDate(report.resolvedAt)}</dd>
          </>
        ) : null}
        {fields.map(([k, v]) => (
          <FieldRow key={k} k={k} v={v} />
        ))}
      </dl>
      {links.length > 0 ? (
        <>
          <h3 style={{ fontSize: 13, margin: "8px 0 4px" }}>{S.abuse.links}</h3>
          {/* Rendered as text, not anchors: suspected phishing/malware URLs must not be one click away. */}
          <ul className="mono" style={{ margin: "0 0 10px", paddingLeft: 18, wordBreak: "break-all" }}>
            {links.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 style={{ fontSize: 13, margin: "8px 0 4px" }}>{S.abuse.raw}</h3>
      {report.evidence === null || report.evidence === undefined ? <p className="muted">{S.abuse.noEvidence}</p> : <pre className="json">{prettyJson(report.evidence)}</pre>}
      {report.status === "open" ? (
        <div className="dialog-actions">
          <button type="button" onClick={() => onAction("dismiss")} disabled={busy}>
            {S.abuse.dismiss}
          </button>
          <button type="button" className="danger" onClick={() => onAction("takedown")} disabled={busy}>
            {S.abuse.takedown}
          </button>
        </div>
      ) : null}
    </>
  );
}

function FieldRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
