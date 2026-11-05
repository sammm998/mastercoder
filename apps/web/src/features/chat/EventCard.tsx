"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatUsd } from "@/i18n/format";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC, type RouterOutputs } from "@/lib/trpc";
import type { EventOf, ForgeEvent } from "@/lib/events";
import { ErrorNotice } from "@/components/Feedback";

type Task = RouterOutputs["task"]["list"][number];

function phaseName(t: ReturnType<typeof useT>, p: string) {
  const known = ["plan", "design", "build", "verify", "review", "finish", "media", "slides", "agent", "meeting"];
  return known.includes(p) ? t(`project.chat.phase.${p}` as MessageKey) : p;
}

function Json({ value }: { value: unknown }) {
  let s: string;
  try {
    s = JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return <pre className="code chat-json">{s.length > 4000 ? `${s.slice(0, 4000)}…` : s}</pre>;
}

/** Extract a readable task list from a spec of unknown shape (tasks/steps/features arrays). */
export function specTasks(spec: unknown): string[] {
  if (!spec || typeof spec !== "object") return [];
  const o = spec as Record<string, unknown>;
  for (const key of ["tasks", "steps", "features", "requirements", "pages"]) {
    const v = o[key];
    if (Array.isArray(v))
      return v
        .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String((x as Record<string, unknown>).title ?? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).summary ?? JSON.stringify(x)) : String(x)))
        .slice(0, 50);
  }
  return [];
}

function ClarifyCard({ e, task }: { e: EventOf<"clarify.question">; task?: Task }) {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [answer, setAnswer] = useState("");
  const m = useMutation(trpc.task.answerClarification.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.task.list.queryKey() }) }));
  const open = task?.status === "awaiting_clarification" && !m.isSuccess;
  const send = (a: string) => e.taskId && a.trim() && m.mutate({ taskId: e.taskId, answer: a.trim() });
  return (
    <div className="chat-card chat-card-accent">
      <p className="eyebrow">{t("project.chat.clarifyTitle")}</p>
      <p className="serif" style={{ fontSize: "1.15rem" }}>
        {e.question}
      </p>
      {open && (
        <>
          {e.options?.length ? (
            <div className="chips">
              {e.options.map((o) => (
                <button key={o} type="button" className="chip" onClick={() => send(o)} disabled={m.isPending}>
                  {o}
                </button>
              ))}
            </div>
          ) : null}
          <form
            className="row"
            style={{ flexWrap: "nowrap" }}
            onSubmit={(ev) => {
              ev.preventDefault();
              send(answer);
            }}
          >
            <label htmlFor={`clarify-${e.id}`} className="sr-only">
              {t("project.chat.clarifyAnswer")}
            </label>
            <input id={`clarify-${e.id}`} className="input" value={answer} onChange={(ev) => setAnswer(ev.target.value)} placeholder={t("project.chat.clarifyAnswer")} maxLength={2000} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={!answer.trim() || m.isPending}>
              {t("project.chat.clarifySend")}
            </button>
          </form>
        </>
      )}
      <ErrorNotice error={m.error} compact />
    </div>
  );
}

function PlanCard({ e, task }: { e: EventOf<"plan.ready">; task?: Task }) {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [text, setText] = useState(() => JSON.stringify(e.spec, null, 2));
  const [editing, setEditing] = useState(false);
  const approve = useMutation(trpc.task.approvePlan.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.task.list.queryKey() }) }));
  let parsed: unknown = e.spec;
  let invalid = false;
  if (editing) {
    try {
      parsed = JSON.parse(text);
    } catch {
      invalid = true;
    }
  }
  const tasks = specTasks(parsed);
  const waiting = e.requiresApproval && task?.status === "awaiting_approval" && !approve.isSuccess;
  const spec = parsed as { title?: unknown; summary?: unknown } | null;
  return (
    <div className="chat-card chat-card-accent" data-testid="plan-card">
      <p className="eyebrow">{t("project.chat.planTitle")}</p>
      {typeof spec?.title === "string" && <h4 className="serif">{spec.title}</h4>}
      {typeof spec?.summary === "string" && <p className="muted">{spec.summary}</p>}
      {tasks.length > 0 && (
        <>
          <p className="label">{t("project.chat.planTasks")}</p>
          <ol className="plan-tasks">
            {tasks.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        </>
      )}
      <details onToggle={(ev) => setEditing((ev.target as HTMLDetailsElement).open)}>
        <summary>{t("project.chat.planEdit")}</summary>
        <label htmlFor={`spec-${e.id}`} className="sr-only">
          {t("project.chat.planEdit")}
        </label>
        <textarea id={`spec-${e.id}`} className="textarea mono" rows={10} value={text} onChange={(ev) => setText(ev.target.value)} readOnly={!waiting} aria-invalid={invalid} />
        {invalid && <p className="hint" style={{ color: "var(--danger)" }}>{t("project.chat.planInvalid")}</p>}
      </details>
      {waiting && (
        <button type="button" className="btn btn-primary btn-sm" disabled={invalid || approve.isPending} onClick={() => e.taskId && approve.mutate({ taskId: e.taskId, spec: editing ? parsed : undefined })} data-testid="approve-plan">
          {t("project.chat.planApprove")}
        </button>
      )}
      {approve.isSuccess && <p className="badge badge-ok">{t("project.chat.planApproved")}</p>}
      <ErrorNotice error={approve.error} compact />
    </div>
  );
}

function ToolCard({ e, result }: { e: EventOf<"tool.call">; result?: EventOf<"tool.result"> }) {
  const t = useT();
  return (
    <details className="chat-tool">
      <summary>
        <span className={`dot ${result ? (result.ok ? "ok" : "bad") : "pending"}`} aria-hidden="true" />
        <span className="mono">{e.tool}</span>
        <span className="subtle chat-tool-summary">{result ? result.summary : t("project.chat.toolRunning")}</span>
      </summary>
      <p className="label">{t("project.chat.toolInput")}</p>
      <Json value={e.input} />
    </details>
  );
}

export interface TaskSummary {
  shots: Array<{ url: string; viewport: number }>;
  gates: { passed: number; total: number };
  score: number | null;
}

/** Per-task roll-up (screenshots, gate pass rate, best design score) for the final summary card. */
export function summarizeTasks(events: ForgeEvent[]): Map<string, TaskSummary> {
  const m = new Map<string, TaskSummary>();
  const get = (id: string) => {
    let s = m.get(id);
    if (!s) m.set(id, (s = { shots: [], gates: { passed: 0, total: 0 }, score: null }));
    return s;
  };
  for (const e of events) {
    if (!e.taskId) continue;
    if (e.type === "screenshot") get(e.taskId).shots.push({ url: e.url, viewport: e.viewport });
    else if (e.type === "gate.result") {
      const g = get(e.taskId).gates;
      g.total++;
      if (e.passed) g.passed++;
    } else if (e.type === "design.score") {
      const s = get(e.taskId);
      s.score = s.score === null ? e.score : Math.max(s.score, e.score);
    }
  }
  return m;
}

export function EventCard({ e, tasks, results, summaries, onRestore, onShowScreenshot }: { e: ForgeEvent; tasks: Map<string, Task>; results: Map<string, EventOf<"tool.result">>; summaries?: Map<string, TaskSummary>; onRestore: (checkpointId: string, label: string) => void; onShowScreenshot?: (url: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const task = e.taskId ? tasks.get(e.taskId) : undefined;
  switch (e.type) {
    case "intent.classified":
      return (
        <div className="chat-row">
          <span className="eyebrow">{t("project.chat.intents")}</span>
          <div className="chips">
            {e.intents.map((i, n) => (
              <span key={n} className="badge" title={i.summary}>
                {i.kind} · {t("project.chat.confidence", { value: Math.round(i.confidence * 100) })}
              </span>
            ))}
          </div>
        </div>
      );
    case "cost.estimate":
      return (
        <div className="chat-card" data-testid="cost-estimate">
          <div className="row-between">
            <span className="eyebrow">{t("project.chat.estimateTitle")}</span>
            <span className="serif chat-price">
              {formatUsd(e.lowUsd, locale)} – {formatUsd(e.highUsd, locale)}
            </span>
          </div>
          {e.breakdown.length > 0 && (
            <dl className="kv" style={{ fontSize: "0.82rem" }}>
              {e.breakdown.map((b, i) => (
                <div key={i} style={{ display: "contents" }}>
                  <dt>{b.label}</dt>
                  <dd className="mono">{formatUsd(b.usd, locale)}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="hint">{t("project.chat.estimateBefore")}</p>
        </div>
      );
    case "clarify.question":
      return <ClarifyCard e={e} task={task} />;
    case "plan.ready":
      return <PlanCard e={e} task={task} />;
    case "phase.started":
      return <p className="chat-phase">{t("project.chat.phaseStarted", { phase: phaseName(t, e.phase) })}</p>;
    case "phase.completed":
      return <p className="chat-phase chat-phase-done">{t("project.chat.phaseCompleted", { phase: phaseName(t, e.phase), seconds: Math.round(e.durationMs / 100) / 10 })}</p>;
    case "design.directions":
      return (
        <div className="chat-card">
          <p className="eyebrow">{t("project.chat.directionsTitle")}</p>
          <div className="directions">
            {e.directions.map((d, i) => {
              const dir = d as { name?: string; mood?: string; palette?: Record<string, string> };
              return (
                <div key={i} className="direction">
                  <div className="direction-swatches" aria-hidden="true">
                    {Object.values(dir.palette ?? {})
                      .filter((c) => typeof c === "string" && /^#|^rgb|^hsl|^oklch/.test(c))
                      .slice(0, 6)
                      .map((c, k) => (
                        <span key={k} style={{ background: c }} />
                      ))}
                  </div>
                  <strong>{dir.name ?? `#${i + 1}`}</strong>
                  {dir.mood && <span className="subtle">{dir.mood}</span>}
                </div>
              );
            })}
          </div>
        </div>
      );
    case "tool.call":
      return <ToolCard e={e} result={results.get(e.callId)} />;
    case "gate.result":
      return (
        <div className={`chat-gate ${e.passed ? "ok" : "bad"}`}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`badge ${e.passed ? "badge-ok" : "badge-bad"}`}>
              {e.gate} · {e.passed ? t("project.chat.gatePassed") : t("project.chat.gateFailed")}
            </span>
            <span className="subtle chat-tool-summary">{e.details}</span>
          </div>
          {!e.passed && e.fix && (
            <p className="hint">
              <strong>{t("project.chat.gateFix")}:</strong> {e.fix}
            </p>
          )}
        </div>
      );
    case "design.score":
      return (
        <div className="chat-row">
          <span className="eyebrow">{t("project.chat.designScore")}</span>
          <span className={`badge ${e.score >= 8 ? "badge-ok" : "badge-warn"}`}>
            {e.score.toFixed(1)}/10{e.viewport ? ` · ${t("project.chat.viewport", { w: e.viewport })}` : ""}
          </span>
          <span className="subtle chat-tool-summary">{e.notes}</span>
        </div>
      );
    case "screenshot":
      return (
        <button type="button" className="chat-shot" onClick={() => onShowScreenshot?.(e.url)}>
          <img src={e.url} alt={t("project.chat.viewport", { w: e.viewport })} loading="lazy" width={240} height={150} />
          <span className="mono subtle">{e.viewport}px</span>
        </button>
      );
    case "checkpoint.created":
      return (
        <div className="chat-row">
          <span className="badge">{t("project.chat.checkpoint")}</span>
          <span className="grow">{e.label}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onRestore(e.checkpointId, e.label)}>
            {t("project.chat.restore")}
          </button>
        </div>
      );
    case "artifact.ready":
      return (
        <div className="chat-row">
          <span className="badge badge-ok">{t("project.chat.artifactReady", { kind: e.kind })}</span>
          <a href={e.url} target="_blank" rel="noreferrer noopener">
            {t("common.open")}
          </a>
        </div>
      );
    case "approval.required":
      return (
        <div className="chat-card chat-card-accent">
          <p>{t("project.chat.approvalRequired", { action: e.action })}</p>
          <Link className="btn btn-sm" href="/app/agents?tab=approvals">
            {t("project.chat.approvalOpen")}
          </Link>
        </div>
      );
    case "task.completed":
      return (
        <div className="chat-card chat-card-done" data-testid="task-completed">
          <div className="row-between">
            <p className="eyebrow">{t("project.chat.completedTitle")}</p>
            <span className="badge badge-ok">{t("project.chat.charged", { amount: formatUsd(e.chargedUsd, locale) })}</span>
          </div>
          <p>{e.summary}</p>
          {(() => {
            const sum = e.taskId ? summaries?.get(e.taskId) : undefined;
            if (!sum) return null;
            return (
              <>
                <div className="row" style={{ gap: 8 }}>
                  {sum.gates.total > 0 && <span className="badge">{t("project.chat.gatesSummary", { passed: sum.gates.passed, total: sum.gates.total })}</span>}
                  {sum.score !== null && (
                    <span className="badge">
                      {t("project.chat.designScore")} {sum.score.toFixed(1)}/10
                    </span>
                  )}
                </div>
                {sum.shots.length > 0 && (
                  <div className="chat-shots" aria-label={t("project.chat.screenshots")}>
                    {sum.shots.slice(-3).map((s) => (
                      <button key={s.url} type="button" className="chat-shot" onClick={() => onShowScreenshot?.(s.url)}>
                        <img src={s.url} alt={t("project.chat.viewport", { w: s.viewport })} loading="lazy" width={160} height={100} />
                        <span className="mono subtle">{s.viewport}px</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      );
    case "task.failed":
      return (
        <div className="chat-card chat-card-failed">
          <div className="row-between">
            <p className="eyebrow">{t("project.chat.failedTitle")}</p>
            {!e.charged && <span className="badge badge-ok">{t("project.chat.notCharged")}</span>}
          </div>
          <p>{e.reason}</p>
          {e.blockedOn && <p className="hint">{t("project.chat.blockedOn", { gate: e.blockedOn })}</p>}
        </div>
      );
    case "deploy.status":
      return (
        <p className="chat-phase">
          {t("project.chat.deployStatus", { status: e.status })}
          {e.url && (
            <>
              {" "}
              ·{" "}
              <a href={e.url} target="_blank" rel="noreferrer noopener">
                {e.url}
              </a>
            </>
          )}
        </p>
      );
    case "meeting.status":
      return <p className="chat-phase">{t("project.chat.meetingStatus", { status: e.status })}</p>;
    case "preview.ready":
      return (
        <p className="chat-phase chat-phase-done">
          {t("project.tabs.preview")} ·{" "}
          <a href={e.url} target="_blank" rel="noreferrer noopener" className="mono">
            {e.url}
          </a>
        </p>
      );
    default:
      return null;
  }
}
