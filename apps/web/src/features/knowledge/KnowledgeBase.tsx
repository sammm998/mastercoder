"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC } from "@/lib/trpc";
import { ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { CrewAvatar } from "@/components/CrewAvatar";

/**
 * Settings → Knowledge: train Scoutr on the company (crawl a website or paste text). The editable
 * profile and the most relevant facts are given as context to every build, chat and agent.
 */
export function KnowledgeBase({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const busyRef = { current: false };
  const q = useQuery({
    ...trpc.knowledge.overview.queryOptions({ workspaceId }),
    refetchInterval: (query) => ((query.state.data?.sources ?? []).some((s) => s.status === "queued" || s.status === "crawling") ? 3000 : false),
  });
  busyRef.current = (q.data?.sources ?? []).some((s) => s.status === "queued" || s.status === "crawling");
  const inv = () => qc.invalidateQueries({ queryKey: trpc.knowledge.overview.queryKey({ workspaceId }) });
  const addUrl = useMutation(trpc.knowledge.addUrl.mutationOptions({ onSuccess: inv }));
  const addText = useMutation(trpc.knowledge.addText.mutationOptions({ onSuccess: inv }));
  const remove = useMutation(trpc.knowledge.remove.mutationOptions({ onSuccess: inv }));
  const recrawl = useMutation(trpc.knowledge.recrawl.mutationOptions({ onSuccess: inv }));
  const save = useMutation(trpc.knowledge.updateProfile.mutationOptions({ onSuccess: inv }));
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"url" | "text">("url");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [profile, setProfile] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setProfile(q.data?.profile?.profile ?? "");
  }, [q.data?.profile?.profile, editing]);
  const validUrl = /^https?:\/\/[^\s.]+\.[^\s]+$/.test(url.trim());

  return (
    <section className="card stack kb" aria-labelledby="kb-title">
      <div className="kb-head">
        <CrewAvatar id="plania" size={40} />
        <div>
          <h2 id="kb-title" className="section-title-sm">
            {t("knowledge.title")}
          </h2>
          <p className="muted">{t("knowledge.lede")}</p>
        </div>
      </div>

      {canManage && (
        <div className="kb-add">
          <div className="seg" role="group" aria-label={t("knowledge.addLabel")}>
            <button type="button" aria-pressed={mode === "url"} onClick={() => setMode("url")}>
              <Icon name="globe" size={14} /> {t("knowledge.fromUrl")}
            </button>
            <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
              <Icon name="file" size={14} /> {t("knowledge.fromText")}
            </button>
          </div>
          {mode === "url" ? (
            <form
              className="kb-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (validUrl) addUrl.mutate({ workspaceId, url: url.trim() }, { onSuccess: () => setUrl("") });
              }}
            >
              <label htmlFor="kb-url" className="sr-only">
                {t("knowledge.urlLabel")}
              </label>
              <input id="kb-url" className="input" type="url" placeholder="https://www.ditt-foretag.se" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button type="submit" className="btn btn-primary" disabled={!validUrl || addUrl.isPending}>
                {t("knowledge.crawl")}
              </button>
            </form>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (title.trim() && text.trim().length >= 20) addText.mutate({ workspaceId, title: title.trim(), text }, { onSuccess: () => (setTitle(""), setText("")) });
              }}
            >
              <div className="field">
                <label htmlFor="kb-title-in">{t("knowledge.textTitle")}</label>
                <input id="kb-title-in" className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={t("knowledge.textTitlePh")} />
              </div>
              <div className="field">
                <label htmlFor="kb-text">{t("knowledge.textBody")}</label>
                <textarea id="kb-text" className="textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("knowledge.textBodyPh")} />
              </div>
              <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }} disabled={!title.trim() || text.trim().length < 20 || addText.isPending}>
                {t("knowledge.addText")}
              </button>
            </form>
          )}
          <p className="hint">{t("knowledge.hint")}</p>
          <ErrorNotice error={addUrl.error ?? addText.error} compact />
        </div>
      )}

      {q.isPending ? (
        <LoadingBlock rows={2} />
      ) : q.isError ? (
        <ErrorNotice error={q.error} />
      ) : (
        <>
          {q.data.sources.length > 0 && (
            <ul className="kb-sources">
              {q.data.sources.map((s) => (
                <li key={s.id}>
                  <Icon name={s.kind === "url" ? "globe" : "file"} size={16} />
                  <div className="kb-src-text">
                    <strong>{s.title}</strong>
                    <span className="hint">
                      {s.kind === "url" ? t("knowledge.pages", { count: s.pages }) : t("knowledge.textSource")} · {formatDate(s.updatedAt, locale)}
                      {s.error ? ` · ${s.error}` : ""}
                    </span>
                  </div>
                  <span className={`badge ${s.status === "ready" ? "badge-ok" : s.status === "failed" ? "badge-bad" : "badge-warn"}`}>{t(`knowledge.status.${s.status}` as MessageKey)}</span>
                  {canManage && s.kind === "url" && (
                    <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={t("knowledge.recrawl")} title={t("knowledge.recrawl")} onClick={() => recrawl.mutate({ sourceId: s.id })}>
                      <Icon name="refresh" size={14} />
                    </button>
                  )}
                  {canManage && (
                    <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => window.confirm(t("knowledge.removeConfirm", { title: s.title })) && remove.mutate({ sourceId: s.id })}>
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="kb-profile">
            <div className="row-between">
              <h3 className="label">{t("knowledge.profile")}</h3>
              {q.data.profile && <span className="hint">{q.data.profile.generatedBy === "user" ? t("knowledge.editedByYou") : t("knowledge.generated")}</span>}
            </div>
            {!q.data.profile && !editing ? (
              <p className="hint">{busyRef.current ? t("knowledge.building") : t("knowledge.noProfile")}</p>
            ) : (
              <textarea
                className="textarea kb-profile-text"
                rows={12}
                value={profile}
                readOnly={!canManage}
                onFocus={() => setEditing(true)}
                onChange={(e) => setProfile(e.target.value)}
                aria-label={t("knowledge.profile")}
              />
            )}
            {canManage && editing && (
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate({ workspaceId, profile }, { onSuccess: () => setEditing(false) })}>
                  {t("knowledge.saveProfile")}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
                  {t("common.cancel")}
                </button>
              </div>
            )}
            <ErrorNotice error={save.error ?? remove.error ?? recrawl.error} compact />
          </div>
        </>
      )}
    </section>
  );
}
