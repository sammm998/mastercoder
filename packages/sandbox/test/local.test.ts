import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalObjectStore, MemoryUsageSink } from "@forge/shared";
import { LocalSandboxProvider, MockSandboxProvider } from "../src/adapters/local.js";
import { SnapshotStore } from "../src/snapshots.js";
import { copyDirToSandbox } from "../src/copy.js";

const store = () => new SnapshotStore(new LocalObjectStore(mkdtempSync(join(tmpdir(), "forge-lsnap-"))));

describe("LocalSandboxProvider (tests only, no isolation)", () => {
  it("is labelled as mock / no isolation", () => {
    const p = new LocalSandboxProvider({ snapshotStore: store() });
    expect(p.name).toBe("local");
    expect(p.isMock).toBe(true);
    expect(new MockSandboxProvider({ snapshotStore: store() }).name).toBe("mock");
  });

  it("exec / files / list / snapshot / restore / destroy", async () => {
    const usage = new MemoryUsageSink();
    const p = new LocalSandboxProvider({ snapshotStore: store(), usage });
    const sb = await p.create({ projectId: "proj-1", env: { HELLO: "world" } });
    expect(sb.workdir).toBe("/workspace");
    expect(await p.get(sb.id)).toBe(sb);

    const r = await sb.exec("echo $HELLO; echo e >&2; exit 2");
    expect(r).toMatchObject({ exitCode: 2, stdout: "world\n", stderr: "e\n", timedOut: false });

    await sb.writeFile("/workspace/a/b.txt", "B");
    await sb.writeFile("c.bin", new Uint8Array([9, 8]));
    expect(await sb.readFile("a/b.txt")).toBe("B");
    expect(Array.from(await sb.readFileBytes("/workspace/c.bin"))).toEqual([9, 8]);
    expect(await sb.listFiles()).toEqual(["a/", "c.bin"]);
    expect(await sb.listFiles("/workspace", { recursive: true })).toEqual(["a/b.txt", "c.bin"]);
    expect((await sb.exec("cat b.txt", { cwd: "a" })).stdout).toBe("B");
    await expect(sb.readFile("/etc/passwd")).rejects.toThrow(/only exposes/);
    await expect(sb.writeFile("../escape.txt", "x")).rejects.toThrow();

    const { snapshotId } = await sb.snapshot("s1");
    await sb.writeFile("a/b.txt", "changed");
    await sb.writeFile("new.txt", "n");
    await sb.restore(snapshotId);
    expect(await sb.readFile("a/b.txt")).toBe("B");
    expect(await sb.listFiles()).toEqual(["a/", "c.bin"]);

    const t = await sb.exec("sleep 5", { timeoutMs: 300 });
    expect(t.timedOut).toBe(true);

    await sb.pause();
    await expect(sb.exec("true")).rejects.toThrow(/paused/);
    await sb.resume();
    await sb.destroy();
    expect(await p.get(sb.id)).toBeNull();
    expect(usage.records.filter((u) => u.kind === "sandbox_minutes" && u.provider === "local")).toHaveLength(2);
    expect(usage.records.every((u) => u.costUsd === 0)).toBe(true);
  });

  it("exposePort serves from loopback", async () => {
    const p = new LocalSandboxProvider({ snapshotStore: store() });
    const sb = await p.create({ projectId: "proj-2" });
    const server = http.createServer((_q, s) => s.end("ok")).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    const { url } = await sb.exposePort(port);
    expect(url).toBe(`http://127.0.0.1:${port}`);
    server.close();
    await sb.destroy();
  });

  it("copyDirToSandbox copies a host tree, skipping node_modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-copy-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules/x"), { recursive: true });
    writeFileSync(join(dir, "src/i.ts"), "export {}");
    writeFileSync(join(dir, "node_modules/x/i.js"), "");
    writeFileSync(join(dir, "package.json"), "{}");
    const sb = await new LocalSandboxProvider({ snapshotStore: store() }).create({ projectId: "p3" });
    expect(await copyDirToSandbox(sb, dir)).toEqual(["package.json", "src/i.ts"]);
    expect(await sb.readFile("src/i.ts")).toBe("export {}");
    await sb.destroy();
  });

  it("validates the spec with zod", async () => {
    const p = new LocalSandboxProvider({ snapshotStore: store() });
    await expect(p.create({ projectId: "" })).rejects.toThrow();
    await expect(p.create({ projectId: "x", egressAllowlist: ["http://bad"] })).rejects.toThrow();
  });
});
