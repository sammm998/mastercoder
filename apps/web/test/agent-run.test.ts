import { describe, it, expect } from "vitest";
import type { ForgeEvent } from "@forge/shared";
import en from "../messages/en.json";
import sv from "../messages/sv.json";
import { createTranslator } from "../src/i18n/translate";
import { asTeamMessage, currentTaskId, groupTimeline, liveFiles, phaseSteps, stripSkipped, summarizeGates, taskCost, teamRuns, terminalTail, toolArg } from "../src/lib/agent-run";
import { teamText } from "../src/features/chat/TeamThread";
import { taskCreateInput } from "../src/lib/task-input";

let n = 0;
const ev = (e: Record<string, unknown>): ForgeEvent => ({ id: `e${n++}`, projectId: "p", at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), taskId: "t1", ...e }) as ForgeEvent;
const gate = (gate: string, passed: boolean, details: string, fix?: string) => ev({ type: "gate.result", gate, passed, details, fix }) as Extract<ForgeEvent, { type: "gate.result" }>;

describe("quality gates", () => {
  it("strips duplicated skipped: prefixes", () => {
    expect(stripSkipped("skipped: skipped: no lockfile or dependency manifest found")).toBe("no lockfile or dependency manifest found");
    expect(stripSkipped("  Skipped:  no previewUrl")).toBe("no previewUrl");
  });

  it("counts passed / failed / skipped separately and keeps the latest result per gate", () => {
    const sum = summarizeGates([
      gate("typecheck", true, "0 errors"),
      gate("lint", true, "ok"),
      gate("semgrep", false, "semgrep not installed — used Forge built-in OWASP rules: 1 blocking finding(s)", "Validate input with zod"),
      gate("osv", true, "skipped: skipped: no lockfile"),
      gate("e2e", true, "skipped: no Playwright browser in the sandbox image"),
      gate("lint", true, "ok after fix"),
    ]);
    expect([sum.passed, sum.failed, sum.skipped]).toEqual([2, 1, 2]);
    expect(sum.items.map((i) => i.gate)).toEqual(["typecheck", "lint", "semgrep", "osv", "e2e"]);
    const semgrep = sum.items.find((i) => i.gate === "semgrep")!;
    expect(semgrep.status).toBe("failed");
    expect(semgrep.findings).toBe(1);
    expect(semgrep.fix).toBe("Validate input with zod");
    expect(sum.items.find((i) => i.gate === "osv")!.details).toBe("no lockfile");
  });

  it("renders a Swedish summary from structured counts, not server text", () => {
    const t = createTranslator(sv, "sv");
    const parts = [t("project.gates.passedCount", { count: 11 }), t("project.gates.failedCount", { count: 1 }), t("project.gates.skippedCount", { count: 3 })];
    expect(parts.join(" · ")).toBe("11 godkända · 1 underkänd · 3 överhoppade");
    expect(t("project.gates.name.semgrep")).toBe("Säkerhetsskanning av kod");
  });
});

describe("phases, cost and files", () => {
  it("derives the stepper from phase events", () => {
    const events = [ev({ type: "phase.started", phase: "plan" }), ev({ type: "phase.completed", phase: "plan", durationMs: 10 }), ev({ type: "phase.started", phase: "design" }), ev({ type: "phase.completed", phase: "design", durationMs: 10 }), ev({ type: "phase.started", phase: "build" })];
    expect(phaseSteps(events).map((s) => s.state)).toEqual(["done", "done", "active", "todo", "todo", "todo"]);
    expect(phaseSteps([...events, ev({ type: "task.failed", reason: "x", charged: false })]).map((s) => s.state)).toEqual(["done", "done", "failed", "todo", "todo", "todo"]);
    expect(phaseSteps([...events, ev({ type: "task.completed", summary: "ok", chargedUsd: 0 })]).every((s) => s.state === "done" || s.state === "todo")).toBe(true);
  });

  it("flags mock runs (tokens used, nothing charged) and sums real usage", () => {
    expect(taskCost([ev({ type: "cost.estimate", lowUsd: 0.5, highUsd: 1, breakdown: [] }), ev({ type: "usage", costUsd: 0, tokensIn: 100, tokensOut: 50 })])).toMatchObject({ lowUsd: 0.5, highUsd: 1, spentUsd: 0, tokens: 150, mock: true });
    expect(taskCost([ev({ type: "usage", costUsd: 0.25, tokensIn: 1, tokensOut: 1 }), ev({ type: "usage", costUsd: 0.5, tokensIn: 1, tokensOut: 1 })])).toMatchObject({ spentUsd: 0.75, mock: false });
  });

  it("lists live files newest first, one row per path", () => {
    const files = liveFiles([ev({ type: "file.changed", path: "a.ts", change: "created" }), ev({ type: "file.changed", path: "b.ts", change: "created" }), ev({ type: "file.changed", path: "a.ts", change: "modified" })]);
    expect(files.map((f) => [f.path, f.change])).toEqual([
      ["a.ts", "created"],
      ["b.ts", "created"],
    ]);
  });

  it("keeps only the last N terminal lines", () => {
    const tail = terminalTail([ev({ type: "terminal.output", stream: "stdout", text: "1\n2\n3" }), ev({ type: "terminal.output", stream: "stderr", text: "4\n5" })], 3);
    expect(tail.map((x) => x.text).join("\n")).toBe("3\n4\n5");
    expect(tail[tail.length - 1]!.stream).toBe("stderr");
  });

  it("focuses on the task with the latest event", () => {
    expect(currentTaskId([ev({ type: "usage", costUsd: 0, tokensIn: 1, tokensOut: 1 }), ev({ type: "usage", costUsd: 0, tokensIn: 1, tokensOut: 1, taskId: "t2" })])).toBe("t2");
    expect(currentTaskId([])).toBeUndefined();
  });
});

describe("timeline grouping and tools", () => {
  it("collapses consecutive gates of a task and consecutive tool calls", () => {
    const items = [gate("lint", true, "ok"), gate("unit", true, "ok"), ev({ type: "tool.call", tool: "write_file", input: { path: "x" }, callId: "c1" }), ev({ type: "tool.call", tool: "run_tests", input: {}, callId: "c2" }), ev({ type: "message", role: "assistant", text: "hi" })].map((e) => ({ key: e.id, event: e, taskId: e.taskId }));
    expect(groupTimeline(items).map((g) => [g.kind, g.kind === "single" ? 1 : g.items.length])).toEqual([
      ["gates", 2],
      ["tools", 2],
      ["single", 1],
    ]);
  });

  it("shows a short argument for a tool, never the whole input", () => {
    expect(toolArg({ path: "src/app/page.tsx", content: "…lots…" })).toBe("src/app/page.tsx");
    expect(toolArg({ command: "pnpm test" })).toBe("pnpm test");
    expect(toolArg({ packages: ["zod", "react"] })).toBe("zod react");
    expect(toolArg("x")).toBeNull();
  });
});

describe("team conversation", () => {
  const team = (e: Record<string, unknown>) => ev({ type: "team.message", params: {}, text: "fallback", ...e } as never);

  it("validates team.message events and groups them per task", () => {
    expect(asTeamMessage({ type: "team.message", id: "x", projectId: "p", at: "now", from: "nobody", status: "done", step: "plan", key: "k", text: "t" })).toBeNull();
    const runs = teamRuns([
      team({ from: "scoutr", to: "plania", status: "asking", step: "plan", key: "team.plan.ask", params: { request: "A shop" } }),
      team({ from: "plania", to: "scoutr", status: "done", step: "plan", key: "team.plan.done", params: { title: "Shop", stories: 3, entities: 2, tests: 1 } }),
      team({ from: "byggo", to: "scoutr", status: "done", step: "build", key: "team.build.done", params: { files: 12, tools: 30 } }),
      team({ from: "scoutr", to: "user", status: "done", step: "finish", key: "team.finish", params: { title: "Shop", files: 12 } }),
    ]);
    const run = runs.get("t1")!;
    expect(run.state).toBe("done");
    expect(run.steps.map((s) => [s.step, s.status])).toEqual([
      ["plan", "done"],
      ["build", "done"],
      ["finish", "done"],
    ]);
  });

  it("translates key + params in both languages and falls back to the English text", () => {
    const m = asTeamMessage(team({ from: "plania", status: "done", step: "plan", key: "team.plan.done", params: { title: "Shop", stories: 1, entities: 2, tests: 3 } }))!;
    expect(teamText(createTranslator(sv, "sv"), m)).toBe("Klart ✓ ”Shop”: 1 användarberättelse, 2 dataentiteter, 3 acceptanstester — tillbaka till dig, Scoutr");
    expect(teamText(createTranslator(en, "en"), m)).toContain("1 user story, 2 data entities, 3 acceptance tests");
    const unknown = asTeamMessage(team({ from: "revy", status: "done", step: "review", key: "team.review.brandnew", text: "English fallback" }))!;
    expect(teamText(createTranslator(sv, "sv"), unknown)).toBe("English fallback");
  });
});

describe("task.create input", () => {
  it("sends the mode and keeps planMode for older APIs", () => {
    expect(taskCreateInput("p", "x", { source: "typed", mode: "plan" })).toEqual({ projectId: "p", prompt: "x", source: "typed", planMode: true, mode: "plan" });
    expect(taskCreateInput("p", "x", { source: "voice", mode: "chat" })).toMatchObject({ planMode: false, mode: "chat" });
  });
});
