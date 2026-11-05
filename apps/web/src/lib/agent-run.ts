import { z } from "zod";
import type { EventOf, ForgeEvent } from "./events";
import { CREW } from "./crew";

/**
 * Structured views over a project's event stream for the workspace UI: phase progress, quality-gate
 * roll-ups, cost, live files and the agent-team conversation. Everything here is pure (unit-tested);
 * components translate the structured fields, and raw server text is only shown inside "Details".
 */

export const PHASES = ["plan", "design", "build", "verify", "review", "finish"] as const;
export type Phase = (typeof PHASES)[number];
export type StepState = "done" | "active" | "todo" | "failed";

/* ---------- team.message (newer event; validated locally so older shared types still compile) ---------- */
const CrewEnum = z.enum(CREW);
export const TeamMessageSchema = z.object({
  type: z.literal("team.message"),
  id: z.string(),
  projectId: z.string(),
  taskId: z.string().optional(),
  at: z.string(),
  from: CrewEnum,
  to: z.union([CrewEnum, z.literal("user")]).optional(),
  status: z.enum(["asking", "working", "done", "failed"]),
  step: z.string(),
  key: z.string(),
  params: z.record(z.union([z.string(), z.number()])).default({}),
  text: z.string(),
});
export type TeamMessage = z.infer<typeof TeamMessageSchema>;

export function asTeamMessage(e: unknown): TeamMessage | null {
  if (!e || typeof e !== "object" || (e as { type?: unknown }).type !== "team.message") return null;
  const r = TeamMessageSchema.safeParse(e);
  return r.success ? r.data : null;
}

/** The task the workspace should focus on: the one with the most recent event. */
export function currentTaskId(events: ForgeEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.taskId && e.type !== "presence") return e.taskId;
  }
  return undefined;
}

export function eventsOf(events: ForgeEvent[], taskId: string | undefined): ForgeEvent[] {
  return taskId ? events.filter((e) => e.taskId === taskId) : [];
}

export function isFinished(taskEvents: ForgeEvent[]): "succeeded" | "failed" | null {
  for (let i = taskEvents.length - 1; i >= 0; i--) {
    const t = taskEvents[i]!.type;
    if (t === "task.completed") return "succeeded";
    if (t === "task.failed") return "failed";
  }
  return null;
}

/** plan → design → build → verify → review → finish, from phase.started/phase.completed (and task end). */
export function phaseSteps(taskEvents: ForgeEvent[]): Array<{ phase: Phase; state: StepState }> {
  const started = new Set<string>();
  const completed = new Set<string>();
  for (const e of taskEvents) {
    if (e.type === "phase.started") started.add(e.phase);
    else if (e.type === "phase.completed") completed.add(e.phase);
  }
  const end = isFinished(taskEvents);
  // The last started-but-not-completed phase is active (or failed if the task failed).
  return PHASES.map((phase) => {
    if (completed.has(phase) || (end === "succeeded" && started.has(phase))) return { phase, state: "done" as const };
    if (started.has(phase)) return { phase, state: end === "failed" ? ("failed" as const) : end ? ("done" as const) : ("active" as const) };
    if (end === "succeeded" && phase === "finish") return { phase, state: "done" as const };
    return { phase, state: "todo" as const };
  });
}

/* ---------- Quality gates ---------- */
export type GateStatus = "passed" | "failed" | "skipped";
export interface GateItem {
  id: string;
  gate: string;
  status: GateStatus;
  /** Server text with duplicated "skipped:" prefixes stripped. Shown only inside Details. */
  details: string;
  fix?: string;
  findings: number | null;
}

/** "skipped: skipped: no lockfile" → "no lockfile". */
export function stripSkipped(details: string): string {
  return details.replace(/^(\s*skipped:\s*)+/i, "").trim();
}

export function gateItem(e: EventOf<"gate.result">): GateItem {
  const skipped = /^\s*skipped:/i.test(e.details);
  const m = e.details.match(/(\d+)\s+blocking finding/i);
  return {
    id: e.id,
    gate: e.gate,
    status: skipped ? "skipped" : e.passed ? "passed" : "failed",
    details: skipped ? stripSkipped(e.details) : e.details.trim(),
    fix: e.fix,
    findings: m ? Number(m[1]) : null,
  };
}

export interface GateSummary {
  items: GateItem[];
  passed: number;
  failed: number;
  skipped: number;
}

/** Latest result per gate (a re-run after a fix replaces the earlier one), in first-seen order. */
export function summarizeGates(results: Array<EventOf<"gate.result">>): GateSummary {
  const byGate = new Map<string, GateItem>();
  for (const r of results) byGate.set(r.gate, gateItem(r));
  const items = [...byGate.values()];
  return {
    items,
    passed: items.filter((i) => i.status === "passed").length,
    failed: items.filter((i) => i.status === "failed").length,
    skipped: items.filter((i) => i.status === "skipped").length,
  };
}

/* ---------- Cost ---------- */
export interface TaskCost {
  lowUsd: number | null;
  highUsd: number | null;
  spentUsd: number;
  tokens: number;
  /** Tokens were used but nothing was charged: the built-in mock providers ran. */
  mock: boolean;
}

export function taskCost(taskEvents: ForgeEvent[]): TaskCost {
  let lowUsd: number | null = null;
  let highUsd: number | null = null;
  let spentUsd = 0;
  let tokens = 0;
  for (const e of taskEvents) {
    if (e.type === "cost.estimate") {
      lowUsd = e.lowUsd;
      highUsd = e.highUsd;
    } else if (e.type === "usage") {
      spentUsd += e.costUsd;
      tokens += e.tokensIn + e.tokensOut;
    }
  }
  return { lowUsd, highUsd, spentUsd, tokens, mock: tokens > 0 && spentUsd === 0 };
}

/* ---------- Live files ---------- */
export interface LiveFile {
  path: string;
  change: "created" | "modified" | "deleted";
  at: string;
}

/** Files touched by a task, newest first, one row per path (latest change wins; created stays "created"). */
export function liveFiles(taskEvents: ForgeEvent[]): LiveFile[] {
  const m = new Map<string, LiveFile>();
  for (const e of taskEvents) {
    if (e.type !== "file.changed") continue;
    const prev = m.get(e.path);
    const change = prev?.change === "created" && e.change === "modified" ? "created" : e.change;
    m.delete(e.path);
    m.set(e.path, { path: e.path, change, at: e.at });
  }
  return [...m.values()].reverse();
}

/** The last `lines` lines of terminal output for a task (ANSI stripped by the caller). */
export function terminalTail(taskEvents: ForgeEvent[], lines = 40): Array<{ id: string; stream: "stdout" | "stderr"; text: string }> {
  const out: Array<{ id: string; stream: "stdout" | "stderr"; text: string }> = [];
  for (const e of taskEvents) if (e.type === "terminal.output") out.push({ id: e.id, stream: e.stream, text: e.text });
  let count = 0;
  const kept: typeof out = [];
  for (let i = out.length - 1; i >= 0 && count < lines; i--) {
    const parts = out[i]!.text.split("\n");
    const take = parts.slice(Math.max(0, parts.length - (lines - count)));
    count += take.length;
    kept.unshift({ ...out[i]!, text: take.join("\n") });
  }
  return kept;
}

/* ---------- Team conversation ---------- */
export interface TeamRun {
  taskId: string;
  messages: TeamMessage[];
  /** Ordered distinct steps with their latest status. */
  steps: Array<{ step: string; status: TeamMessage["status"]; from: TeamMessage["from"] }>;
  state: "working" | "done" | "failed";
  chat: boolean;
}

export function teamRuns(events: ForgeEvent[]): Map<string, TeamRun> {
  const runs = new Map<string, TeamRun>();
  for (const raw of events) {
    const e = asTeamMessage(raw);
    if (!e?.taskId) continue;
    let r = runs.get(e.taskId);
    if (!r) runs.set(e.taskId, (r = { taskId: e.taskId, messages: [], steps: [], state: "working", chat: false }));
    r.messages.push(e);
    if (e.from === "chatti" || e.step === "chat") r.chat = true;
    const s = r.steps.find((x) => x.step === e.step);
    if (s) {
      s.status = e.status;
      s.from = e.from;
    } else r.steps.push({ step: e.step, status: e.status, from: e.from });
  }
  for (const r of runs.values()) {
    const last = r.messages[r.messages.length - 1]!;
    const ended = isFinished(events.filter((e) => e.taskId === r.taskId));
    if (last.key === "team.failed" || ended === "failed") r.state = "failed";
    else if (last.key === "team.finish" || last.step === "chat" || ended === "succeeded") r.state = "done";
  }
  return runs;
}

/* ---------- Timeline grouping ---------- */
export type Grouped<T> = { kind: "single"; item: T } | { kind: "gates"; key: string; taskId?: string; items: T[] } | { kind: "tools"; key: string; items: T[] };

/** Collapse consecutive gate results (same task) into one card, and consecutive tool calls into one group. */
export function groupTimeline<T extends { key: string; event?: ForgeEvent; taskId?: string }>(items: T[]): Array<Grouped<T>> {
  const out: Array<Grouped<T>> = [];
  for (const it of items) {
    const type = it.event?.type;
    const last = out[out.length - 1];
    if (type === "gate.result") {
      if (last?.kind === "gates" && last.taskId === it.taskId) last.items.push(it);
      else out.push({ kind: "gates", key: `g-${it.key}`, taskId: it.taskId, items: [it] });
      continue;
    }
    if (type === "tool.call") {
      if (last?.kind === "tools") last.items.push(it);
      else out.push({ kind: "tools", key: `t-${it.key}`, items: [it] });
      continue;
    }
    out.push({ kind: "single", item: it });
  }
  return out;
}

/** A short, safe argument to show next to a tool name (a path or a command), never the whole input. */
export function toolArg(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const k of ["path", "file", "command", "cmd", "query", "name", "packages", "package"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.length > 120 ? `${v.slice(0, 117)}…` : v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return (v as string[]).join(" ").slice(0, 120);
  }
  return null;
}
