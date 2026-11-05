/**
 * Sandbox escape tests (real docker). Project A must not reach project B, cloud metadata, host services or
 * non-allowlisted internet hosts — directly or via the egress proxy — but CAN reach allowlisted hosts via the proxy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerRaw, inspectOrNull, type ContainerInspect, type NetworkInspect } from "../src/adapters/docker/cli.js";
import type { DockerSandbox } from "../src/adapters/docker/provider.js";
import { PROBE_SCRIPT, testDockerProvider, type ProbeResult } from "./helpers.js";

const { provider } = testDockerProvider();
const run = Date.now().toString(36);
let a: DockerSandbox;
let b: DockerSandbox;
let bIp = "";
let aGateway = "";
let proxyIpOnB = "";
let dockerHostIp = "";

async function probe(sb: DockerSandbox, ...args: string[]): Promise<ProbeResult> {
  const r = await sb.exec(`node /workspace/probe.mjs ${args.map((x) => `'${x}'`).join(" ")}`, { timeoutMs: 20000 });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as ProbeResult;
  } catch {
    throw new Error(`probe output not JSON: ${r.stdout} ${r.stderr}`);
  }
}

beforeAll(async () => {
  a = (await provider.create({ projectId: `esc-a-${run}` })) as DockerSandbox;
  b = (await provider.create({ projectId: `esc-b-${run}`, egressAllowlist: ["example.com"] })) as DockerSandbox;
  for (const sb of [a, b]) await sb.writeFile("probe.mjs", PROBE_SCRIPT);
  await b.writeFile("server.js", `require("http").createServer((q, s) => s.end("secret-of-b")).listen(8080, "0.0.0.0");`);
  await b.exec("nohup node server.js > /tmp/s.log 2>&1 &");
  bIp = new URL((await b.exposePort(8080)).url).hostname;
  const netA = (await inspectOrNull<NetworkInspect>("network", a.network))!;
  aGateway = netA.IPAM.Config?.[0]?.Gateway ?? "";
  const proxy = (await inspectOrNull<ContainerInspect>("container", provider.egress.proxyName))!;
  proxyIpOnB = proxy.NetworkSettings.Networks[b.network]?.IPAddress ?? "";
  const bridge = (await inspectOrNull<NetworkInspect>("network", "bridge"))!;
  dockerHostIp = bridge.IPAM.Config?.[0]?.Gateway ?? "172.17.0.1";
  // B's server is up (B can reach itself)
  for (let i = 0; i < 40; i++) {
    if ((await probe(b, "tcp", "127.0.0.1", "8080")).ok) break;
    await new Promise((r) => setTimeout(r, 250));
  }
});

afterAll(async () => {
  await a?.destroy();
  await b?.destroy();
});

describe("sandbox escape tests", () => {
  it("sanity: B serves on 8080 and the host can reach it via exposePort", async () => {
    expect(bIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect((await probe(b, "tcp", "127.0.0.1", "8080")).ok).toBe(true);
  });

  it("A cannot reach project B's container by IP and port", async () => {
    const direct = await probe(a, "tcp", bIp, "8080");
    expect(direct.ok).toBe(false);
    const viaProxy = await probe(a, "http", `http://${bIp}:8080/`);
    expect(viaProxy.status).toBe(403);
    expect(viaProxy.reason).toBe("blocked-ip:private");
    const viaConnect = await probe(a, "connect", bIp, "8080");
    expect(viaConnect.status).toBe(403);
  });

  it("A cannot use the proxy's address on B's network (no cross-network route)", async () => {
    expect(proxyIpOnB).not.toBe("");
    expect((await probe(a, "tcp", proxyIpOnB, "3128")).ok).toBe(false);
  });

  it("A cannot reach cloud metadata (169.254.169.254) directly or via the proxy", async () => {
    expect((await probe(a, "tcp", "169.254.169.254", "80")).ok).toBe(false);
    const viaProxy = await probe(a, "http", "http://169.254.169.254/latest/meta-data/");
    expect(viaProxy.status).toBe(403);
    expect(viaProxy.reason).toBe("blocked-ip:link-local/metadata");
    const byName = await probe(a, "http", "http://metadata.google.internal/computeMetadata/v1/");
    expect(byName.status).toBe(403);
    expect(byName.reason).toBe("blocked-hostname");
  });

  it("A cannot reach host services (Postgres :5432, Redis :6379) via any gateway or the proxy", async () => {
    for (const host of [aGateway, dockerHostIp, "172.17.0.1"]) {
      for (const port of ["5432", "6379"]) {
        const r = await probe(a, "tcp", host, port);
        expect(r.ok, `${host}:${port} reachable`).toBe(false);
      }
    }
    for (const target of [`${dockerHostIp}:5432`, "host.docker.internal:6379", "127.0.0.1:5432", "localhost:6379"]) {
      const [h, p] = target.split(":") as [string, string];
      const r = await probe(a, "connect", h, p);
      expect(r.status, target).toBe(403);
    }
  });

  it("A has no direct internet route (bypassing the proxy fails)", async () => {
    expect((await probe(a, "tcp", "1.1.1.1", "443")).ok).toBe(false);
    expect((await probe(a, "tcp", "104.16.0.34", "443")).ok).toBe(false);
  });

  it("A cannot reach a non-allowlisted internet host via the proxy (even one B may reach)", async () => {
    const r = await probe(a, "connect", "example.org", "443");
    expect(r.status).toBe(403);
    expect(r.reason).toBe("not-allowlisted");
    const bOnly = await probe(a, "connect", "example.com", "443");
    expect(bOnly.status).toBe(403);
    expect(bOnly.reason).toBe("not-allowlisted");
    const badPort = await probe(a, "connect", "registry.npmjs.org", "22");
    expect(badPort.status).toBe(403);
  });

  it("A CAN reach an allowlisted host (registry.npmjs.org) through the proxy", async () => {
    const r = await probe(a, "https", "registry.npmjs.org", "443");
    // The proxy must permit it (200 Connection Established). If an outer environment blocks the host, the
    // proxy answers 502 connect-failed instead of 403 — still proving our policy allowed it.
    expect(r.status === 200 || r.status === 502).toBe(true);
    expect(r.status).not.toBe(403);
    if (r.status === 200) expect(r.httpStatus).toBeGreaterThanOrEqual(200);
    const logs = await dockerRaw(["logs", "--tail", "200", provider.egress.proxyName]);
    const lines = logs.stdout.toString().split("\n").filter((l) => l.includes('"registry.npmjs.org"') && l.includes(`esc-a-${run}`));
    expect(lines.some((l) => l.includes('"allowed":true'))).toBe(true);
  });

  it("per-project allowlists: B's extra host (example.com) is permitted by the proxy for B only", async () => {
    const r = await probe(b, "connect", "example.com", "443");
    // B passes the allowlist stage. The outcome after that depends on the outer environment: 200 (tunnel up),
    // 502 (outer proxy refused) or 403 dns-* (outer DNS refuses to resolve the name) — never not-allowlisted.
    expect(r.reason).not.toBe("not-allowlisted");
    expect(r.status === 200 || r.status === 502 || /^dns-/.test(r.reason ?? "")).toBe(true);
  });

  it("npm itself works through the proxy for allowlisted registries", async () => {
    const r = await a.exec("npm ping --registry https://registry.npmjs.org/ 2>&1", { timeoutMs: 60000 });
    expect(r.exitCode, r.stdout).toBe(0);
  });
});
