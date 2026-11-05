import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalObjectStore, MemoryUsageSink } from "@forge/shared";
import { SnapshotStore } from "../src/snapshots.js";

const calls: Array<{ fn: string; args: unknown[] }> = [];
const files = new Map<string, Uint8Array | string>();

vi.mock("e2b", () => {
  class SandboxError extends Error {}
  class CommandExitError extends SandboxError {
    constructor(readonly result: { exitCode: number; stdout: string; stderr: string }) {
      super("exit");
    }
    get exitCode() {
      return this.result.exitCode;
    }
    get stdout() {
      return this.result.stdout;
    }
    get stderr() {
      return this.result.stderr;
    }
  }
  class TimeoutError extends SandboxError {}
  class NotFoundError extends SandboxError {}
  const make = (id: string) => ({
    sandboxId: id,
    commands: {
      run: vi.fn(async (cmd: string, opts: unknown) => {
        calls.push({ fn: "run", args: [cmd, opts] });
        if (cmd === "fail") throw new CommandExitError({ exitCode: 7, stdout: "o", stderr: "e" });
        if (cmd === "slow") throw new TimeoutError("timed out");
        const tarOut = /-czf '([^']+)'/.exec(cmd)?.[1];
        if (tarOut) files.set(tarOut, new Uint8Array([31, 139, 8]));
        if (cmd.startsWith("find ")) return { exitCode: 0, stdout: "/workspace/a.txt\n/workspace/d/b.txt\n", stderr: "" };
        return { exitCode: 0, stdout: `ran:${cmd}`, stderr: "" };
      }),
    },
    files: {
      read: vi.fn(async (p: string) => {
        calls.push({ fn: "read", args: [p] });
        const v = files.get(p);
        if (v === undefined) throw new Error("missing");
        return typeof v === "string" ? new TextEncoder().encode(v) : v;
      }),
      write: vi.fn(async (p: string, d: Uint8Array | string) => {
        calls.push({ fn: "write", args: [p] });
        files.set(p, d);
      }),
    },
    getHost: (port: number) => `${port}-${id}.e2b.app`,
    getInfo: async () => ({ metadata: { "forge.project": "proj-e2b" } }),
    pause: vi.fn(async () => calls.push({ fn: "pause", args: [] })),
    kill: vi.fn(async () => calls.push({ fn: "kill", args: [] })),
  });
  const Sandbox = {
    create: vi.fn(async (template: string, opts: unknown) => {
      calls.push({ fn: "create", args: [template, opts] });
      return make("sbx_123");
    }),
    connect: vi.fn(async (id: string) => {
      calls.push({ fn: "connect", args: [id] });
      if (id === "gone") throw new NotFoundError("nope");
      return make(id);
    }),
  };
  return { Sandbox, CommandExitError, TimeoutError, NotFoundError, ALL_TRAFFIC: "0.0.0.0/0" };
});

const { E2BSandboxProvider } = await import("../src/adapters/e2b.js");

describe("E2BSandboxProvider (SDK mocked)", () => {
  beforeEach(() => {
    calls.length = 0;
    files.clear();
  });

  it("creates with deny-all egress + allowlist, metadata and envs", async () => {
    const usage = new MemoryUsageSink();
    const p = new E2BSandboxProvider({ apiKey: "k", allowlist: ["registry.npmjs.org"], usage, snapshotStore: new SnapshotStore(new LocalObjectStore(mkdtempSync(join(tmpdir(), "e2b-")))) });
    expect(p.isMock).toBe(false);
    const sb = await p.create({ projectId: "proj-e2b", egressAllowlist: ["api.example.com:8443"], env: { A: "1" }, timeoutSec: 600 });
    const create = calls.find((c) => c.fn === "create")!;
    expect(create.args[0]).toBe("base");
    expect(create.args[1]).toMatchObject({
      apiKey: "k",
      metadata: { "forge.project": "proj-e2b" },
      envs: { A: "1" },
      timeoutMs: 600000,
      network: { allowOut: ["registry.npmjs.org", "api.example.com"], denyOut: ["0.0.0.0/0"] },
    });
    expect(calls.some((c) => c.fn === "run" && String(c.args[0]).startsWith("mkdir -p /workspace") && (c.args[1] as { user: string }).user === "root")).toBe(true);
    expect(sb.id).toBe("sbx_123");

    const ok = await sb.exec("echo hi", { cwd: "src", env: { X: "y" }, timeoutMs: 5000 });
    expect(ok).toMatchObject({ exitCode: 0, stdout: "ran:echo hi", timedOut: false });
    expect(calls.at(-1)?.args[1]).toMatchObject({ cwd: "/workspace/src", envs: { X: "y" }, timeoutMs: 5000 });
    expect(await sb.exec("fail")).toMatchObject({ exitCode: 7, stdout: "o", stderr: "e" });
    expect(await sb.exec("slow")).toMatchObject({ timedOut: true, exitCode: 124 });

    await sb.writeFile("a.txt", "A");
    expect(files.has("/workspace/a.txt")).toBe(true);
    expect(await sb.readFile("/workspace/a.txt")).toBe("A");
    await expect(sb.readFile("nope")).rejects.toThrow(/cannot read/);
    expect(await sb.listFiles(".", { recursive: true })).toEqual(["a.txt", "d/b.txt"]);
    expect(await sb.exposePort(3000)).toEqual({ url: "https://3000-sbx_123.e2b.app" });

    await sb.pause();
    await sb.resume();
    expect(calls.some((c) => c.fn === "connect" && c.args[0] === "sbx_123")).toBe(true);
    await sb.destroy();
    expect(calls.some((c) => c.fn === "kill")).toBe(true);
    expect(usage.records.filter((r) => r.provider === "e2b" && r.kind === "sandbox_minutes")).toHaveLength(2);
  });

  it("snapshot/restore via tarball through the files API", async () => {
    const p = new E2BSandboxProvider({ apiKey: "k", snapshotStore: new SnapshotStore(new LocalObjectStore(mkdtempSync(join(tmpdir(), "e2b-")))) });
    const sb = await p.create({ projectId: "proj-e2b" });
    const { snapshotId } = await sb.snapshot("l");
    expect(await p.snapshots.meta("proj-e2b", snapshotId)).toMatchObject({ label: "l", provider: "e2b", sizeBytes: 3 });
    await sb.restore(snapshotId);
    expect(calls.some((c) => c.fn === "write" && String(c.args[0]).startsWith("/tmp/restore-"))).toBe(true);
    expect(calls.some((c) => c.fn === "run" && String(c.args[0]).includes("tar -C '/workspace' -xzf"))).toBe(true);
  });

  it("get() returns null for unknown sandboxes and requires an API key", async () => {
    const p = new E2BSandboxProvider({ apiKey: "k", snapshotStore: new SnapshotStore(new LocalObjectStore(mkdtempSync(join(tmpdir(), "e2b-")))) });
    expect(await p.get("gone")).toBeNull();
    expect((await p.get("sbx_9"))?.projectId).toBe("proj-e2b");
    const saved = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    await expect(new E2BSandboxProvider().create({ projectId: "x" })).rejects.toThrow(/E2B_API_KEY/);
    if (saved !== undefined) process.env.E2B_API_KEY = saved;
  });
});
