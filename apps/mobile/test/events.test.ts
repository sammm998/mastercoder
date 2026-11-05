import { describe, expect, it } from "vitest";
import { addUserPrompt, answerQuestion, dropUserPrompt, emptyTimeline, eventsFromHistory, parseServerMessage, reduceEvent, reduceEvents, type RenderedEvent } from "../src/lib/events.js";

let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 12, 0, s)).toISOString();
function ev<T extends RenderedEvent["type"]>(type: T, extra: Omit<Extract<RenderedEvent, { type: T }>, "id" | "projectId" | "at" | "type">, sec = n): RenderedEvent {
  n++;
  return { id: `evt_${n}`, projectId: "prj_1", at: at(sec), type, ...extra } as unknown as RenderedEvent;
}

describe("parseServerMessage", () => {
  it("parses gateway control frames", () => {
    expect(parseServerMessage('{"type":"ready","projectId":"prj_1"}')).toEqual({ kind: "ready", projectId: "prj_1" });
    expect(parseServerMessage('{"type":"pong"}')).toEqual({ kind: "pong" });
  });
  it("parses and validates known events", () => {
    const raw = JSON.stringify({ id: "e1", projectId: "p", at: at(0), type: "cost.estimate", lowUsd: 0.1, highUsd: 0.4, breakdown: [{ label: "build", usd: 0.3 }] });
    const m = parseServerMessage(raw);
    expect(m?.kind).toBe("event");
    if (m?.kind === "event" && m.event.type === "cost.estimate") expect(m.event.highUsd).toBe(0.4);
  });
  it("ignores unrendered event types and rejects malformed frames", () => {
    expect(parseServerMessage(JSON.stringify({ id: "e", projectId: "p", at: at(0), type: "presence", userId: "u", name: "A" }))).toEqual({ kind: "ignored", type: "presence" });
    expect(parseServerMessage("{nope")).toBeNull();
    expect(parseServerMessage(JSON.stringify({ id: "e", projectId: "p", at: at(0), type: "cost.estimate", lowUsd: "cheap" }))).toBeNull();
    expect(parseServerMessage("42")).toBeNull();
  });
  it("reads persisted history payloads", () => {
    const rows = [{ payload: { id: "e1", projectId: "p", at: at(0), type: "message", role: "assistant", text: "hi" } }, { payload: { junk: true } }];
    expect(eventsFromHistory(rows)).toHaveLength(1);
  });
});

describe("timeline reducer", () => {
  it("renders the full task lifecycle", () => {
    let t = addUserPrompt(emptyTimeline(), { id: "local_1", text: "Bygg en bokningsapp", source: "voice", at: at(0) });
    t = reduceEvents(t, [
      ev("intent.classified", { taskId: "tsk_1", intents: [{ kind: "app", confidence: 0.9, summary: "booking app" }] }, 1),
      ev("cost.estimate", { taskId: "tsk_1", lowUsd: 0.5, highUsd: 1.5, breakdown: [] }, 2),
      ev("phase.started", { taskId: "tsk_1", phase: "plan" }, 3),
      ev("job.progress", { taskId: "tsk_1", jobId: "j", progress: 0.5, label: "Planning" }, 4),
      ev("phase.completed", { taskId: "tsk_1", phase: "plan", durationMs: 100 }, 5),
      ev("phase.started", { taskId: "tsk_1", phase: "build" }, 6),
      ev("checkpoint.created", { taskId: "tsk_1", checkpointId: "cp_1", commit: "abc123", label: "Scaffold" }, 7),
      ev("preview.ready", { taskId: "tsk_1", url: "exp://10.0.0.2:8081" }, 8),
      ev("task.completed", { taskId: "tsk_1", summary: "Done", chargedUsd: 1.2 }, 9),
    ]);
    const kinds = t.items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "intents", "estimate", "progress", "progress", "checkpoint", "preview", "result"]);
    expect(t.items[0]).toMatchObject({ kind: "user", pending: false, source: "voice" });
    expect(t.items[3]).toMatchObject({ kind: "progress", phase: "plan", done: true, progress: 1, label: "Planning" });
    expect(t.items[4]).toMatchObject({ kind: "progress", phase: "build", done: true });
    expect(t.previewUrl).toBe("exp://10.0.0.2:8081");
    expect(t.activeTaskId).toBeNull();
  });

  it("dedupes events seen in both history and the live stream", () => {
    const e = ev("message", { role: "assistant", text: "hello" });
    const t1 = reduceEvent(emptyTimeline(), e);
    const t2 = reduceEvent(t1, e);
    expect(t2).toBe(t1);
    expect(t2.items).toHaveLength(1);
  });

  it("streams deltas and replaces them with the final message", () => {
    let t = reduceEvent(emptyTimeline(), ev("message.delta", { text: "Hel" }));
    t = reduceEvent(t, ev("message.delta", { text: "lo" }));
    expect(t.items).toEqual([expect.objectContaining({ kind: "message", text: "Hello", streaming: true })]);
    t = reduceEvent(t, ev("message", { role: "assistant", text: "Hello!" }));
    expect(t.items).toEqual([expect.objectContaining({ kind: "message", text: "Hello!" })]);
    expect((t.items[0] as { streaming?: boolean }).streaming).toBeUndefined();
  });

  it("tracks a clarifying question until answered", () => {
    let t = reduceEvent(emptyTimeline(), ev("clarify.question", { taskId: "tsk_2", question: "Which platform?", options: ["iOS", "Web"] }));
    expect(t.awaitingAnswer).toEqual({ taskId: "tsk_2", question: "Which platform?", options: ["iOS", "Web"] });
    t = answerQuestion(t, { id: "a1", text: "Web", at: at(30) });
    expect(t.awaitingAnswer).toBeNull();
    expect(t.items[0]).toMatchObject({ kind: "question", answered: true });
    expect(t.items[1]).toMatchObject({ kind: "user", text: "Web" });
  });

  it("drops an optimistic prompt whose request failed", () => {
    const t = addUserPrompt(emptyTimeline(), { id: "local_9", text: "x", source: "typed", at: at(0) });
    expect(dropUserPrompt(t, "local_9").items).toHaveLength(0);
  });

  it("closes open progress on failure", () => {
    let t = reduceEvent(emptyTimeline(), ev("phase.started", { taskId: "tsk_3", phase: "verify" }));
    t = reduceEvent(t, ev("task.failed", { taskId: "tsk_3", reason: "Gate failed: semgrep", charged: false }));
    expect(t.items[0]).toMatchObject({ kind: "progress", done: true });
    expect(t.items[1]).toMatchObject({ kind: "failure", charged: false });
  });

  it("job.progress without a phase creates its own row and clamps", () => {
    const t = reduceEvent(emptyTimeline(), ev("job.progress", { jobId: "media", progress: 1.7, label: "Rendering" }));
    expect(t.items[0]).toMatchObject({ kind: "progress", progress: 1, done: true });
  });

  it("orders out-of-order history by time", () => {
    const late = ev("task.completed", { taskId: "x", summary: "ok", chargedUsd: 0 }, 50);
    const early = ev("intent.classified", { taskId: "x", intents: [] }, 10);
    const t = reduceEvents(emptyTimeline(), [late, early]);
    expect(t.items.map((i) => i.kind)).toEqual(["intents", "result"]);
  });
});
