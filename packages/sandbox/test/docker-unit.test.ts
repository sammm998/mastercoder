import { describe, expect, it } from "vitest";
import { DockerSandboxProvider } from "../src/adapters/docker/provider.js";
import { parseUpstream } from "../src/adapters/docker/egress.js";
import { safeName } from "../src/adapters/docker/cli.js";
import { buildTar } from "../src/tar.js";
import { listFilesCommand, parseListOutput, resolveSandboxPath, shq, withTimeout } from "../src/shell.js";
import { SandboxMeter, sandboxCostUsd, RATES } from "../src/metering.js";
import { MemoryUsageSink } from "@forge/shared";

describe("docker create args (no docker needed)", () => {
  const p = new DockerSandboxProvider({ prefix: "unit", egress: { upstreamProxy: null, allowlist: [] } });

  it("hardens the container", () => {
    const args = p.buildCreateArgs({ projectId: "My Project!", cpu: 1.5, memoryMb: 768, env: { FOO: "bar" } }, "unit-net-x");
    const joined = args.join(" ");
    expect(args[0]).toBe("create");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--user 1000:1000");
    expect(joined).toContain("--cpus 1.5");
    expect(joined).toContain("--memory 768m");
    expect(joined).toContain("--memory-swap 768m");
    expect(joined).toContain("--pids-limit 512");
    expect(joined).toContain("--tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777");
    expect(joined).toContain("--workdir /workspace");
    expect(joined).toContain("--network unit-net-x");
    expect(joined).toContain("--label forge.project=My Project!");
    expect(joined).toContain("-e HTTPS_PROXY=http://forge-egress:3128");
    expect(joined).toContain("-e FOO=bar");
    expect(joined).not.toContain("--privileged");
    expect(args.slice(-3)).toEqual(["tail", "-f", "/dev/null"]);
    expect(p.containerName("My Project!")).toMatch(/^unit-sbx-my-project-[a-z0-9]+$/);
  });

  it("uses the lifetime as the main process when timeoutSec is set", () => {
    const args = p.buildCreateArgs({ projectId: "p", timeoutSec: 90 }, "n");
    expect(args.slice(-2)).toEqual(["sleep", "90"]);
  });

  it("refuses root users", () => {
    expect(() => new DockerSandboxProvider({ user: "0:0" })).toThrow(/root/);
    expect(() => new DockerSandboxProvider({ user: "root" })).toThrow(/root/);
  });

  it("parses upstream proxies (loopback detection, basic auth)", () => {
    expect(parseUpstream("http://127.0.0.1:35535")).toEqual({ host: "127.0.0.1", port: 35535, authorization: undefined, loopback: true });
    const u = parseUpstream("http://user:p%40ss@10.0.0.5:8080")!;
    expect(u.loopback).toBe(false);
    expect(Buffer.from(u.authorization!.slice(6), "base64").toString()).toBe("user:p@ss");
    expect(parseUpstream(null)).toBeNull();
    expect(() => parseUpstream("socks5://x:1")).toThrow();
  });
});

describe("helpers", () => {
  it("quotes for sh and resolves paths", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(resolveSandboxPath(undefined)).toBe("/workspace");
    expect(resolveSandboxPath("a/../b")).toBe("/workspace/b");
    expect(resolveSandboxPath("/etc/x")).toBe("/etc/x");
    expect(withTimeout("ls", 1500)).toEqual(["timeout", "-s", "KILL", "2", "sh", "-c", "ls"]);
  });

  it("builds list commands and parses output", () => {
    expect(listFilesCommand("/workspace", { recursive: true, exclude: ["node_modules", "bad name;rm"] })).toBe(
      "find '/workspace' \\( -type d \\( -name 'node_modules' \\) \\) -prune -o -type f -print",
    );
    expect(parseListOutput("/workspace", "/workspace/b\n/workspace/a/c\n", { recursive: true })).toEqual(["a/c", "b"]);
    expect(parseListOutput("/workspace", "src/\nx\n")).toEqual(["src/", "x"]);
  });

  it("safeName is docker-safe and collision resistant", () => {
    expect(safeName("abc")).toBe("abc");
    expect(safeName("A B")).not.toBe(safeName("a-b"));
    expect(safeName("A B")).toMatch(/^[a-z0-9_.-]+$/);
  });

  it("writes valid ustar archives", () => {
    const tar = buildTar([
      { name: "workspace", type: "dir", uid: 1000, gid: 1000 },
      { name: "workspace/x.txt", type: "file", content: "hello" },
    ]);
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(0, 10).toString()).toBe("workspace/");
    expect(tar.subarray(257, 262).toString()).toBe("ustar");
    expect(tar.subarray(1024, 1029).toString()).toBe("hello");
  });

  it("meters sandbox minutes with provider rates", async () => {
    const sink = new MemoryUsageSink();
    const m = new SandboxMeter(sink, { provider: "e2b", projectId: "p", cpu: 2, memoryMb: 1024, rates: RATES.e2b }, 0);
    await m.stop(60000);
    await m.stop(120000); // no open window: nothing recorded
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ kind: "sandbox_minutes", quantity: 1, provider: "e2b", projectId: "p" });
    expect(sink.records[0]?.costUsd).toBeCloseTo(sandboxCostUsd(60, 2, 1024, RATES.e2b), 8);
    expect(sandboxCostUsd(3600, 1, 1024, RATES.e2b)).toBeCloseTo(0.0504 + 0.0162, 6);
  });
});
