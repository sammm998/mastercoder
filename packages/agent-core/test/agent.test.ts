import { describe, it, expect } from "vitest";
import { MockLLMProvider, type CompletionRequest, type ContentBlock } from "@forge/llm";
import { EventBus, MemoryUsageSink } from "@forge/shared";
import { BuildAgent, LoopGuard, classifyStep, errorSignature, mockPlan, runToolLoop, buildTools, RepoMap, MemoryVectorIndex, type AgentDeps } from "../src/index.js";
import { TempDirSandbox, fakeTemplates, testGates } from "./helpers.js";

const input = { taskId: "tsk_1", projectId: "prj_test", workspaceId: "ws_1", prompt: "Build an inventory API", intents: [{ kind: "backend" as const, confidence: 0.9, summary: "inventory" }], planMode: false };

/** Count tool_result rounds already in the conversation (scripted builder state). */
function round(req: CompletionRequest): number {
  return req.messages.filter((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")).length;
}
const call = (id: string, name: string, inp: unknown): ContentBlock => ({ type: "tool_use", id, name, input: inp });

function deps(llm: MockLLMProvider, sandbox = new TempDirSandbox()): AgentDeps & { bus: EventBus } {
  const bus = new EventBus();
  return { llm, events: bus, usage: new MemoryUsageSink(), sandbox, templates: fakeTemplates, gates: testGates, bus };
}

describe("loop guard", () => {
  it("changes strategy after 3 identical errors and stops at 8 iterations", () => {
    const g = new LoopGuard(8, 3);
    const err = "TypeError at src/a.ts:10:5 took 120ms";
    expect(g.recordFailure(err).action).toBe("continue");
    expect(g.recordFailure(err.replace("10:5", "11:7").replace("120ms", "99ms")).action).toBe("continue");
    const d = g.recordFailure(err);
    expect(d).toMatchObject({ action: "change_strategy", strategy: "reread_files" });
    expect(g.recordFailure("other").action).toBe("continue");
    for (let i = 0; i < 3; i++) g.recordFailure("x");
    expect(g.recordFailure("x").action).toBe("stop");
    expect(errorSignature("a:1:2")).toBe(errorSignature("a:9:9"));
  });
});

describe("model router", () => {
  it("routes by complexity", () => {
    expect(classifyStep({ phase: "plan" })).toBe("complex");
    expect(classifyStep({ phase: "fix", description: "change button color", fileCount: 1 })).toBe("trivial");
    expect(classifyStep({ phase: "build", description: "add a page" })).toBe("normal");
    expect(classifyStep({ phase: "fix", failures: 3 })).toBe("complex");
    expect(classifyStep({ phase: "build", description: "implement auth" })).toBe("complex");
  });
});

describe("mock planner", () => {
  it("derives domain data models", () => {
    const s = mockPlan("Build a booking system for a hair salon", "app");
    expect(s.entities.map((e) => e.name)).toEqual(["Service", "Stylist", "Booking"]);
    expect(s.acceptanceTests.length).toBeGreaterThanOrEqual(3);
    expect(mockPlan("Bygg en att-göra-app", "app").entities[0]?.name).toBe("Todo");
    expect(mockPlan('Landing page for "Nordlys"', "website").title).toBe("Nordlys Landing Page");
  });
});

describe("tool loop", () => {
  it("executes parallel tool calls and returns all results in one user message", async () => {
    const sb = new TempDirSandbox();
    const llm = new MockLLMProvider().on("t", (req) =>
      round(req) === 0 ? [call("a", "write_file", { path: "a.txt", content: "A" }), call("b", "write_file", { path: "b.txt", content: "B" })] : "done",
    );
    const bus = new EventBus();
    const tools = buildTools({ deps: { ...deps(llm, sb), events: bus }, projectId: "p", taskId: "t", repoMap: new RepoMap(), index: new MemoryVectorIndex(), manifest: () => null, previewUrl: () => null, touched: new Set() });
    const r = await runToolLoop({ llm, model: "claude-haiku-5-5", purpose: "t", system: "s", messages: [{ role: "user", content: "go" }], tools, events: bus, projectId: "p", taskId: "t" });
    expect(r.toolCalls).toBe(2);
    expect(await sb.readFile("b.txt")).toBe("B");
    const toolMsg = r.messages[2]!;
    expect(Array.isArray(toolMsg.content) && toolMsg.content.filter((b) => b.type === "tool_result")).toHaveLength(2);
    expect(bus.ofType("file.changed")).toHaveLength(2);
  });

  it("rejects path traversal", async () => {
    const llm = new MockLLMProvider().on("t", (req) => (round(req) === 0 ? [call("a", "write_file", { path: "../escape.txt", content: "x" })] : "ok"));
    const bus = new EventBus();
    const tools = buildTools({ deps: deps(llm), projectId: "p", taskId: "t", repoMap: new RepoMap(), index: new MemoryVectorIndex(), manifest: () => null, previewUrl: () => null, touched: new Set() });
    const r = await runToolLoop({ llm, model: "m", purpose: "t", system: "s", messages: [{ role: "user", content: "go" }], tools, events: bus, projectId: "p", taskId: "t" });
    expect(r.toolErrors[0]).toMatch(/relative/);
  });
});

describe("BuildAgent", () => {
  it("plans, builds, fixes gate failures, reviews and finishes", async () => {
    let builds = 0;
    const llm = new MockLLMProvider().on("agent.build", (req) => {
      const r = round(req);
      const last = req.messages[req.messages.length - 1];
      const isNewRound = last?.role === "user" && typeof last.content === "string";
      if (isNewRound) builds++;
      if (!isNewRound) return "Implemented.";
      // First build round writes a buggy implementation; the fix round corrects it.
      return builds === 1
        ? [call(`w${r}`, "write_file", { path: "src/math.js", content: "export const add = (a, b) => a - b;\n" })]
        : [call(`f${r}`, "edit_file", { path: "src/math.js", oldText: "a - b", newText: "a + b" })];
    });
    const d = deps(llm);
    const out = await new BuildAgent(d).run(input);
    expect(out.status).toBe("succeeded");
    expect(out.charged).toBe(true);
    expect(out.fixIterations).toBe(1);
    expect(await d.sandbox.readFile("src/math.js")).toContain("a + b");
    const types = d.bus.history.map((e) => e.type);
    expect(types).toContain("plan.ready");
    expect(types.filter((t) => t === "gate.result").length).toBe(2);
    expect(d.bus.ofType("phase.started").map((e) => e.phase)).toEqual(["plan", "build", "verify", "verify", "review", "finish"]);
  });

  it("stops via the loop guard and does not charge when gates never pass", async () => {
    const llm = new MockLLMProvider().on("agent.build", (req) => {
      const last = req.messages[req.messages.length - 1];
      return last?.role === "user" && typeof last.content === "string" ? [call(`w${req.messages.length}`, "write_file", { path: "src/math.js", content: "export const add = () => 0;\n" })] : "Tried.";
    });
    const d = deps(llm);
    const out = await new BuildAgent(d, { maxFixIterations: 8 }).run(input);
    expect(out.status).toBe("failed");
    expect(out.charged).toBe(false);
    expect(out.blockedOn).toBe("unit");
    expect(out.fixIterations).toBeLessThanOrEqual(8);
    const sys = d.bus.ofType("message").map((m) => m.text).join("\n");
    expect(sys).toMatch(/Changing strategy \(reread_files\)/);
    expect(sys).toMatch(/Changing strategy \(search_docs\)/);
    expect(d.bus.ofType("task.failed")[0]).toMatchObject({ charged: false });
  });

  it("returns the plan for approval in plan mode", async () => {
    const d = deps(new MockLLMProvider());
    const out = await new BuildAgent(d).run({ ...input, planMode: true });
    expect(out.status).toBe("awaiting_approval");
    expect(d.bus.ofType("plan.ready")[0]?.requiresApproval).toBe(true);
    const again = await new BuildAgent(deps(new MockLLMProvider().on("agent.build", () => "nothing to do"))).run({ ...input, approvedSpec: out.spec });
    expect(again.spec?.title).toBe(out.spec?.title);
  });
});
