"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC } from "@/lib/trpc";
import { EmptyState, ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { Recorder } from "@/features/meetings/Recorder";
import { useWorkspace } from "../workspace-context";

export default function MeetingsPage() {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const meetings = useQuery({ ...trpc.meetings.list.queryOptions({ workspaceId: workspace.id }), refetchInterval: 15_000 });
  const projects = useQuery(trpc.project.list.queryOptions({ workspaceId: workspace.id }));
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<"sv" | "en">(locale);
  const [projectId, setProjectId] = useState("");
  const invite = useMutation(trpc.meetings.inviteBot.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.meetings.list.queryKey({ workspaceId: workspace.id }) }) }));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("meetings.title")}</h1>
          <p className="muted" style={{ maxWidth: 680 }}>
            {t("meetings.lede")}
          </p>
        </div>
      </header>
      <aside className="notice" aria-labelledby="consent-title">
        <Icon name="shield" />
        <div>
          <strong id="consent-title">{t("meetings.consentTitle")}</strong>
          <span>{t("meetings.consentBody")}</span>
        </div>
      </aside>
      <div className="split">
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) invite.mutate({ workspaceId: workspace.id, meetingUrl: url.trim(), title: title.trim() || undefined, language, projectId: projectId || undefined });
          }}
        >
          <h2 className="section-title-sm">
            <Icon name="meeting" /> {t("meetings.bot")}
          </h2>
          <p className="muted">{t("meetings.botLede")}</p>
          <div className="field">
            <label htmlFor="m-url">{t("meetings.meetingUrl")}</label>
            <input id="m-url" className="input" type="url" required placeholder="https://meet.google.com/abc-defg-hij" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="vedit-grid">
            <div className="field">
              <label htmlFor="m-title">{t("meetings.meetingTitle")}</label>
              <input id="m-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="m-lang">{t("meetings.language")}</label>
              <select id="m-lang" className="select" value={language} onChange={(e) => setLanguage(e.target.value as "sv" | "en")}>
                <option value="sv">Svenska</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="m-project">{t("meetings.project")}</label>
            <select id="m-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t("meetings.noProject")}</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }} disabled={!url.trim() || invite.isPending}>
            {t("meetings.invite")}
          </button>
          {invite.isSuccess && <p className="notice notice-ok">{t("meetings.invited", { platform: invite.data.platform })}</p>}
          <ErrorNotice error={invite.error} service="meetingUrls" compact />
        </form>
        <section className="card stack">
          <h2 className="section-title-sm">
            <Icon name="record" /> {t("meetings.record")}
          </h2>
          <p className="muted">{t("meetings.recordLede")}</p>
          <Recorder workspaceId={workspace.id} projectId={projectId || undefined} language={language} />
        </section>
      </div>
      <section>
        <h2 className="section-title-sm" style={{ marginBottom: 12 }}>
          {t("meetings.list")}
        </h2>
        {meetings.isPending ? (
          <LoadingBlock rows={3} />
        ) : meetings.isError ? (
          <ErrorNotice error={meetings.error} />
        ) : meetings.data.length === 0 ? (
          <EmptyState title={t("meetings.empty")} body={t("meetings.emptyBody")} />
        ) : (
          <ul className="list">
            {meetings.data.map((m) => (
              <li key={m.id}>
                <div className="stack" style={{ gap: 4 }}>
                  <Link href={`/app/meetings/${m.id}`} style={{ fontWeight: 560 }}>
                    {m.title ?? m.id}
                  </Link>
                  <span className="hint">
                    {t(`meetings.source.${m.source}` as MessageKey)} · {formatDate(m.createdAt, locale)}
                    {m.retentionUntil && ` · ${t("meetings.retention", { date: formatDate(m.retentionUntil, locale, false) })}`}
                  </span>
                </div>
                <span className={`badge ${m.status === "ready" ? "badge-ok" : m.status === "failed" ? "badge-bad" : "badge-warn"}`}>{t(`meetings.status.${m.status}` as MessageKey)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
