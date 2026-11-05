import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerJson, inspectOrNull, type ContainerInspect, type NetworkInspect } from "../src/adapters/docker/cli.js";
import type { DockerSandbox } from "../src/adapters/docker/provider.js";
import { testDockerProvider, waitForHttp } from "./helpers.js";

const { provider, usage } = testDockerProvider();
let sb: DockerSandbox;
const projectId = `it-basic-${Date.now().toString(36)}`;

beforeAll(async () => {
  sb = (await provider.create({ projectId, cpu: 1, memoryMb: 384, env: { FORGE_TEST: "yes" } })) as DockerSandbox;
});

afterAll(async () => {
  await sb?.destroy();
});

const SERVER = `require("http").createServer((q, s) => { s.setHeader("content-type", "text/plain"); s.end("hello from sandbox " + q.url); }).listen(8080, "0.0.0.0");`;

describe("DockerSandboxProvider (real docker)", () => {
  it("exec / read / write / list", async () => {
    expect(sb.workdir).toBe("/workspace");
    const r = await sb.exec("echo out; echo err >&2; pwd; id -u; echo $FORGE_TEST; exit 3");
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe("out\n/workspace\n1000\nyes\n");
    expect(r.stderr).toBe("err\n");
    expect(r.timedOut).toBe(false);

    await sb.writeFile("src/a.txt", "alpha");
    await sb.writeFile("/workspace/src/nested/b.bin", new Uint8Array([0, 1, 2, 255]));
    await sb.writeFile("top.md", "# top");
    expect(await sb.readFile("src/a.txt")).toBe("alpha");
    expect(Array.from(await sb.readFileBytes("src/nested/b.bin"))).toEqual([0, 1, 2, 255]);
    expect(await sb.listFiles()).toEqual(["src/", "top.md"]);
    expect(await sb.listFiles(".", { recursive: true })).toEqual(["src/a.txt", "src/nested/b.bin", "top.md"]);
    expect(await sb.listFiles("src", { recursive: true, exclude: ["nested"] })).toEqual(["a.txt"]);
    const cwd = await sb.exec("pwd && cat a.txt", { cwd: "src", env: { X: "1" } });
    expect(cwd.stdout).toBe("/workspace/src\nalpha");
    await expect(sb.readFile("missing.txt")).rejects.toThrow(/cannot read/);
  });

  it("enforces exec timeouts inside the sandbox", async () => {
    const r = await sb.exec("sleep 30", { timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(10000);
  });

  it("snapshot -> modify -> restore", async () => {
    await sb.writeFile("state.txt", "v1");
    const { snapshotId } = await sb.snapshot("before");
    expect(snapshotId).toMatch(/^snap_/);
    await sb.writeFile("state.txt", "v2");
    await sb.writeFile("extra.txt", "should vanish");
    await sb.exec("rm -rf src");
    await sb.restore(snapshotId);
    expect(await sb.readFile("state.txt")).toBe("v1");
    expect(await sb.readFile("src/a.txt")).toBe("alpha");
    expect((await sb.listFiles()).includes("extra.txt")).toBe(false);
    const meta = await provider.snapshots.meta(projectId, snapshotId);
    expect(meta?.label).toBe("before");
  });

  it("exposePort returns a host-reachable URL serving real HTTP", async () => {
    await sb.writeFile("server.js", SERVER);
    await sb.exec("nohup node server.js > /tmp/server.log 2>&1 &");
    const { url } = await sb.exposePort(8080);
    expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:8080$/);
    const res = await waitForHttp(`${url}/ping`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from sandbox /ping");
  });

  it("exposePort in publish mode (loopback-published forwarder)", async () => {
    const { provider: p2 } = testDockerProvider({ exposeMode: "publish" });
    const same = (await p2.create({ projectId })) as DockerSandbox; // one container per project: reuses it
    expect(same.id).toBe(sb.id);
    const { url } = await same.exposePort(8080);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await waitForHttp(`${url}/pub`);
    expect(res.body).toBe("hello from sandbox /pub");
  });

  it("applies resource limits and hardening", async () => {
    const info = (await inspectOrNull<ContainerInspect>("container", sb.id))!;
    expect(info.HostConfig.NanoCpus).toBe(1e9);
    expect(info.HostConfig.Memory).toBe(384 * 1024 * 1024);
    expect(info.HostConfig.MemorySwap).toBe(384 * 1024 * 1024);
    expect(info.HostConfig.PidsLimit).toBe(512);
    expect(info.HostConfig.CapDrop).toContain("ALL");
    expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(Object.keys(info.HostConfig.Tmpfs ?? {})).toContain("/tmp");
    expect(info.Config.User).toBe("1000:1000");
    expect(info.Config.Labels?.["forge.project"]).toBe(projectId);
    const net = (await inspectOrNull<NetworkInspect>("network", sb.network))!;
    expect(net.Internal).toBe(true);
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([sb.network]);
    // inside: no capabilities, cannot write outside /workspace and /tmp
    const caps = await sb.exec("grep CapEff /proc/self/status");
    expect(caps.stdout).toMatch(/CapEff:\s+0+\n/);
    const ro = await sb.exec("touch /etc/forge-test");
    expect(ro.exitCode).not.toBe(0);
    const pids = await sb.exec("cat /sys/fs/cgroup/pids/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids.max");
    expect(pids.stdout.trim()).toBe("512");
  });

  it("pause / resume and get()", async () => {
    await sb.pause();
    const paused = await dockerJson<Array<{ State: { Paused: boolean } }>>(["container", "inspect", sb.id]);
    expect(paused[0]?.State.Paused).toBe(true);
    expect(usage.records.some((r) => r.kind === "sandbox_minutes" && r.provider === "docker")).toBe(true);
    await sb.resume();
    expect((await sb.exec("echo back")).stdout).toBe("back\n");
    const again = await provider.get(sb.id);
    expect(again?.projectId).toBe(projectId);
    expect(await provider.get("does-not-exist")).toBeNull();
  });

  it("destroy removes container and network, meters usage", async () => {
    const { provider: p, usage: u } = testDockerProvider();
    const tmp = (await p.create({ projectId: `${projectId}-tmp` })) as DockerSandbox;
    await tmp.exec("true");
    await tmp.destroy();
    expect(await inspectOrNull("container", tmp.id)).toBeNull();
    expect(await inspectOrNull("network", tmp.network)).toBeNull();
    const rec = u.records.find((r) => r.kind === "sandbox_minutes");
    expect(rec?.quantity).toBeGreaterThan(0);
    expect(rec?.costUsd).toBeGreaterThanOrEqual(0);
    expect(rec?.projectId).toBe(`${projectId}-tmp`);
  });
});
