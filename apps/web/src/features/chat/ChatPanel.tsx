"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { toChatItems, toolResults, type EventOf, type ForgeEvent } from "@/lib/events";
import { currentTaskId, eventsOf, groupTimeline, phaseSteps, taskCost, teamRuns } from "@/lib/agent-run";
import { attachmentPath, isFigmaUrl, isTextFile, MAX_ATTACHMENT_BYTES, promptWithAttachments, readAsDataUrl, readAsText, type StoredAttachment } from "@/lib/attachments";
import { taskCreateInput } from "@/lib/task-input";
import type { SocketState } from "@/lib/useProjectEvents";
import { ComposerIcon, PromptComposer, type ComposerSubmit } from "@/components/PromptComposer";
import { ErrorNotice } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { CrewAvatar } from "@/components/CrewAvatar";
import { Details, EventCard, GatesCard, summarizeTasks, ToolGroup } from "./EventCard";
import { TeamThread } from "./TeamThread";
import { CostMeter, PhaseStepper } from "./RunWidgets";

const ACTIVE = new Set(["queued", "running", "awaiting_clarification", "awaiting_approval"]);
const REFRESH_ON = new Set(["task.completed", "task.failed", "clarify.question", "plan.ready", "phase.started"]);

/** Long agent reports are clamped to a few lines with a Show more toggle. */
function LongText({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = text.length > 420;
  return (
    <>
      <p className={long && !open ? "clamp" : undefined}>{text}</p>
      {long && (
        <button type="button" className="ev-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t("common.showLess") : t("common.showMore")}
        </button>
      )}
    </>
  );
}

type Item = { key: string; kind: "user" | "assistant" | "system" | "event" | "team"; text?: string; event?: ForgeEvent; taskId?: string; at: string; sort: string; source?: string };

export function ChatPanel({ projectId, events, socket, canWrite, onRestore }: { projectId: string; events: ForgeEvent[]; socket: SocketState; canWrite: boolean; onRestore: (checkpointId: string, label: string) => void }) {
  const t = useT();
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
  const runs = useMemo(() => teamRuns(events), [events]);
  const focusTask = useMemo(() => currentTaskId(events), [events]);
  const focusEvents = useMemo(() => eventsOf(events, focusTask), [events, focusTask]);
  const steps = useMemo(() => phaseSteps(focusEvents), [focusEvents]);
  const cost = useMemo(() => taskCost(focusEvents), [focusEvents]);
  const focusIsChat = focusTask ? runs.get(focusTask)?.chat === true : false;
  const showStepper = focusTask && !focusIsChat && focusEvents.some((e) => e.type === "phase.started");

  const timeline = useMemo(() => {
    const items: Item[] = toChatItems(events).map((i) => ({ ...i, sort: i.at }));
    const prompts: Item[] = (tasks.data ?? []).map((task) => ({ key: `task-${task.id}`, kind: "user", text: task.prompt, taskId: task.id, at: new Date(task.createdAt).toISOString(), sort: new Date(task.createdAt).toISOString(), source: task.source }));
    const team: Item[] = [...runs.values()].filter((r) => !r.chat).map((r) => ({ key: `team-${r.taskId}`, kind: "team", taskId: r.taskId, at: r.messages[r.messages.length - 1]!.at, sort: r.messages[r.messages.length - 1]!.at }));
    return [...prompts, ...team, ...items].sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : a.kind === "user" ? -1 : 1));
  }, [events, tasks.data, runs]);
  const grouped = useMemo(() => groupTimeline(timeline), [timeline]);

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

  const submit = async (s: ComposerSubmit) => {
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
    await createTask.mutateAsync(taskCreateInput(projectId, promptWithAttachments(s.prompt, stored, figmaUrl), s));
    setFiles([]);
    setFigma("");
    setFigmaOpen(false);
  };

  return (
    <section className="chat" aria-label={t("project.chat.title")}>
      <header className="chat-head">
        <div className="chat-head-row">
          <h2 className="chat-title">
            <CrewAvatar id="scoutr" size={24} />
            {t("project.chat.title")}
          </h2>
          <span className={`conn conn-${socket}`}>
            <span className={`dot status-${socket}`} aria-hidden="true" />
            {t(`project.chat.connection.${socket}`)}
          </span>
          <span className="grow" />
          {focusTask && (cost.tokens > 0 || cost.highUsd !== null) && <CostMeter cost={cost} />}
          {activeTask && canWrite && (
            <button type="button" className="btn btn-sm btn-danger chat-stop" onClick={() => cancel.mutate({ taskId: activeTask.id })} disabled={cancel.isPending} aria-label={t("project.chat.cancel")} data-tip={t("project.chat.cancel")}>
              <Icon name="stop" size={11} />
              <span className="chat-stop-label">{t("project.chat.stop")}</span>
            </button>
          )}
        </div>
        {showStepper && <PhaseStepper steps={steps} />}
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
          <div className="chat-empty">
            <span className="orb chat-empty-orb" aria-hidden="true">
              <img src="/brand/avatars/scoutr.webp" alt="" width={84} height={84} className="orb-mascot" />
            </span>
            <p>{t("project.chat.empty")}</p>
          </div>
        ) : (
          <ol className="timeline-list">
            {grouped.map((g) => {
              if (g.kind === "gates") {
                const res = g.items.map((i) => i.event).filter((e): e is EventOf<"gate.result"> => e?.type === "gate.result");
                return (
                  <li key={g.key} className="tl-item">
                    <GatesCard results={res} />
                  </li>
                );
              }
              if (g.kind === "tools") {
                const calls = g.items.map((i) => i.event).filter((e): e is EventOf<"tool.call"> => e?.type === "tool.call");
                return (
                  <li key={g.key} className="tl-item">
                    <ToolGroup calls={calls} results={results} />
                  </li>
                );
              }
              const item = g.item;
              if (item.kind === "user") {
                const task = item.taskId ? taskMap.get(item.taskId) : undefined;
                return (
                  <li key={item.key} className="tl-item tl-user">
                    <div className="bubble bubble-user">
                      <p>{(item.text ?? "").split("\n\nAttachments (saved in the project):")[0]}</p>
                      <div className="bubble-meta">
                        <span>{t("project.chat.you")}</span>
                        {item.source && item.source !== "typed" && <span>· {t(`project.chat.source.${item.source}` as MessageKey)}</span>}
                        {task && <span className={`badge ${task.status === "succeeded" ? "badge-ok" : task.status === "failed" ? "badge-bad" : ""}`}>{t(`project.chat.status.${task.status}` as MessageKey)}</span>}
                      </div>
                    </div>
                  </li>
                );
              }
              if (item.kind === "team") {
                const run = item.taskId ? runs.get(item.taskId) : undefined;
                return run ? (
                  <li key={item.key} className="tl-item">
                    <TeamThread run={run} />
                  </li>
                ) : null;
              }
              if (item.kind === "assistant" || item.kind === "system") {
                const chat = item.taskId ? runs.get(item.taskId)?.chat : false;
                // System notes are server-generated (English) status text: keep them behind "Details".
                if (item.kind === "system")
                  return (
                    <li key={item.key} className="tl-item tl-system">
                      <Details label={t("project.chat.systemNote")}>
                        <p className="ev-raw">{item.text}</p>
                      </Details>
                    </li>
                  );
                return (
                  <li key={item.key} className={`tl-item tl-${item.kind}`}>
                    {item.kind === "assistant" && <CrewAvatar id={chat ? "chatti" : "scoutr"} size={28} />}
                    <div className={`bubble bubble-${item.kind}`}>
                      <LongText text={item.text ?? ""} />
                    </div>
                  </li>
                );
              }
              return item.event ? (
                <li key={item.key} className="tl-item">
                  <EventCard e={item.event} tasks={taskMap} summaries={summaries} onRestore={onRestore} onShowScreenshot={setLightbox} />
                </li>
              ) : null;
            })}
          </ol>
        )}
      </div>
      {canWrite && (
        <div className="chat-compose">
          {(files.length > 0 || figmaOpen) && (
            <div className="chat-attachments">
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} className="chip">
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
            tools={
              <>
                <ComposerIcon icon="paperclip" label={t("project.chat.attach")} onClick={() => fileInput.current?.click()} />
                <ComposerIcon icon="figma" label={t("composer.figmaLink")} onClick={() => setFigmaOpen((o) => !o)} pressed={figmaOpen} />
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
