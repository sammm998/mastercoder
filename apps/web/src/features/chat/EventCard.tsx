"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatUsd } from "@/i18n/format";
import type { MessageKey, Translate } from "@/i18n/translate";
import { useTRPC, type RouterOutputs } from "@/lib/trpc";
import type { EventOf, ForgeEvent } from "@/lib/events";
import { summarizeGates, toolArg, type GateItem } from "@/lib/agent-run";
import { ErrorNotice } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { CrewAvatar } from "@/components/CrewAvatar";

type Task = RouterOutputs["task"]["list"][number];

const PHASE_KEYS = ["plan", "design", "build", "verify", "review", "finish", "media", "slides", "agent", "meeting"];
const INTENTS = ["app", "website", "mobile", "backend", "image", "video", "slides", "document", "agent", "integration", "question"];
const GATES = ["typecheck", "lint", "unit", "integration", "e2e", "semgrep", "gitleaks", "osv", "rls", "auth", "validation", "client-secrets", "lighthouse", "visual-qa"];
const TOOLS = ["read_file", "write_file", "edit_file", "list_files", "search_code", "run_command", "install_package", "run_tests", "run_e2e", "take_screenshot", "record_video", "read_logs", "db_query", "db_migrate", "web_search_docs", "generate_image", "generate_video", "create_slides", "use_integration", "ask_user"];
const STATUSES = ["queued", "running", "building", "deploying", "ready", "live", "succeeded", "failed", "error", "cancelled", "joining", "recording", "processing", "done", "active", "pending", "issued", "verified"];

export function phaseName(t: Translate, p: string) {
  return PHASE_KEYS.includes(p) ? t(`project.chat.phase.${p}` as MessageKey) : p;
}
export function gateName(t: Translate, g: string) {
  return GATES.includes(g) ? t(`project.gates.name.${g}` as MessageKey) : g;
}
export function toolName(t: Translate, tool: string) {
  return TOOLS.includes(tool) ? t(`project.tools.${tool}` as MessageKey) : t("project.tools.other", { tool });
}
/** A server status word, translated when we know it (unknown values stay as-is, in mono). */
export function statusName(t: Translate, s: string) {
  return STATUSES.includes(s) ? t(`status.${s}` as MessageKey) : s;
}

/** Raw server text (English, technical) lives only inside this expandable block. */
export function Details({ children, label }: { children: ReactNode; label?: string }) {
  const t = useT();
  return (
    <details className="ev-details">
      <summary>
        <Icon name="chevron" size={12} />
        {label ?? t("project.chat.detailsTitle")}
      </summary>
      <div className="ev-details-body">{children}</div>
    </details>
  );
}

function Json({ value }: { value: unknown }) {
  let s: string;
  try {
    s = JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return <pre className="code ev-code">{s.length > 4000 ? `${s.slice(0, 4000)}…` : s}</pre>;
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
    <div className="ev-card ev-accent">
      <div className="ev-head">
        <CrewAvatar id="scoutr" size={26} />
        <p className="ev-title">{t("project.chat.clarifyTitle")}</p>
      </div>
      <p className="ev-question">{e.question}</p>
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
            className="ev-inline-form"
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
    <div className="ev-card ev-accent" data-testid="plan-card">
      <div className="ev-head">
        <CrewAvatar id="plania" size={26} />
        <p className="ev-title">{t("project.chat.planTitle")}</p>
      </div>
      {typeof spec?.title === "string" && <h4 className="ev-plan-title">{spec.title}</h4>}
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
      <details className="ev-details" onToggle={(ev) => setEditing((ev.target as HTMLDetailsElement).open)}>
        <summary>
          <Icon name="chevron" size={12} />
          {t("project.chat.planEdit")}
        </summary>
        <div className="ev-details-body">
          <label htmlFor={`spec-${e.id}`} className="sr-only">
            {t("project.chat.planEdit")}
          </label>
          <textarea id={`spec-${e.id}`} className="textarea mono" rows={10} value={text} onChange={(ev) => setText(ev.target.value)} readOnly={!waiting} aria-invalid={invalid} />
          {invalid && <p className="hint" style={{ color: "var(--danger)" }}>{t("project.chat.planInvalid")}</p>}
        </div>
      </details>
      {waiting && (
        <button type="button" className="btn btn-primary btn-sm" style={{ justifySelf: "start" }} disabled={invalid || approve.isPending} onClick={() => e.taskId && approve.mutate({ taskId: e.taskId, spec: editing ? parsed : undefined })} data-testid="approve-plan">
          {t("project.chat.planApprove")}
        </button>
      )}
      {approve.isSuccess && <p className="badge badge-ok">{t("project.chat.planApproved")}</p>}
      <ErrorNotice error={approve.error} compact />
    </div>
  );
}

/* ---------- Tool calls: one compact group ---------- */
function ToolRow({ e, result }: { e: EventOf<"tool.call">; result?: EventOf<"tool.result"> }) {
  const t = useT();
  const arg = toolArg(e.input);
  const state = result ? (result.ok ? "ok" : "bad") : "pending";
  return (
    <li className="tool-row" data-state={state}>
      <span className="tool-dot" aria-hidden="true">
        {state === "ok" ? <Icon name="check" size={11} strokeWidth={2.6} /> : state === "bad" ? <Icon name="x" size={11} strokeWidth={2.6} /> : <span className="spinner" />}
      </span>
      <div className="tool-main">
        <p className="tool-line">
          <span>{toolName(t, e.tool)}</span>
          {arg && <code className="tool-arg">{arg}</code>}
          {state === "bad" && <span className="badge badge-bad">{t("project.tools.failed")}</span>}
        </p>
        <Details>
          {result && <p className="ev-raw">{result.summary}</p>}
          <p className="label">{t("project.chat.toolInput")}</p>
          <Json value={e.input} />
        </Details>
      </div>
    </li>
  );
}

export function ToolGroup({ calls, results }: { calls: Array<EventOf<"tool.call">>; results: Map<string, EventOf<"tool.result">> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const running = calls.some((c) => !results.has(c.callId));
  const failed = calls.filter((c) => results.get(c.callId)?.ok === false).length;
  const visible = open ? calls : calls.slice(-3);
  return (
    <div className="ev-card ev-tools">
      <div className="ev-head">
        <CrewAvatar id="byggo" size={26} />
        <p className="ev-title">{t("project.tools.title", { count: calls.length })}</p>
        {running && (
          <span className="ev-meta">
            <span className="spinner" aria-hidden="true" /> {t("project.tools.running")}
          </span>
        )}
        {failed > 0 && <span className="badge badge-bad">{t("project.gates.failedCount", { count: failed })}</span>}
      </div>
      <ul className="tool-list">
        {visible.map((c) => (
          <ToolRow key={c.id} e={c} result={results.get(c.callId)} />
        ))}
      </ul>
      {calls.length > 3 && (
        <button type="button" className="ev-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t("common.showLess") : t("common.showMore")}
        </button>
      )}
    </div>
  );
}

/* ---------- Quality gates: one card ---------- */
function GateChip({ g, selected, onSelect }: { g: GateItem; selected: boolean; onSelect: () => void }) {
  const t = useT();
  return (
    <button type="button" className="gate-chip" data-status={g.status} aria-pressed={selected} onClick={onSelect}>
      <Icon name={g.status === "passed" ? "check" : g.status === "failed" ? "x" : "skip"} size={11} strokeWidth={2.6} />
      <span>{gateName(t, g.gate)}</span>
      <span className="sr-only">— {t(`project.gates.status.${g.status}`)}</span>
    </button>
  );
}

export function GatesCard({ results }: { results: Array<EventOf<"gate.result">> }) {
  const t = useT();
  const sum = summarizeGates(results);
  const [open, setOpen] = useState(sum.failed > 0);
  const [selected, setSelected] = useState<string | null>(null);
  const failures = sum.items.filter((i) => i.status === "failed");
  const sel = sum.items.find((i) => i.gate === selected) ?? null;
  const parts = [t("project.gates.passedCount", { count: sum.passed })];
  if (sum.failed) parts.push(t("project.gates.failedCount", { count: sum.failed }));
  if (sum.skipped) parts.push(t("project.gates.skippedCount", { count: sum.skipped }));
  return (
    <div className={`ev-card ev-gates ${sum.failed ? "has-failed" : ""}`} data-testid="gates-card">
      <button type="button" className="ev-head ev-head-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={t("project.gates.toggle")}>
        <CrewAvatar id="vakt" size={26} />
        <span className="ev-title">{t("project.gates.title")}</span>
        <span className="ev-summary" data-testid="gates-summary">
          {parts.join(" · ")}
        </span>
        <Icon name="chevron" size={14} />
      </button>
      <div className="gate-meter" aria-hidden="true">
        <span style={{ flex: sum.passed, background: "var(--patina)" }} />
        <span style={{ flex: sum.failed, background: "var(--danger)" }} />
        <span style={{ flex: sum.skipped, background: "var(--skip)" }} />
      </div>
      {failures.map((f) => (
        <div key={f.id} className="gate-failure">
          <p className="gate-failure-title">
            <Icon name="alert" size={14} />
            {gateName(t, f.gate)}
            {f.findings !== null && <span className="badge badge-bad">{t("project.gates.findings", { count: f.findings })}</span>}
          </p>
          {f.fix && (
            <div className="gate-fix">
              <p className="label">{t("project.gates.fix")}</p>
              <p>{f.fix}</p>
            </div>
          )}
          <Details>
            <pre className="code ev-code">{f.details}</pre>
          </Details>
        </div>
      ))}
      {open && (
        <>
          <div className="gate-chips">
            {sum.items.map((g) => (
              <GateChip key={g.id} g={g} selected={selected === g.gate} onSelect={() => setSelected((s) => (s === g.gate ? null : g.gate))} />
            ))}
          </div>
          {sel && (
            <div className="gate-sel">
              <p className="gate-sel-head">
                <strong>{gateName(t, sel.gate)}</strong> · {t(`project.gates.status.${sel.status}`)}
                {sel.status === "skipped" && <span className="subtle"> — {t("project.gates.notApplicable")}</span>}
              </p>
              <Details>
                <pre className="code ev-code">{sel.details}</pre>
              </Details>
            </div>
          )}
        </>
      )}
    </div>
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

function Row({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="ev-row">
      {icon}
      {children}
    </div>
  );
}

export function EventCard({ e, tasks, summaries, onRestore, onShowScreenshot }: { e: ForgeEvent; tasks: Map<string, Task>; summaries?: Map<string, TaskSummary>; onRestore: (checkpointId: string, label: string) => void; onShowScreenshot?: (url: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const task = e.taskId ? tasks.get(e.taskId) : undefined;
  switch (e.type) {
    case "intent.classified":
      return (
        <Row icon={<Icon name="sparkle" size={14} />}>
          <span className="ev-label">{t("project.chat.intents")}</span>
          <span className="chips">
            {e.intents.map((i, n) => (
              <span key={n} className="badge badge-accent">
                {INTENTS.includes(i.kind) ? t(`project.chat.intent.${i.kind}` as MessageKey) : i.kind} · {t("project.chat.confidence", { value: Math.round(i.confidence * 100) })}
              </span>
            ))}
          </span>
        </Row>
      );
    case "cost.estimate":
      return (
        <div className="ev-card" data-testid="cost-estimate">
          <div className="ev-head">
            <Icon name="card" size={16} />
            <p className="ev-title">{t("project.chat.estimateTitle")}</p>
            <span className="ev-price">
              {formatUsd(e.lowUsd, locale)} – {formatUsd(e.highUsd, locale)}
            </span>
          </div>
          <p className="hint">{t("project.chat.estimateBefore")}</p>
          {e.breakdown.length > 0 && (
            <Details label={t("project.chat.breakdown")}>
              <dl className="kv ev-kv">
                {e.breakdown.map((b, i) => (
                  <div key={i} style={{ display: "contents" }}>
                    <dt>{b.label}</dt>
                    <dd className="mono">{formatUsd(b.usd, locale)}</dd>
                  </div>
                ))}
              </dl>
            </Details>
          )}
        </div>
      );
    case "clarify.question":
      return <ClarifyCard e={e} task={task} />;
    case "plan.ready":
      return <PlanCard e={e} task={task} />;
    case "phase.started":
      return <p className="ev-phase">{t("project.chat.phaseStarted", { phase: phaseName(t, e.phase) })}</p>;
    case "phase.completed":
      return <p className="ev-phase ev-phase-done">{t("project.chat.phaseCompleted", { phase: phaseName(t, e.phase), seconds: Math.round(e.durationMs / 100) / 10 })}</p>;
    case "design.directions":
      return (
        <div className="ev-card">
          <div className="ev-head">
            <CrewAvatar id="pixel" size={26} />
            <p className="ev-title">{t("project.chat.directionsTitle")}</p>
          </div>
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
    case "design.score":
      return (
        <div className="ev-card ev-compact">
          <div className="ev-head">
            <CrewAvatar id="pixel" size={26} />
            <p className="ev-title">{t("project.chat.designScore")}</p>
            <span className={`badge ${e.score >= 8 ? "badge-ok" : "badge-warn"}`}>
              {e.score.toFixed(1)}/10{e.viewport ? ` · ${t("project.chat.viewport", { w: e.viewport })}` : ""}
            </span>
          </div>
          {e.notes && (
            <Details>
              <p className="ev-raw">{e.notes}</p>
            </Details>
          )}
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
        <Row icon={<Icon name="history" size={14} />}>
          <span className="ev-label">{t("project.chat.checkpoint")}</span>
          <span className="grow mono ev-wrap">{e.label}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onRestore(e.checkpointId, e.label)}>
            {t("project.chat.restore")}
          </button>
        </Row>
      );
    case "artifact.ready":
      return (
        <Row icon={<Icon name="sparkle" size={14} />}>
          <span className="badge badge-ok">{t("project.chat.artifact")}</span>
          <a href={e.url} target="_blank" rel="noreferrer noopener">
            {t("common.open")}
          </a>
        </Row>
      );
    case "approval.required":
      return (
        <div className="ev-card ev-accent">
          <div className="ev-head">
            <CrewAvatar id="mailo" size={26} />
            <p className="ev-title">{t("project.chat.approvalOpen")}</p>
          </div>
          <Details>
            <p className="ev-raw">{e.action}</p>
          </Details>
          <Link className="btn btn-sm" style={{ justifySelf: "start" }} href="/app/agents?tab=approvals">
            {t("project.chat.approvalOpen")}
          </Link>
        </div>
      );
    case "task.completed": {
      const sum = e.taskId ? summaries?.get(e.taskId) : undefined;
      return (
        <div className="ev-card ev-done" data-testid="task-completed">
          <div className="ev-head">
            <CrewAvatar id="scoutr" size={26} />
            <p className="ev-title">{t("project.chat.completedTitle")}</p>
            <span className="badge badge-ok">{t("project.chat.charged", { amount: formatUsd(e.chargedUsd, locale) })}</span>
          </div>
          {sum && (
            <div className="row" style={{ gap: 6 }}>
              {sum.gates.total > 0 && <span className="badge">{t("project.chat.gatesSummary", { passed: sum.gates.passed, total: sum.gates.total })}</span>}
              {sum.score !== null && (
                <span className="badge">
                  {t("project.chat.designScore")} {sum.score.toFixed(1)}/10
                </span>
              )}
            </div>
          )}
          {sum && sum.shots.length > 0 && (
            <div className="chat-shots" aria-label={t("project.chat.screenshots")}>
              {sum.shots.slice(-3).map((s) => (
                <button key={s.url} type="button" className="chat-shot" onClick={() => onShowScreenshot?.(s.url)}>
                  <img src={s.url} alt={t("project.chat.viewport", { w: s.viewport })} loading="lazy" width={160} height={100} />
                  <span className="mono subtle">{s.viewport}px</span>
                </button>
              ))}
            </div>
          )}
          {e.summary && (
            <Details label={t("project.chat.summary")}>
              <p className="ev-raw">{e.summary}</p>
            </Details>
          )}
        </div>
      );
    }
    case "task.failed":
      return (
        <div className="ev-card ev-failed">
          <div className="ev-head">
            <CrewAvatar id="scoutr" size={26} />
            <p className="ev-title">{t("project.chat.failedTitle")}</p>
            {!e.charged && <span className="badge badge-ok">{t("project.chat.notCharged")}</span>}
          </div>
          {e.blockedOn && <p className="hint">{t("project.chat.blockedOn", { gate: gateName(t, e.blockedOn) })}</p>}
          <Details label={t("project.chat.reason")}>
            <p className="ev-raw">{e.reason}</p>
          </Details>
        </div>
      );
    case "deploy.status":
      return (
        <Row icon={<Icon name="rocket" size={14} />}>
          <span>{t("project.chat.deploy", { status: statusName(t, e.status) })}</span>
          {e.url && (
            <a href={e.url} target="_blank" rel="noreferrer noopener" className="mono ev-wrap">
              {e.url}
            </a>
          )}
        </Row>
      );
    case "meeting.status":
      return (
        <Row icon={<Icon name="meeting" size={14} />}>
          <span>{t("project.chat.meeting", { status: statusName(t, e.status) })}</span>
        </Row>
      );
    case "preview.ready":
      return (
        <Row icon={<span className="dot status-open" />}>
          <span>{t("project.chat.previewReady")}</span>
          <a href={e.url} target="_blank" rel="noreferrer noopener" className="ev-link">
            {t("common.open")} <Icon name="external" size={12} />
          </a>
        </Row>
      );
    default:
      return null;
  }
}
