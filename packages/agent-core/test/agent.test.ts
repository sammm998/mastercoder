import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
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

/** Sandbox whose dev server "answers" the preview probe, so website builds don't wait on a real port. */
function previewSandbox(): TempDirSandbox {
  const sb = new TempDirSandbox();
  const exec = sb.exec.bind(sb);
  sb.exec = (cmd, opts) => (cmd.startsWith("curl ") || cmd.startsWith("node -e") ? Promise.resolve({ exitCode: 0, stdout: "200", stderr: "", durationMs: 1, timedOut: false }) : cmd.startsWith("nohup ") ? Promise.resolve({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }) : exec(cmd, opts));
  return sb;
}

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
      // Build rounds (one per planned step) write a buggy implementation; the fix round corrects it.
      return !/quality gates failed/i.test(String(last.content))
        ? [call(`w${r}`, "write_file", { path: "src/math.js", content: "export const add = (a, b) => a - b;\n" })]
        : [call(`f${r}`, "edit_file", { path: "src/math.js", oldText: "a - b", newText: "a + b" })];
    });
    const d = deps(llm);
    const out = await new BuildAgent(d).run(input);
    expect(out.status).toBe("succeeded");
    expect(out.charged).toBe(true);
    expect(out.fixIterations).toBe(1);
    // Planned tasks are built one round each, plus a completion pass and the fix round.
    expect(builds).toBeGreaterThanOrEqual((out.spec?.tasks.length ?? 0) + 2);
    expect(d.bus.ofType("team.message").filter((m) => m.key === "team.build.step").length).toBe(out.spec?.tasks.length ?? 0);
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

describe("design engine failure", () => {
  it("continues the build without the design engine instead of failing", async () => {
    const llm = new MockLLMProvider().on("agent.build", (req) => {
      const last = req.messages[req.messages.length - 1];
      return last?.role === "user" && typeof last.content === "string" ? [call(`w${req.messages.length}`, "write_file", { path: "src/math.js", content: "export const add = (a, b) => a + b;\n" })] : "Built.";
    });
    const d = deps(llm, previewSandbox());
    const design = { artDirection: async () => { throw new Error("Structured output failed for design.copy: story.steps"); } };
    const out = await new BuildAgent({ ...d, design } as AgentDeps).run({ ...input, intents: [{ kind: "website" as const, confidence: 0.9, summary: "site" }] });
    expect(out.status).toBe("succeeded");
    expect(d.bus.ofType("team.message").some((m) => m.key === "team.design.fallback")).toBe(true);
    expect(d.bus.ofType("message").map((m) => m.text).join("\n")).toMatch(/Design engine failed, continuing without it/);
  });
});

describe("follow-up prompts", () => {
  it("edits the existing project: no re-scaffold, no design re-compose, history in the build prompt", async () => {
    const sb = previewSandbox();
    await sb.writeFile("src/math.js", "export const add = (a, b) => a + b;\n");
    await sb.writeFile("test.js", 'import { add } from "./src/math.js"; if (add(2, 3) !== 5) process.exit(1);');
    const prompts: string[] = [];
    const llm = new MockLLMProvider().on("agent.build", (req) => {
      const last = req.messages[req.messages.length - 1];
      if (last?.role === "user" && typeof last.content === "string") prompts.push(last.content);
      return "Updated.";
    });
    let designed = false;
    const d = deps(llm, sb);
    const design = { artDirection: async () => ((designed = true), { directionName: "x", tokensCss: "", tokens: {} }) };
    const out = await new BuildAgent({ ...d, design } as AgentDeps).run({ ...input, prompt: "make the header blue", existingProject: true, history: "Earlier requests:\n- [failed] Build me a new website for https://remanis.se/" });
    expect(out.status).toBe("succeeded");
    expect(designed).toBe(false);
    expect(d.bus.ofType("file.changed").filter((e) => e.change === "created")).toHaveLength(0);
    expect(prompts[0]).toMatch(/Earlier in this project[\s\S]*remanis\.se[\s\S]*Follow-up request\nmake the header blue/);
  });
});

describe("mock reviewer", () => {
  it("does not mistake a Todo entity for unfinished code, but flags TODO comments", async () => {
    const llm = new MockLLMProvider();
    const ask = async (body: string) =>
      JSON.parse((await llm.complete({ purpose: "agent.review", model: "m", messages: [{ role: "user", content: `### src/todos.ts\n\`\`\`\n${body}\n\`\`\`` }] })).content.map((b) => (b.type === "text" ? b.text : "")).join(""));
    expect((await ask("export type Todo = { title: string }; export const TODO_LIMIT = 50;")).approved).toBe(true);
    expect((await ask("export function save() { // TODO persist\n}")).approved).toBe(false);
  });
});

describe("design proposals", () => {
  it("shows 3 directions and waits for a choice; the picked direction is passed to the design engine", async () => {
    const dirs = [{ id: "a", name: "Nordic" }, { id: "b", name: "Bold" }, { id: "c", name: "Soft" }];
    const seen: unknown[] = [];
    const design = {
      proposeDirections: async () => dirs,
      artDirection: async (i: { direction?: unknown }) => (seen.push(i.direction), { directionName: "Bold", tokensCss: ":root{}", tokens: {} }),
    };
    const d = deps(new MockLLMProvider(), previewSandbox());
    const site = { ...input, intents: [{ kind: "website" as const, confidence: 0.9, summary: "site" }], prompt: "Visa tre designförslag för ett kafé" };
    const first = await new BuildAgent({ ...d, design } as AgentDeps).run({ ...site, wantsDesignOptions: true });
    expect(first.status).toBe("awaiting_approval");
    expect(d.bus.ofType("design.directions")[0]).toMatchObject({ requiresChoice: true, directions: dirs });
    expect(seen).toHaveLength(0);
    const llm = new MockLLMProvider().on("agent.build", (req) => {
      const last = req.messages[req.messages.length - 1];
      return last?.role === "user" && typeof last.content === "string" ? [call("w", "write_file", { path: "src/math.js", content: "export const add = (a, b) => a + b;\n" })] : "Built.";
    });
    const d2 = deps(llm, previewSandbox());
    const second = await new BuildAgent({ ...d2, design } as AgentDeps).run({ ...site, wantsDesignOptions: true, approvedSpec: first.spec, designDirection: dirs[1] });
    expect(second.status).toBe("succeeded");
    expect(seen).toEqual([dirs[1]]);
  });
});

describe("preview probe", () => {
  it("detects a running dev server without curl and reports a closed port as down", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const agent = new BuildAgent(deps(new MockLLMProvider())) as unknown as { previewAlive(p: number): Promise<boolean> };
    expect(await agent.previewAlive(port)).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await agent.previewAlive(port)).toBe(false);
  });
});

describe("fetch_url", () => {
  it("reads a public page into title, headings, text, same-site links and images", async () => {
    const { readPage } = await import("../src/tools.js");
    const html = `<html><head><title>Remanis</title><meta name="description" content="Automation"><style>x{}</style></head><body><h1>We automate</h1><img src="/a.png"><a href="/about">About</a><a href="https://other.com">x</a><script>bad()</script><p>Nordic   factories</p></body></html>`;
    const out = await readPage("https://remanis.se/", (async () => new Response(html)) as unknown as typeof fetch);
    expect(out).toMatch(/Title: Remanis/);
    expect(out).toMatch(/- We automate/);
    expect(out).toMatch(/Nordic factories/);
    expect(out).toMatch(/https:\/\/remanis\.se\/a\.png/);
    expect(out).toMatch(/https:\/\/remanis\.se\/about/);
    expect(out).not.toMatch(/other\.com|bad\(\)/);
  });
  it("refuses private hosts", async () => {
    const { readPage } = await import("../src/tools.js");
    for (const u of ["http://localhost:3000", "http://10.0.0.5/", "http://forgeagent-worker.railway.internal:5173"]) await expect(readPage(u)).rejects.toThrow(/public/);
  });
});

describe("per-project preview ports", () => {
  it("gives each project its own stable port and rewrites the dev command", async () => {
    const { devPort, devCommand } = await import("../src/agent.js");
    const a = devPort("prj_gina3d");
    expect(devPort("prj_gina3d")).toBe(a);
    expect(devPort("prj_taxilund")).not.toBe(a);
    expect(a).toBeGreaterThanOrEqual(20000);
    expect(devCommand("npm run dev -- --hostname 0.0.0.0 --port 3000", 3000, 23456)).toBe("PORT=23456 npm run dev -- --hostname 0.0.0.0 --port 23456");
    expect(devCommand("npx vite -p 5173", 5173, 21000)).toBe("PORT=21000 npx vite -p 21000");
    expect(devCommand("npm run dev", 3000, 22000)).toBe("PORT=22000 npm run dev");
  });
});

describe("dependency changes from the shell", () => {
  it("reports package manifests as changed after npm install via run_command", async () => {
    const sb = new TempDirSandbox();
    const exec = sb.exec.bind(sb);
    sb.exec = (cmd, o) => (cmd.startsWith("npm install") ? Promise.resolve({ exitCode: 0, stdout: "added 1 package", stderr: "", durationMs: 1, timedOut: false }) : exec(cmd, o));
    const llm = new MockLLMProvider().on("t", (req) => (round(req) === 0 ? [call("a", "run_command", { command: "npm install three" })] : "done"));
    const bus = new EventBus();
    const tools = buildTools({ deps: { ...deps(llm, sb), events: bus }, projectId: "p", taskId: "t", repoMap: new RepoMap(), index: new MemoryVectorIndex(), manifest: () => null, previewUrl: () => null, touched: new Set() });
    await runToolLoop({ llm, model: "m", purpose: "t", system: "s", messages: [{ role: "user", content: "go" }], tools, events: bus, projectId: "p", taskId: "t" });
    expect(bus.ofType("file.changed").map((e) => e.path)).toContain("package.json");
  });
});
