"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { selectorForSrc, type ForgeSelectMessage } from "@forge/visual-edit/protocol";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC } from "@/lib/trpc";
import { latest } from "@/lib/events";
import { currentTaskId, teamRuns } from "@/lib/agent-run";
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
import { LiveRun } from "./LiveRun";
import { SlidesPanel } from "../slides/SlidesPanel";
import { DeployPanel } from "../deploy/DeployPanel";
import { AppCatalog } from "../integrations/AppCatalog";
import "@/styles/integrations.css";

const TABS = ["preview", "run", "code", "comments", "history", "media", "slides", "integrations", "deploy"] as const;
type Tab = (typeof TABS)[number];
const TAB_ICON = { preview: "eye", run: "users", code: "code", comments: "comment", history: "history", media: "image", slides: "slides", integrations: "plug", deploy: "rocket" } as const;
const WRITE_ROLES = new Set(["owner", "admin", "editor"]);
const ROLES = ["owner", "admin", "editor", "viewer"];
const CHAT_W_KEY = "forge.chatWidth";
const CHAT_MIN = 320;
const CHAT_MAX = 760;

function readWidth(): number | null {
  try {
    const v = Number(window.localStorage.getItem(CHAT_W_KEY));
    return Number.isFinite(v) && v >= CHAT_MIN && v <= CHAT_MAX ? v : null;
  } catch {
    return null;
  }
}

export function isTab(v: unknown): v is Tab {
  return typeof v === "string" && (TABS as readonly string[]).includes(v);
}

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
  const [pane, setPane] = useState<"agent" | "workspace">("agent");
  const [mode, setMode] = useState<PreviewMode>("browse");
  const [selection, setSelection] = useState<ForgeSelectMessage | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [reloadKey] = useState(0);
  const [collab, setCollab] = useState<{ path: string; handle: CollabHandle } | null>(null);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [requestedFile, setRequestedFile] = useState<{ path: string; line?: number; nonce: number } | null>(null);
  const [chatW, setChatW] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Task during which the person picked a tab themselves: we then don't auto-switch to Preview. */
  const pickedDuring = useRef<string | null>(null);
  const restore = useRestore(projectId);
  const setPublic = useMutation(trpc.project.setPublic.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.project.get.queryKey({ projectId }) }) }));
  const remix = useMutation(trpc.project.remix.mutationOptions({ onSuccess: (r) => router.push(`/app/p/${r.id}`) }));

  const preview = useMemo(() => latest(events, "preview.ready"), [events]);
  const focusTask = useMemo(() => currentTaskId(events), [events]);
  const runs = useMemo(() => teamRuns(events), [events]);
  const run = focusTask ? runs.get(focusTask) : undefined;

  const go = useCallback((next: Tab) => {
    setTab(next);
    setVisited((v) => (v.has(next) ? v : new Set([...v, next])));
  }, []);
  const pick = (next: Tab) => {
    pickedDuring.current = focusTask ?? null;
    go(next);
    setPane("workspace");
  };
  const onCollab = useCallback((path: string | null, h: CollabHandle | null) => setCollab(path && h ? { path, handle: h } : null), []);

  // A new preview: show it, unless the person chose another tab during this task.
  const seenPreview = useRef<string | null>(null);
  useEffect(() => {
    if (!preview) return;
    if (seenPreview.current === null) {
      seenPreview.current = preview.id; // the preview from history doesn't steal focus
      return;
    }
    if (seenPreview.current === preview.id) return;
    seenPreview.current = preview.id;
    if (!preview.taskId || pickedDuring.current !== preview.taskId) go("preview");
  }, [preview, go]);

  useEffect(() => setChatW(readWidth()), []);
  const saveWidth = (w: number) => {
    const v = Math.round(Math.min(CHAT_MAX, Math.max(CHAT_MIN, w)));
    setChatW(v);
    try {
      window.localStorage.setItem(CHAT_W_KEY, String(v));
    } catch {
      /* private mode: keep it for this visit only */
    }
  };
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    const left = body.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => saveWidth(ev.clientX - left);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("is-resizing");
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const currentW = chatW ?? 420;
  const onResizeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") saveWidth(currentW - 24);
    else if (e.key === "ArrowRight") saveWidth(currentW + 24);
    else return;
    e.preventDefault();
  };

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
    <div className="ws" data-pane={pane}>
      <header className="ws-head">
        <div className="ws-head-left">
          <Link href="/app" className="btn btn-ghost btn-icon btn-sm" aria-label={t("common.back")} data-tip={t("common.back")}>
            <Icon name="arrowLeft" size={16} />
          </Link>
          <h1 className="ws-title" title={p.name}>
            {p.name || t("project.untitled")}
          </h1>
          {p.role && <span className="badge">{ROLES.includes(p.role) ? t(`settings.roles.${p.role}` as MessageKey) : p.role}</span>}
        </div>
        <div className="seg ws-pane-switch" role="group" aria-label={t("project.pane.label")}>
          {(["agent", "workspace"] as const).map((x) => (
            <button key={x} type="button" aria-pressed={pane === x} onClick={() => setPane(x)} data-testid={`pane-${x}`}>
              {t(`project.pane.${x}`)}
            </button>
          ))}
        </div>
        <div className="ws-head-right">
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
            <label className="switch ws-share" title={t("project.header.shareHint")}>
              <input type="checkbox" checked={p.isPublic} disabled={setPublic.isPending} onChange={(e) => setPublic.mutate({ projectId, isPublic: e.target.checked })} data-testid="share-toggle" />
              <Icon name="globe" size={14} /> <span className="ws-share-label">{t("project.header.share")}</span>
            </label>
          )}
          {!canWrite && (
            <button type="button" className="btn btn-sm btn-primary" disabled={remix.isPending} onClick={() => remix.mutate({ projectId, workspaceId: workspace.id })}>
              {t("project.remix")}
            </button>
          )}
          {canWrite && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => pick("deploy")}>
              <Icon name="rocket" size={14} /> {t("project.header.deploy")}
            </button>
          )}
        </div>
      </header>
      {!canWrite && <p className="notice ws-readonly">{t("project.readOnly")}</p>}
      <ErrorNotice error={setPublic.error ?? remix.error} compact />
      <div className="ws-body" ref={bodyRef} style={chatW ? { ["--chat-w" as string]: `${chatW}px` } : undefined}>
        <ChatPanel projectId={projectId} events={events} socket={state} canWrite={canWrite} onRestore={restore.run} />
        <div
          className="ws-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("project.resize")}
          aria-valuemin={CHAT_MIN}
          aria-valuemax={CHAT_MAX}
          aria-valuenow={currentW}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
          onDoubleClick={() => saveWidth(420)}
        />
        <section className="ws-main" aria-label={t("project.tabs.label")}>
          <div className="ws-tabbar">
            <div className="tabs ws-tabs" role="tablist" aria-label={t("project.tabs.label")}>
              {TABS.map((x) => (
                <button key={x} type="button" role="tab" id={`tab-${x}`} aria-controls={`panel-${x}`} className="tab" aria-selected={tab === x} onClick={() => pick(x)} data-testid={`tab-${x}`}>
                  <Icon name={TAB_ICON[x]} size={14} />
                  {t(`project.tabs.${x}`)}
                </button>
              ))}
            </div>
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
                    placeholder={<LiveRun events={events} taskId={focusTask} run={run} variant="preview" />}
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
              {x === "run" && <LiveRun events={events} taskId={focusTask} run={run} variant="tab" />}
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
              {x === "integrations" && (
                <div className="ws-integrations">
                  <AppCatalog workspaceId={workspace.id} projectId={projectId} canConnect={canWrite} canManageShared={workspace.role === "owner" || workspace.role === "admin"} />
                </div>
              )}
              {x === "deploy" && <DeployPanel projectId={projectId} events={events} canDeploy={canWrite} />}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
