"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC } from "@/lib/trpc";
import { ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { readExtraction, timestamp, transcriptSegments } from "@/features/meetings/extraction";
import { useWorkspace } from "../../workspace-context";

const ACTIVE_BOT = new Set(["scheduled", "joining", "recording"]);

export default function MeetingDetail({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = use(params);
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { workspace } = useWorkspace();
  const q = useQuery({
    ...trpc.meetings.get.queryOptions({ meetingId }),
    refetchInterval: (query) => (query.state.data && ["ready", "failed"].includes(query.state.data.status) ? false : 5000),
  });
  const projects = useQuery(trpc.project.list.queryOptions({ workspaceId: workspace.id }));
  const [specText, setSpecText] = useState("");
  const [projectId, setProjectId] = useState("");
  const approve = useMutation(trpc.meetings.approveSpec.mutationOptions({ onSuccess: () => router.push(`/app/p/${projectId}`) }));
  const del = useMutation(
    trpc.meetings.delete.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.meetings.list.queryKey({ workspaceId: workspace.id }) });
        router.push("/app/meetings");
      },
    }),
  );
  const removeBot = useMutation(trpc.meetings.removeBot.mutationOptions());

  useEffect(() => {
    if (q.data?.spec && !specText) setSpecText(JSON.stringify(q.data.spec, null, 2));
    if (q.data?.projectId && !projectId) setProjectId(q.data.projectId);
  }, [q.data, specText, projectId]);

  if (q.isPending)
    return (
      <div className="page">
        <LoadingBlock rows={6} />
      </div>
    );
  if (q.isError)
    return (
      <div className="page">
        <ErrorNotice error={q.error} />
        <Link className="btn" href="/app/meetings" style={{ justifySelf: "start" }}>
          {t("meetings.back")}
        </Link>
      </div>
    );
  const m = q.data;
  const segments = transcriptSegments(m.transcript);
  const x = readExtraction(m.extraction);
  let spec: Record<string, unknown> | null = null;
  let specInvalid = false;
  if (specText) {
    try {
      const v = JSON.parse(specText) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) spec = v as Record<string, unknown>;
      else specInvalid = true;
    } catch {
      specInvalid = true;
    }
  }
  const list = (key: MessageKey, items: string[]) =>
    items.length > 0 && (
      <section className="stack" style={{ gap: 8 }}>
        <h3 className="label">{t(key)}</h3>
        <ul style={{ margin: 0, paddingLeft: "1.2em", display: "grid", gap: 4 }}>
          {items.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      </section>
    );

  return (
    <div className="page">
      <header className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <Link href="/app/meetings" className="eyebrow" style={{ textDecoration: "none" }}>
            ← {t("meetings.back")}
          </Link>
          <h1 className="page-title">{m.title ?? m.id}</h1>
          <p className="hint">
            {t(`meetings.source.${m.source}` as MessageKey)} · {formatDate(m.createdAt, locale)} · {m.language.toUpperCase()}
            {m.retentionUntil && ` · ${t("meetings.retention", { date: formatDate(m.retentionUntil, locale, false) })}`}
          </p>
        </div>
        <div className="row">
          <span className={`badge ${m.status === "ready" ? "badge-ok" : m.status === "failed" ? "badge-bad" : "badge-warn"}`}>{t(`meetings.status.${m.status}` as MessageKey)}</span>
          {m.source === "bot" && ACTIVE_BOT.has(m.status) && (
            <button type="button" className="btn btn-sm" disabled={removeBot.isPending || removeBot.isSuccess} onClick={() => removeBot.mutate({ meetingId })}>
              {t("meetings.removeBot")}
            </button>
          )}
          <button type="button" className="btn btn-sm btn-danger" disabled={del.isPending} onClick={() => window.confirm(t("meetings.deleteConfirm")) && del.mutate({ meetingId })}>
            {t("meetings.delete")}
          </button>
        </div>
      </header>
      {removeBot.isSuccess && <p className="notice notice-ok">{t("meetings.botRemoved")}</p>}
      <ErrorNotice error={del.error ?? removeBot.error} />
      <p className="hint">{t("meetings.gdpr")}</p>
      <div className="split">
        <div className="stack-lg">
          <section className="card stack">
            <h2 className="section-title-sm">{t("meetings.summary")}</h2>
            {x.summary ? <p className="serif" style={{ fontSize: "1.1rem", lineHeight: 1.5 }}>{x.summary}</p> : <p className="hint">{t("meetings.noTranscript")}</p>}
            {list("meetings.decisions", x.decisions)}
            {list("meetings.requirements", x.requirements)}
            {list("meetings.openQuestions", x.openQuestions)}
            {list("meetings.actionItems", x.actionItems)}
          </section>
          <form
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (spec && projectId) approve.mutate({ meetingId, projectId, spec });
            }}
          >
            <div>
              <h2 className="section-title-sm">{t("meetings.spec")}</h2>
              <p className="muted">{t("meetings.specLede")}</p>
            </div>
            {m.spec ? (
              <>
                <label htmlFor="m-spec" className="sr-only">
                  {t("meetings.spec")}
                </label>
                <textarea id="m-spec" className="textarea mono" rows={14} value={specText} onChange={(e) => setSpecText(e.target.value)} aria-invalid={specInvalid} />
                <div className="field">
                  <label htmlFor="m-proj">{t("meetings.pickProject")}</label>
                  <select id="m-proj" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">—</option>
                    {projects.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }} disabled={!spec || !projectId || m.status !== "ready" || approve.isPending}>
                  {t("meetings.approve")}
                </button>
                {approve.isSuccess && <p className="notice notice-ok">{t("meetings.approved")}</p>}
                <ErrorNotice error={approve.error} service="intent" compact />
              </>
            ) : (
              <p className="hint">{m.status === "ready" ? t("meetings.specMissing") : t("meetings.noTranscript")}</p>
            )}
          </form>
        </div>
        <section className="card stack" aria-labelledby="tr-title">
          <h2 id="tr-title" className="section-title-sm">
            {t("meetings.transcript")}
          </h2>
          {segments.length === 0 ? (
            <p className="hint">{t("meetings.noTranscript")}</p>
          ) : (
            <ol className="transcript" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12, maxHeight: "70vh", overflowY: "auto" }}>
              {segments.map((s, i) => (
                <li key={i} style={{ display: "grid", gridTemplateColumns: "56px 1fr", gap: 12 }}>
                  <span className="mono hint">{timestamp(s.startSec)}</span>
                  <p>
                    {s.speaker && <strong>{s.speaker}: </strong>}
                    {s.text}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
