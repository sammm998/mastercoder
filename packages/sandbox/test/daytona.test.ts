import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalObjectStore, MemoryUsageSink } from "@forge/shared";
import { SnapshotStore } from "../src/snapshots.js";

const calls: Array<{ fn: string; args: unknown[] }> = [];
const fsMap = new Map<string, Buffer>();

vi.mock("@daytonaio/sdk", () => {
  class DaytonaNotFoundError extends Error {}
  const MARK = "__FORGE_STDERR_9f2c__";
  const sandbox = (id: string) => ({
    id,
    labels: { "forge.project": "proj-d" },
    cpu: 2,
    memory: 4,
    process: {
      executeCommand: vi.fn(async (command: string, cwd?: string, env?: Record<string, string>, timeout?: number) => {
        calls.push({ fn: "exec", args: [command, cwd, env, timeout] });
        if (command.includes("boom")) return { exitCode: 3, result: `partial\n${MARK}\nbad things\n` };
        const tarOut = /(\/tmp\/snap_[a-z0-9]+\.tar\.gz)/.exec(command)?.[1];
        if (tarOut) fsMap.set(tarOut, Buffer.from([31, 139]));
        if (command.includes("find ")) return { exitCode: 0, result: `/workspace/x.ts\n\n${MARK}\n` };
        return { exitCode: 0, result: `hello\n${MARK}\n` };
      }),
    },
    fs: {
      uploadFile: vi.fn(async (b: Buffer, p: string) => {
        calls.push({ fn: "upload", args: [p] });
        fsMap.set(p, b);
      }),
      downloadFile: vi.fn(async (p: string) => {
        const v = fsMap.get(p);
        if (!v) throw new Error("not found");
        return v;
      }),
    },
    getSignedPreviewUrl: vi.fn(async (port: number) => ({ url: `https://${port}-${id}.proxy.daytona.works?tkn=abc`, token: "abc", port, sandboxId: id })),
    stop: vi.fn(async () => calls.push({ fn: "stop", args: [] })),
    start: vi.fn(async () => calls.push({ fn: "start", args: [] })),
    delete: vi.fn(async () => calls.push({ fn: "delete", args: [] })),
  });
  class Daytona {
    constructor(readonly config: unknown) {
      calls.push({ fn: "ctor", args: [config] });
    }
    async create(params: unknown, options: unknown) {
      calls.push({ fn: "create", args: [params, options] });
      return sandbox("dt-1");
    }
    async get(id: string) {
      if (id === "missing") throw new DaytonaNotFoundError("nope");
      return sandbox(id);
    }
  }
  return { Daytona, DaytonaNotFoundError };
});

const { DaytonaSandboxProvider } = await import("../src/adapters/daytona.js");
const store = () => new SnapshotStore(new LocalObjectStore(mkdtempSync(join(tmpdir(), "dt-"))));

describe("DaytonaSandboxProvider (SDK mocked)", () => {
  beforeEach(() => {
    calls.length = 0;
    fsMap.clear();
  });

  it("creates from image with resources, labels and domain allowlist (EU target by default)", async () => {
    const usage = new MemoryUsageSink();
    const p = new DaytonaSandboxProvider({ apiKey: "k", allowlist: ["registry.npmjs.org"], usage, snapshotStore: store() });
    const sb = await p.create({ projectId: "proj-d", cpu: 2, memoryMb: 3000, egressAllowlist: ["pypi.org"], env: { A: "b" }, timeoutSec: 600 });
    expect(calls.find((c) => c.fn === "ctor")?.args[0]).toMatchObject({ apiKey: "k", target: "eu" });
    const [params] = calls.find((c) => c.fn === "create")!.args as [Record<string, unknown>];
    expect(params).toMatchObject({
      image: "node:22-bookworm-slim",
      resources: { cpu: 2, memory: 3 },
      labels: { "forge.project": "proj-d" },
      envVars: { A: "b" },
      domainAllowList: "registry.npmjs.org,pypi.org",
      autoStopInterval: 10,
    });
    expect(sb.id).toBe("dt-1");

    const r = await sb.exec("echo hello", { cwd: "app", timeoutMs: 5000 });
    expect(r).toMatchObject({ exitCode: 0, stdout: "hello", stderr: "", timedOut: false });
    const execCall = calls.filter((c) => c.fn === "exec").at(-1)!;
    expect(execCall.args[1]).toBe("/workspace/app");
    expect(execCall.args[3]).toBe(15);
    expect(String(execCall.args[0])).toContain("timeout -s KILL 5");
    const bad = await sb.exec("boom");
    expect(bad).toMatchObject({ exitCode: 3, stdout: "partial", stderr: "bad things\n" });

    await sb.writeFile("a/b.txt", "B");
    expect(fsMap.get("/workspace/a/b.txt")?.toString()).toBe("B");
    expect(await sb.readFile("a/b.txt")).toBe("B");
    expect(await sb.listFiles(".", { recursive: true })).toEqual(["x.ts"]);
    expect((await sb.exposePort(3000)).url).toContain("3000-dt-1");

    await sb.pause();
    await sb.resume();
    await sb.destroy();
    expect(calls.map((c) => c.fn)).toEqual(expect.arrayContaining(["stop", "start", "delete"]));
    expect(usage.records.filter((u) => u.provider === "daytona")).toHaveLength(2);
  });

  it("creates from a snapshot template and supports snapshot/restore", async () => {
    const p = new DaytonaSandboxProvider({ apiKey: "k", snapshotStore: store() });
    const sb = await p.create({ projectId: "proj-d", template: "forge-next" });
    const [params] = calls.find((c) => c.fn === "create")!.args as [Record<string, unknown>];
    expect(params.snapshot).toBe("forge-next");
    expect(params.image).toBeUndefined();
    const { snapshotId } = await sb.snapshot();
    await sb.restore(snapshotId);
    expect(calls.some((c) => c.fn === "upload" && String(c.args[0]).startsWith("/tmp/restore-"))).toBe(true);
  });

  it("get() maps not-found to null", async () => {
    const p = new DaytonaSandboxProvider({ apiKey: "k", snapshotStore: store() });
    expect(await p.get("missing")).toBeNull();
    expect((await p.get("dt-9"))?.projectId).toBe("proj-d");
  });
});
