"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { selectorForSrc, type ForgeSelectMessage } from "@forge/visual-edit/protocol";
import { useT } from "@/i18n/client";
import { useTRPC } from "@/lib/trpc";
import { latest } from "@/lib/events";
import { useProjectEvents } from "@/lib/useProjectEvents";
import { colorFor, initials } from "@/lib/collab";
import { ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { useWorkspace } from "@/app/app/workspace-context";
import { ChatPanel } from "../chat/ChatPanel";
import { PreviewPane, type PreviewMode } from "../preview/PreviewPane";
import { VisualEditPanel } from "../preview/VisualEditPanel";
import { CodePane } from "../editor/CodePane";
import type { CollabHandle } from "../editor/CollabEditor";
import { CommentsPanel, type CommentTarget } from "./CommentsPanel";
import { HistoryPanel, useRestore } from "./HistoryPanel";
import { MediaPanel } from "./MediaPanel";
import { SlidesPanel } from "../slides/SlidesPanel";
import { DeployPanel } from "../deploy/DeployPanel";

const TABS = ["preview", "code", "comments", "history", "media", "slides", "deploy"] as const;
type Tab = (typeof TABS)[number];
const WRITE_ROLES = new Set(["owner", "admin", "editor"]);

export function ProjectWorkspace({ projectId, initialTab = "preview" }: { projectId: string; initialTab?: Tab }) {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { user, workspace } = useWorkspace();
  const project = useQuery(trpc.project.get.queryOptions({ projectId }));
  const displayName = user.name || user.email;
  const { events, state, presence } = useProjectEvents(projectId, project.data ? { name: displayName } : null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([initialTab]));
  const [mode, setMode] = useState<PreviewMode>("browse");
  const [selection, setSelection] = useState<ForgeSelectMessage | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [reloadKey] = useState(0);
  const [collab, setCollab] = useState<{ path: string; handle: CollabHandle } | null>(null);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [requestedFile, setRequestedFile] = useState<{ path: string; line?: number; nonce: number } | null>(null);
  const restore = useRestore(projectId);
  const setPublic = useMutation(trpc.project.setPublic.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.project.get.queryKey({ projectId }) }) }));
  const remix = useMutation(trpc.project.remix.mutationOptions({ onSuccess: (r) => router.push(`/app/p/${r.id}`) }));

  const preview = useMemo(() => latest(events, "preview.ready"), [events]);
  const go = (next: Tab) => {
    setTab(next);
    setVisited((v) => (v.has(next) ? v : new Set([...v, next])));
  };
  const onCollab = useCallback((path: string | null, h: CollabHandle | null) => setCollab(path && h ? { path, handle: h } : null), []);

  if (project.isPending) {
    return (
      <div className="page">
        <LoadingBlock rows={6} />
      </div>
    );
  }
  if (project.isError) {
    return (
      <div className="page">
        <ErrorNotice error={project.error} />
        <Link href="/app" className="btn" style={{ justifySelf: "start" }}>
          {t("common.back")}
        </Link>
      </div>
    );
  }
  const p = project.data;
  const canWrite = WRITE_ROLES.has(p.role ?? "");
  const others = presence.filter((x) => x.userId !== user.id);

  const onSelect = (m: ForgeSelectMessage, m2: PreviewMode) => {
    setHighlight(m.src);
    if (m2 === "comment") {
      setCommentTarget({ selector: selectorForSrc(m.src), label: t("project.comments.newOnElement", { tag: m.tag }) });
      go("comments");
    } else setSelection(m);
  };

  return (
    <div className="ws">
      <header className="ws-head">
        <div className="row" style={{ gap: 12, minWidth: 0 }}>
          <Link href="/app" className="btn btn-ghost btn-icon btn-sm" aria-label={t("common.back")}>
            <span aria-hidden="true">←</span>
          </Link>
          <h1 className="ws-title" title={p.name}>
            {p.name || t("project.untitled")}
          </h1>
          {p.role && <span className="badge">{p.role}</span>}
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="avatars" aria-label={t("project.header.presence", { count: others.length + 1 })} data-testid="project-presence">
            <span className="avatar" style={{ ["--c" as string]: colorFor(displayName) }} title={`${displayName} (${t("common.you")})`}>
              {initials(displayName)}
            </span>
            {others.map((o) => (
              <span key={o.userId} className="avatar" style={{ ["--c" as string]: colorFor(o.name) }} title={o.name}>
                {initials(o.name)}
              </span>
            ))}
          </div>
          {canWrite && (
            <label className="switch" title={t("project.header.shareHint")}>
              <input type="checkbox" checked={p.isPublic} disabled={setPublic.isPending} onChange={(e) => setPublic.mutate({ projectId, isPublic: e.target.checked })} data-testid="share-toggle" />
              <Icon name="globe" size={14} /> {t("project.header.share")}
            </label>
          )}
          {!canWrite && (
            <button type="button" className="btn btn-sm btn-primary" disabled={remix.isPending} onClick={() => remix.mutate({ projectId, workspaceId: workspace.id })}>
              {t("project.remix")}
            </button>
          )}
          {canWrite && (
            <button type="button" className="btn btn-sm btn-ink" onClick={() => go("deploy")}>
              <Icon name="rocket" size={14} /> {t("project.header.deploy")}
            </button>
          )}
        </div>
      </header>
      {!canWrite && <p className="notice ws-readonly">{t("project.readOnly")}</p>}
      <ErrorNotice error={setPublic.error ?? remix.error} compact />
      <div className="ws-body">
        <ChatPanel projectId={projectId} events={events} socket={state} canWrite={canWrite} onRestore={restore.run} />
        <section className="ws-main" aria-label={t("project.tabs.label")}>
          <div className="tabs ws-tabs" role="tablist" aria-label={t("project.tabs.label")}>
            {TABS.map((x) => (
              <button key={x} type="button" role="tab" id={`tab-${x}`} aria-controls={`panel-${x}`} className="tab" aria-selected={tab === x} onClick={() => go(x)} data-testid={`tab-${x}`}>
                {t(`project.tabs.${x}`)}
              </button>
            ))}
          </div>
          {TABS.filter((x) => visited.has(x)).map((x) => (
            <div key={x} role="tabpanel" id={`panel-${x}`} aria-labelledby={`tab-${x}`} className={`ws-panel ws-panel-${x}`} hidden={tab !== x}>
              {x === "preview" && (
                <div className="ws-preview" data-editing={!!selection && mode === "edit"}>
                  <PreviewPane
                    url={preview?.url ?? null}
                    mode={mode}
                    onModeChange={(m) => {
                      setMode(m);
                      if (m === "browse") {
                        setSelection(null);
                        setHighlight(null);
                      }
                    }}
                    onSelect={onSelect}
                    highlight={highlight}
                    reloadKey={reloadKey}
                    canWrite={canWrite}
                  />
                  {selection && mode === "edit" && (
                    <VisualEditPanel
                      key={selection.src}
                      projectId={projectId}
                      selection={selection}
                      collab={collab}
                      onClose={() => {
                        setSelection(null);
                        setHighlight(null);
                      }}
                      onSaved={() => setHighlight(selection.src)}
                    />
                  )}
                </div>
              )}
              {x === "code" && (
                <CodePane
                  projectId={projectId}
                  userName={displayName}
                  canWrite={canWrite}
                  events={events}
                  onCollab={onCollab}
                  requestedFile={requestedFile}
                  onCommentLine={(path, line) => {
                    setCommentTarget({ path, selector: `line:${line}`, label: t("project.comments.newOnLine", { path, line }) });
                    go("comments");
                  }}
                />
              )}
              {x === "comments" && (
                <CommentsPanel
                  projectId={projectId}
                  canComment={!!p.role}
                  target={commentTarget}
                  onClearTarget={() => setCommentTarget(null)}
                  onShowElement={(src) => {
                    setHighlight(src);
                    go("preview");
                  }}
                  onShowLine={(path, line) => {
                    setRequestedFile({ path, line: line ?? undefined, nonce: Date.now() });
                    go("code");
                  }}
                />
              )}
              {x === "history" && <HistoryPanel projectId={projectId} events={events} canWrite={canWrite} restore={restore} />}
              {x === "media" && <MediaPanel projectId={projectId} events={events} canWrite={canWrite} />}
              {x === "slides" && <SlidesPanel projectId={projectId} events={events} canWrite={canWrite} brand={p.brand} />}
              {x === "deploy" && <DeployPanel projectId={projectId} events={events} canDeploy={canWrite} />}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
