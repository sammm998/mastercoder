import type { ForgeEvent } from "@forge/shared";

export type { ForgeEvent };
export type EventOf<T extends ForgeEvent["type"]> = Extract<ForgeEvent, { type: T }>;

/** Minimal runtime guard: the gateway already validates with ForgeEventSchema before sending. */
export function isForgeEvent(v: unknown): v is ForgeEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.type === "string" && typeof e.id === "string" && typeof e.projectId === "string" && typeof e.at === "string";
}

/** Merge history + live events: dedupe by id, keep chronological order, cap memory. */
export function mergeEvents(current: ForgeEvent[], incoming: ForgeEvent[], cap = 2000): ForgeEvent[] {
  if (!incoming.length) return current;
  const seen = new Set(current.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  if (!fresh.length) return current;
  const all = current.concat(fresh);
  const sorted = fresh.some((e, i) => i > 0 && e.at < fresh[i - 1]!.at) || (current.length && fresh[0]!.at < current[current.length - 1]!.at) ? [...all].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) : all;
  return sorted.length > cap ? sorted.slice(sorted.length - cap) : sorted;
}

/** Collapse streaming deltas into the message they belong to (per task). */
export interface ChatItem {
  key: string;
  kind: "assistant" | "system" | "event";
  text?: string;
  event?: ForgeEvent;
  taskId?: string;
  at: string;
}

// phase.started is shown by the stepper; only completions stay in the timeline.
const HIDDEN = new Set<string>(["presence", "terminal.output", "file.changed", "job.progress", "usage", "team.message", "phase.started"]);

export function toChatItems(events: ForgeEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  let streaming: ChatItem | null = null;
  for (const e of events) {
    if (e.type === "message.delta") {
      if (!streaming || streaming.taskId !== e.taskId) {
        streaming = { key: `d-${e.id}`, kind: "assistant", text: "", taskId: e.taskId, at: e.at };
        items.push(streaming);
      }
      streaming.text += e.text;
      continue;
    }
    if (e.type === "message") {
      // A final message replaces the streamed text it completes.
      if (streaming && streaming.taskId === e.taskId && e.role === "assistant") {
        streaming.text = e.text;
        streaming.key = e.id;
        streaming = null;
        continue;
      }
      streaming = null;
      items.push({ key: e.id, kind: e.role, text: e.text, taskId: e.taskId, at: e.at });
      continue;
    }
    if (HIDDEN.has(e.type)) continue;
    if (e.type === "tool.result") {
      // Attach results to their call card instead of a separate row.
      continue;
    }
    streaming = null;
    items.push({ key: e.id, kind: "event", event: e, taskId: e.taskId, at: e.at });
  }
  return items;
}

/** Latest event of a type (e.g. preview.ready). */
export function latest<T extends ForgeEvent["type"]>(events: ForgeEvent[], type: T): EventOf<T> | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === type) return events[i] as EventOf<T>;
  return undefined;
}

export function toolResults(events: ForgeEvent[]): Map<string, EventOf<"tool.result">> {
  const m = new Map<string, EventOf<"tool.result">>();
  for (const e of events) if (e.type === "tool.result") m.set(e.callId, e);
  return m;
}

/** Strip ANSI escape sequences from terminal output. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, "");
}
