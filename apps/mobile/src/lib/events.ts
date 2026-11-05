import { z } from "zod";
import type { ForgeEvent } from "@forge/shared";

/**
 * Parsing and reduction of the live project event stream (`/ws/events/:projectId`) and the persisted
 * history (`project.events`). Pure: no React Native imports, unit-tested in node.
 */

type Known<T extends ForgeEvent["type"]> = Extract<ForgeEvent, { type: T }>;

const base = { id: z.string(), projectId: z.string(), taskId: z.string().optional(), at: z.string() };
const IntentZ = z.object({ kind: z.string(), confidence: z.number(), summary: z.string(), hint: z.string().optional() });

/** The events the mobile app renders. Each schema is checked against @forge/shared's ForgeEvent type. */
const schemas = {
  "intent.classified": z.object({ ...base, type: z.literal("intent.classified"), intents: z.array(IntentZ) }),
  "cost.estimate": z.object({ ...base, type: z.literal("cost.estimate"), lowUsd: z.number(), highUsd: z.number(), breakdown: z.array(z.object({ label: z.string(), usd: z.number() })) }),
  "clarify.question": z.object({ ...base, type: z.literal("clarify.question"), question: z.string(), options: z.array(z.string()).optional() }),
  "phase.started": z.object({ ...base, type: z.literal("phase.started"), phase: z.string() }),
  "phase.completed": z.object({ ...base, type: z.literal("phase.completed"), phase: z.string(), durationMs: z.number() }),
  "plan.ready": z.object({ ...base, type: z.literal("plan.ready"), spec: z.unknown(), requiresApproval: z.boolean() }),
  "message.delta": z.object({ ...base, type: z.literal("message.delta"), text: z.string() }),
  message: z.object({ ...base, type: z.literal("message"), role: z.enum(["assistant", "system"]), text: z.string() }),
  "job.progress": z.object({ ...base, type: z.literal("job.progress"), jobId: z.string(), progress: z.number(), label: z.string().optional() }),
  "checkpoint.created": z.object({ ...base, type: z.literal("checkpoint.created"), checkpointId: z.string(), commit: z.string(), label: z.string() }),
  "artifact.ready": z.object({ ...base, type: z.literal("artifact.ready"), artifactId: z.string(), kind: z.string(), url: z.string() }),
  "approval.required": z.object({ ...base, type: z.literal("approval.required"), approvalId: z.string(), action: z.string(), details: z.unknown() }),
  "gate.result": z.object({ ...base, type: z.literal("gate.result"), gate: z.string(), passed: z.boolean(), details: z.string(), fix: z.string().optional() }),
  "task.completed": z.object({ ...base, type: z.literal("task.completed"), summary: z.string(), chargedUsd: z.number() }),
  "task.failed": z.object({ ...base, type: z.literal("task.failed"), reason: z.string(), charged: z.boolean(), blockedOn: z.string().optional() }),
  "preview.ready": z.object({ ...base, type: z.literal("preview.ready"), url: z.string(), port: z.number().optional() }),
  "deploy.status": z.object({ ...base, type: z.literal("deploy.status"), deploymentId: z.string(), status: z.string(), url: z.string().optional() }),
  "meeting.status": z.object({ ...base, type: z.literal("meeting.status"), meetingId: z.string(), status: z.string() }),
} as const;

export type RenderedEventType = keyof typeof schemas;
export type RenderedEvent = { [K in RenderedEventType]: z.infer<(typeof schemas)[K]> }[RenderedEventType];

// Compile-time guard: every rendered event must be assignable from the platform's ForgeEvent of that type.
type AssertCompatible<T extends RenderedEventType> = Known<T> extends z.infer<(typeof schemas)[T]> ? true : never;
const _compat: { [K in RenderedEventType]: AssertCompatible<K> } = {
  "intent.classified": true,
  "cost.estimate": true,
  "clarify.question": true,
  "phase.started": true,
  "phase.completed": true,
  "plan.ready": true,
  "message.delta": true,
  message: true,
  "job.progress": true,
  "checkpoint.created": true,
  "artifact.ready": true,
  "approval.required": true,
  "gate.result": true,
  "task.completed": true,
  "task.failed": true,
  "preview.ready": true,
  "deploy.status": true,
  "meeting.status": true,
};
void _compat;

export type ServerMessage =
  | { kind: "event"; event: RenderedEvent }
  | { kind: "ready"; projectId: string }
  | { kind: "pong" }
  /** A valid event of a type this app does not render (e.g. tool.call, presence, terminal.output). */
  | { kind: "ignored"; type: string };

/** Parse one value (already JSON-decoded) into a typed event; null if it is not a valid event. */
export function parseEvent(value: unknown): RenderedEvent | null {
  if (!value || typeof value !== "object") return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !(type in schemas)) return null;
  const r = schemas[type as RenderedEventType].safeParse(value);
  return r.success ? (r.data as RenderedEvent) : null;
}

/** Parse a raw WebSocket text frame. Never throws; returns null for malformed input. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const type = (value as { type?: unknown }).type;
  if (type === "ready") return { kind: "ready", projectId: String((value as { projectId?: unknown }).projectId ?? "") };
  if (type === "pong") return { kind: "pong" };
  if (typeof type === "string" && type in schemas) {
    const event = parseEvent(value);
    return event ? { kind: "event", event } : null;
  }
  return typeof type === "string" && (value as { id?: unknown }).id ? { kind: "ignored", type } : null;
}

/** Rows from `project.events` store the full event in `payload`. */
export function eventsFromHistory(rows: Array<{ payload: unknown }>): RenderedEvent[] {
  const out: RenderedEvent[] = [];
  for (const r of rows) {
    const e = parseEvent(r.payload);
    if (e) out.push(e);
  }
  return out;
}

// ---------- Timeline reducer ----------

export type TimelineItem =
  | { kind: "user"; id: string; text: string; source: "typed" | "voice"; at: string; pending?: boolean }
  | { kind: "intents"; id: string; taskId?: string; intents: Array<{ kind: string; summary: string; confidence: number }>; at: string }
  | { kind: "estimate"; id: string; taskId?: string; lowUsd: number; highUsd: number; breakdown: Array<{ label: string; usd: number }>; at: string }
  | { kind: "question"; id: string; taskId?: string; question: string; options: string[]; answered: boolean; at: string }
  | { kind: "message"; id: string; role: "assistant" | "system"; text: string; at: string; streaming?: boolean }
  | { kind: "progress"; id: string; taskId?: string; phase: string; label?: string; progress?: number; done: boolean; at: string }
  | { kind: "plan"; id: string; taskId?: string; spec: unknown; requiresApproval: boolean; at: string }
  | { kind: "checkpoint"; id: string; label: string; commit: string; checkpointId: string; at: string }
  | { kind: "artifact"; id: string; artifactKind: string; url: string; at: string }
  | { kind: "approval"; id: string; action: string; at: string }
  | { kind: "gate"; id: string; gate: string; passed: boolean; details: string; at: string }
  | { kind: "result"; id: string; taskId?: string; summary: string; chargedUsd: number; at: string }
  | { kind: "failure"; id: string; taskId?: string; reason: string; charged: boolean; at: string }
  | { kind: "preview"; id: string; url: string; at: string }
  | { kind: "deploy"; id: string; status: string; url?: string; at: string };

export interface Timeline {
  items: TimelineItem[];
  /** Event ids already applied (history and live stream overlap on reconnect). */
  seen: Set<string>;
  /** Most recent preview URL (preview.ready), if any. */
  previewUrl: string | null;
  /** Task currently running, if known. */
  activeTaskId: string | null;
  /** Task waiting for a clarification answer, if any. */
  awaitingAnswer: { taskId: string; question: string; options: string[] } | null;
}

export function emptyTimeline(): Timeline {
  return { items: [], seen: new Set(), previewUrl: null, activeTaskId: null, awaitingAnswer: null };
}

const MAX_ITEMS = 500;

function push(t: Timeline, item: TimelineItem): TimelineItem[] {
  const items = [...t.items, item];
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}

/** Apply one event. Returns the same object when the event was already seen (cheap React bail-out). */
export function reduceEvent(t: Timeline, e: RenderedEvent): Timeline {
  if (t.seen.has(e.id)) return t;
  const seen = new Set(t.seen);
  seen.add(e.id);
  const next: Timeline = { ...t, seen };
  switch (e.type) {
    case "intent.classified":
      next.activeTaskId = e.taskId ?? next.activeTaskId;
      next.items = push(t, { kind: "intents", id: e.id, taskId: e.taskId, intents: e.intents, at: e.at });
      // A server echo of the user's prompt: clear the optimistic pending flag.
      next.items = next.items.map((i) => (i.kind === "user" && i.pending ? { ...i, pending: false } : i));
      return next;
    case "cost.estimate":
      next.items = push(t, { kind: "estimate", id: e.id, taskId: e.taskId, lowUsd: e.lowUsd, highUsd: e.highUsd, breakdown: e.breakdown, at: e.at });
      return next;
    case "clarify.question":
      next.items = push(t, { kind: "question", id: e.id, taskId: e.taskId, question: e.question, options: e.options ?? [], answered: false, at: e.at });
      next.awaitingAnswer = e.taskId ? { taskId: e.taskId, question: e.question, options: e.options ?? [] } : null;
      return next;
    case "phase.started": {
      // Close any open progress row for the same task, then open a new one.
      const items = t.items.map((i) => (i.kind === "progress" && !i.done && i.taskId === e.taskId ? { ...i, done: true } : i));
      next.items = push({ ...t, items }, { kind: "progress", id: e.id, taskId: e.taskId, phase: e.phase, done: false, at: e.at });
      next.activeTaskId = e.taskId ?? next.activeTaskId;
      return next;
    }
    case "phase.completed":
      next.items = t.items.map((i) => (i.kind === "progress" && i.phase === e.phase && i.taskId === e.taskId && !i.done ? { ...i, done: true, progress: 1 } : i));
      return next;
    case "job.progress": {
      const idx = findLastIndex(t.items, (i) => i.kind === "progress" && !i.done && (!e.taskId || i.taskId === e.taskId));
      if (idx >= 0) {
        const items = [...t.items];
        const cur = items[idx] as Extract<TimelineItem, { kind: "progress" }>;
        items[idx] = { ...cur, progress: clamp01(e.progress), label: e.label ?? cur.label };
        next.items = items;
      } else {
        next.items = push(t, { kind: "progress", id: e.id, taskId: e.taskId, phase: "job", label: e.label, progress: clamp01(e.progress), done: e.progress >= 1, at: e.at });
      }
      return next;
    }
    case "plan.ready":
      next.items = push(t, { kind: "plan", id: e.id, taskId: e.taskId, spec: e.spec, requiresApproval: e.requiresApproval, at: e.at });
      return next;
    case "message.delta": {
      const last = t.items[t.items.length - 1];
      if (last && last.kind === "message" && last.streaming) {
        next.items = [...t.items.slice(0, -1), { ...last, text: last.text + e.text }];
      } else {
        next.items = push(t, { kind: "message", id: e.id, role: "assistant", text: e.text, at: e.at, streaming: true });
      }
      return next;
    }
    case "message": {
      const last = t.items[t.items.length - 1];
      // The final message replaces the streamed deltas it summarises.
      const base = last && last.kind === "message" && last.streaming && e.role === "assistant" ? { ...t, items: t.items.slice(0, -1) } : t;
      next.items = push(base, { kind: "message", id: e.id, role: e.role, text: e.text, at: e.at });
      return next;
    }
    case "checkpoint.created":
      next.items = push(t, { kind: "checkpoint", id: e.id, label: e.label, commit: e.commit, checkpointId: e.checkpointId, at: e.at });
      return next;
    case "artifact.ready":
      next.items = push(t, { kind: "artifact", id: e.id, artifactKind: e.kind, url: e.url, at: e.at });
      return next;
    case "approval.required":
      next.items = push(t, { kind: "approval", id: e.id, action: e.action, at: e.at });
      return next;
    case "gate.result":
      next.items = push(t, { kind: "gate", id: e.id, gate: e.gate, passed: e.passed, details: e.details, at: e.at });
      return next;
    case "task.completed":
      next.items = push(closeProgress(t, e.taskId), { kind: "result", id: e.id, taskId: e.taskId, summary: e.summary, chargedUsd: e.chargedUsd, at: e.at });
      if (next.activeTaskId === e.taskId) next.activeTaskId = null;
      return next;
    case "task.failed":
      next.items = push(closeProgress(t, e.taskId), { kind: "failure", id: e.id, taskId: e.taskId, reason: e.reason, charged: e.charged, at: e.at });
      if (next.activeTaskId === e.taskId) next.activeTaskId = null;
      return next;
    case "preview.ready":
      next.previewUrl = e.url;
      next.items = push(t, { kind: "preview", id: e.id, url: e.url, at: e.at });
      return next;
    case "deploy.status":
      next.items = push(t, { kind: "deploy", id: e.id, status: e.status, url: e.url, at: e.at });
      return next;
    case "meeting.status":
      return next;
  }
}

export function reduceEvents(t: Timeline, events: RenderedEvent[]): Timeline {
  let cur = t;
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) cur = reduceEvent(cur, e);
  return cur;
}

/** Optimistic user bubble shown immediately when sending a prompt. */
export function addUserPrompt(t: Timeline, p: { id: string; text: string; source: "typed" | "voice"; at: string }): Timeline {
  return { ...t, items: push(t, { kind: "user", ...p, pending: true }) };
}

/** Remove an optimistic user bubble whose request failed (the text goes back into the composer). */
export function dropUserPrompt(t: Timeline, id: string): Timeline {
  return { ...t, items: t.items.filter((i) => !(i.kind === "user" && i.id === id)) };
}

/** Mark the open clarification as answered and echo the answer as a user bubble. */
export function answerQuestion(t: Timeline, p: { id: string; text: string; at: string }): Timeline {
  const items = t.items.map((i) => (i.kind === "question" && !i.answered ? { ...i, answered: true } : i));
  return { ...t, awaitingAnswer: null, items: push({ ...t, items }, { kind: "user", id: p.id, text: p.text, source: "typed", at: p.at, pending: false }) };
}

function closeProgress(t: Timeline, taskId: string | undefined): Timeline {
  return { ...t, items: t.items.map((i) => (i.kind === "progress" && !i.done && (!taskId || i.taskId === taskId) ? { ...i, done: true } : i)) };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i] as T)) return i;
  return -1;
}
