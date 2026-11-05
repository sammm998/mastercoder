import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { connect, runMigrations, eq, tasks, users, workspaces, projects, events, usageRecords } from "@forge/db";
import { MockLLMProvider, type ContentBlock } from "@forge/llm";
import { newId } from "@forge/shared";
import type { SandboxPort } from "@forge/agent-core";
import { runBuildJob } from "../src/jobs/build.js";
import { DbUsageSink, WorkerEventSink, defaultSettler } from "../src/runtime.js";

const h = connect(undefined, 4);
afterAll(() => h.close());

function tempSandbox(projectId: string): SandboxPort {
  const root = mkdtempSync(join(tmpdir(), "forge-w-"));
  return {
    id: "tmp",
    projectId,
    workdir: root,
    exec: (cmd) =>
      new Promise((res) => execFile("bash", ["-lc", cmd], { cwd: root }, (err, stdout, stderr) => res({ exitCode: err ? 1 : 0, stdout, stderr, durationMs: 1, timedOut: false }))),
    readFile: (p) => readFile(join(root, p), "utf8"),
    writeFile: async (p, c) => {
      await mkdir(dirname(join(root, p)), { recursive: true });
      await writeFile(join(root, p), c);
    },
    listFiles: async () => {
      const out: string[] = [];
      const walk = async (d: string) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.isDirectory()) await walk(join(d, e.name));
          else out.push(relative(root, join(d, e.name)));
        }
      };
      await walk(root);
      return out;
    },
    snapshot: async () => ({ snapshotId: "s1" }),
    restore: async () => undefined,
    exposePort: async (port) => ({ url: `http://127.0.0.1:${port}` }),
  };
}

async function seed(prompt: string) {
  await runMigrations();
  const uid = newId("usr");
  const ws = newId("ws");
  const prj = newId("prj");
  const tsk = newId("tsk");
  await h.db.insert(users).values({ id: uid, email: `${uid}@t.local` });
  await h.db.insert(workspaces).values({ id: ws, name: "w" });
  await h.db.insert(projects).values({ id: prj, workspaceId: ws, name: "p", createdBy: uid });
  await h.db.insert(tasks).values({ id: tsk, projectId: prj, userId: uid, prompt, status: "queued" });
  return { uid, ws, prj, tsk };
}

const ports = {
  templates: {
    select: () => "basic",
    manifest: () => ({ id: "basic", kind: "backend", install: "true", dev: "true", port: 3999 }),
    scaffold: async (_: string, w: { writeFile(p: string, c: string): Promise<void> }) => {
      await w.writeFile("README.md", "# app");
      return ["README.md"];
    },
  },
  gates: {
    run: async (sb: SandboxPort) => {
      const ok = (await sb.readFile("src/main.js").catch(() => "")).includes("ok");
      const r = { gate: "unit", passed: ok, details: ok ? "pass" : "src/main.js missing", findings: [] };
      return { passed: ok, results: [r], blockers: ok ? [] : [r] };
    },
  },
};

describe("build job", () => {
  it("runs the agent, persists events + usage, settles and charges a success", async () => {
    const s = await seed("Build an inventory API");
    const llm = new MockLLMProvider().on("agent.build", (req): ContentBlock[] | string => {
      const last = req.messages[req.messages.length - 1];
      return last?.role === "user" && typeof last.content === "string" ? [{ type: "tool_use", id: `c${req.messages.length}`, name: "write_file", input: { path: "src/main.js", content: "console.log('ok')" } }] : "Built it.";
    });
    const r = await runBuildJob(
      { taskId: s.tsk, projectId: s.prj, workspaceId: s.ws, userId: s.uid, prompt: "Build an inventory API", source: "typed", intents: [{ kind: "backend", confidence: 0.9, summary: "x" }], planMode: false },
      { db: h.db, llm, events: new WorkerEventSink(h.db, null), usage: new DbUsageSink(h.db), settle: defaultSettler, sandboxFor: async (p) => tempSandbox(p), agentPorts: async () => ports, pipelines: {}, isCancelled: async () => false },
    );
    expect(r.outcome).toBe("succeeded");
    const [t] = await h.db.select().from(tasks).where(eq(tasks.id, s.tsk));
    expect(t?.status).toBe("succeeded");
    expect(t?.charged).toBe(true);
    expect(t?.costUsd).toBeGreaterThan(0);
    const ev = await h.db.select().from(events).where(eq(events.taskId, s.tsk));
    expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(["phase.started", "tool.call", "gate.result", "task.completed"]));
    const use = await h.db.select().from(usageRecords).where(eq(usageRecords.taskId, s.tsk));
    expect(use.length).toBeGreaterThan(0);
    expect(use.every((u) => u.workspaceId === s.ws)).toBe(true);
  });

  it("does not charge when the agent fails on its own errors", async () => {
    const s = await seed("Build an inventory API");
    const llm = new MockLLMProvider().on("agent.build", () => "I could not do it.");
    const r = await runBuildJob(
      { taskId: s.tsk, projectId: s.prj, workspaceId: s.ws, userId: s.uid, prompt: "Build an inventory API", source: "typed", intents: [{ kind: "backend", confidence: 0.9, summary: "x" }], planMode: false },
      { db: h.db, llm, events: new WorkerEventSink(h.db, null), usage: new DbUsageSink(h.db), settle: defaultSettler, sandboxFor: async (p) => tempSandbox(p), agentPorts: async () => ports, pipelines: {}, isCancelled: async () => false },
    );
    expect(r.outcome).toBe("failed_agent_error");
    const [t] = await h.db.select().from(tasks).where(eq(tasks.id, s.tsk));
    expect(t).toMatchObject({ status: "failed", charged: false, chargedUsd: 0 });
    expect(t?.failureReason).toMatch(/Quality gates still failing/);
  });
});
