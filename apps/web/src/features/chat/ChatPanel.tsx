"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatUsd } from "@/i18n/format";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { toChatItems, toolResults, type ForgeEvent } from "@/lib/events";
import { attachmentPath, isFigmaUrl, isTextFile, MAX_ATTACHMENT_BYTES, promptWithAttachments, readAsDataUrl, readAsText, type StoredAttachment } from "@/lib/attachments";
import type { SocketState } from "@/lib/useProjectEvents";
import { PromptComposer, type ComposerSubmit } from "@/components/PromptComposer";
import { ErrorNotice } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { EventCard, summarizeTasks } from "./EventCard";

const ACTIVE = new Set(["queued", "running", "awaiting_clarification", "awaiting_approval"]);
const REFRESH_ON = new Set(["task.completed", "task.failed", "clarify.question", "plan.ready", "phase.started"]);

export function ChatPanel({ projectId, events, socket, canWrite, onRestore }: { projectId: string; events: ForgeEvent[]; socket: SocketState; canWrite: boolean; onRestore: (checkpointId: string, label: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const tasks = useQuery({ ...trpc.task.list.queryOptions({ projectId }), enabled: canWrite });
  const createTask = useMutation(trpc.task.create.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.task.list.queryKey({ projectId }) }) }));
  const cancel = useMutation(trpc.task.cancel.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.task.list.queryKey({ projectId }) }) }));
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [figma, setFigma] = useState("");
  const [figmaOpen, setFigmaOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const lastRefresh = useMemo(() => [...events].reverse().find((e) => REFRESH_ON.has(e.type))?.id, [events]);
  useEffect(() => {
    if (lastRefresh) void qc.invalidateQueries({ queryKey: trpc.task.list.queryKey({ projectId }) });
  }, [lastRefresh, qc, trpc, projectId]);

  const taskMap = useMemo(() => new Map((tasks.data ?? []).map((x) => [x.id, x])), [tasks.data]);
  const results = useMemo(() => toolResults(events), [events]);
  const summaries = useMemo(() => summarizeTasks(events), [events]);
  const usage = useMemo(() => events.reduce((s, e) => (e.type === "usage" ? s + e.costUsd : s), 0), [events]);

  const timeline = useMemo(() => {
    const items = toChatItems(events).map((i) => ({ ...i, sort: i.at }));
    const prompts = (tasks.data ?? []).map((task) => ({ key: `task-${task.id}`, kind: "user" as const, text: task.prompt, taskId: task.id, at: new Date(task.createdAt).toISOString(), sort: new Date(task.createdAt).toISOString(), source: task.source }));
    return [...prompts, ...items].sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : a.kind === "user" ? -1 : 1));
  }, [events, tasks.data]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [timeline.length, events.length]);

  const activeTask = (tasks.data ?? []).find((x) => ACTIVE.has(x.status));

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next: File[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_ATTACHMENT_BYTES) setFileError(t("project.chat.tooLarge", { name: f.name }));
      else next.push(f);
    }
    setFiles((cur) => [...cur, ...next].slice(0, 10));
  };

  const submit = async ({ prompt, source, planMode }: ComposerSubmit) => {
    setUploadError(null);
    const stored: StoredAttachment[] = [];
    if (files.length) {
      setUploading(true);
      try {
        const now = Date.now();
        for (const [i, f] of files.entries()) {
          const binary = !isTextFile(f);
          const path = attachmentPath(f.name, now + i, binary);
          const content = binary ? await readAsDataUrl(f) : await readAsText(f);
          await client.project.writeFile.mutate({ projectId, path, content });
          stored.push({ path, name: f.name, type: f.type, binary });
        }
      } catch (e) {
        setUploadError(e);
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    const figmaUrl = figma && isFigmaUrl(figma) ? figma : undefined;
    await createTask.mutateAsync({ projectId, prompt: promptWithAttachments(prompt, stored, figmaUrl), source, planMode });
    setFiles([]);
    setFigma("");
    setFigmaOpen(false);
  };

  return (
    <section className="chat" aria-label={t("project.chat.title")}>
      <header className="chat-head">
        <div className="row" style={{ gap: 8 }}>
          <h2 className="eyebrow" style={{ fontWeight: 500 }}>
            {t("project.chat.title")}
          </h2>
          <span className={`dot status-${socket}`} aria-hidden="true" />
          <span className="subtle" style={{ fontSize: "0.76rem" }}>
            {t(`project.chat.connection.${socket}`)}
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {usage > 0 && <span className="badge">{t("project.chat.usage", { cost: formatUsd(usage, locale) })}</span>}
          {activeTask && canWrite && (
            <button type="button" className="btn btn-sm btn-danger" onClick={() => cancel.mutate({ taskId: activeTask.id })} disabled={cancel.isPending}>
              <Icon name="stop" size={12} /> {t("project.chat.cancel")}
            </button>
          )}
        </div>
      </header>
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        data-testid="chat-log"
      >
        {timeline.length === 0 ? (
          <p className="chat-empty muted">{t("project.chat.empty")}</p>
        ) : (
          timeline.map((item) => {
            if (item.kind === "user") {
              const task = item.taskId ? taskMap.get(item.taskId) : undefined;
              return (
                <div key={item.key} className="bubble bubble-user">
                  <p>{item.text.split("\n\nAttachments (saved in the project):")[0]}</p>
                  <div className="bubble-meta">
                    <span>{t("project.chat.you")}</span>
                    {"source" in item && item.source && item.source !== "typed" && <span>· {t(`project.chat.source.${item.source}` as MessageKey)}</span>}
                    {task && <span className={`badge ${task.status === "succeeded" ? "badge-ok" : task.status === "failed" ? "badge-bad" : ""}`}>{t(`project.chat.status.${task.status}` as MessageKey)}</span>}
                  </div>
                </div>
              );
            }
            if (item.kind === "assistant" || item.kind === "system")
              return (
                <div key={item.key} className={`bubble bubble-${item.kind}`}>
                  <p>{item.text}</p>
                </div>
              );
            return item.event ? (
              <div key={item.key} className="chat-event">
                <EventCard e={item.event} tasks={taskMap} results={results} summaries={summaries} onRestore={onRestore} onShowScreenshot={setLightbox} />
              </div>
            ) : null;
          })
        )}
      </div>
      {canWrite && (
        <div className="chat-compose">
          {(files.length > 0 || figmaOpen) && (
            <div className="chat-attachments">
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} className="chip" aria-pressed={false}>
                  <Icon name="file" size={12} /> {f.name}
                  <button type="button" className="chip-x" aria-label={t("project.chat.removeAttachment", { name: f.name })} onClick={() => setFiles((cur) => cur.filter((_, k) => k !== i))}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              {figmaOpen && (
                <div className="field" style={{ width: "100%" }}>
                  <label htmlFor="figma-url" className="sr-only">
                    {t("project.chat.figma")}
                  </label>
                  <input id="figma-url" className="input" placeholder="https://www.figma.com/design/…" value={figma} onChange={(e) => setFigma(e.target.value)} aria-invalid={!!figma && !isFigmaUrl(figma)} />
                  {figma && !isFigmaUrl(figma) && <p className="hint">{t("project.chat.figmaInvalid")}</p>}
                </div>
              )}
            </div>
          )}
          {fileError && (
            <p className="notice notice-warn" role="alert">
              {fileError}
            </p>
          )}
          {uploading && <p className="hint">{t("project.chat.uploading")}</p>}
          <ErrorNotice error={uploadError ?? createTask.error} service={createTask.error ? "intent" : undefined} compact />
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} accept="image/*,.txt,.md,.csv,.json,.pdf,.yaml,.yml,.html,.css,.tsx,.ts,.js,.jsx" />
          <PromptComposer
            variant="chat"
            onSubmit={(s) => submit(s).catch(() => undefined)}
            ensureProject={async () => projectId}
            busy={createTask.isPending || uploading}
            placeholder={t("project.chat.placeholder")}
            submitLabel={t("project.chat.send")}
            extra={
              <>
                <button type="button" className="btn btn-icon btn-ghost" onClick={() => fileInput.current?.click()} aria-label={t("project.chat.attach")} title={t("project.chat.attach")}>
                  <Icon name="paperclip" />
                </button>
                <button type="button" className="btn btn-icon btn-ghost" aria-pressed={figmaOpen} onClick={() => setFigmaOpen((o) => !o)} aria-label={t("project.chat.figmaAdd")} title={t("project.chat.figmaAdd")}>
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                    <path d="M8 2h4v6H8a3 3 0 0 1 0-6zm4 0h4a3 3 0 0 1 0 6h-4zM8 8h4v6H8a3 3 0 0 1 0-6zm8 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8 14h4v3a3 3 0 1 1-4-3z" />
                  </svg>
                </button>
              </>
            }
          />
        </div>
      )}
      {lightbox && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={t("project.chat.screenshots")} onClick={() => setLightbox(null)} onKeyDown={(e) => e.key === "Escape" && setLightbox(null)}>
          {/* Screenshots are served from the object store; plain img keeps them out of the Next image optimiser. */}
          <img src={lightbox} alt="" />
          <button type="button" className="btn btn-icon lightbox-close" aria-label={t("common.close")} autoFocus onClick={() => setLightbox(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
    </section>
  );
}
