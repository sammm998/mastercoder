import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { LocalObjectStore, MemoryUsageSink } from "@forge/shared";
import { DockerSandboxProvider } from "../src/adapters/docker/provider.js";
import { SnapshotStore } from "../src/snapshots.js";

export const TEST_PREFIX = "forgetest";

export function testDockerProvider(extra: { exposeMode?: "ip" | "publish" } = {}): { provider: DockerSandboxProvider; usage: MemoryUsageSink } {
  const usage = new MemoryUsageSink();
  const provider = new DockerSandboxProvider({
    prefix: TEST_PREFIX,
    image: "node:22-bookworm-slim",
    snapshotStore: new SnapshotStore(new LocalObjectStore(mkdtempSync(join(tmpdir(), "forge-snap-")))),
    usage,
    defaultCpu: 1,
    defaultMemoryMb: 512,
    ...extra,
  });
  return { provider, usage };
}

/** GET from the host without any proxy (http.get never reads HTTP(S)_PROXY). */
export function hostGet(url: string, timeoutMs = 3000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

export async function waitForHttp(url: string, timeoutMs = 20000): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await hostGet(url, 2000);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`no HTTP response from ${url}: ${String(last)}`);
}

/** Network probe run INSIDE a sandbox with node. Prints one JSON line. */
export const PROBE_SCRIPT = String.raw`
import net from "node:net";
import tls from "node:tls";
const [mode, a, b] = process.argv.slice(2);
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
setTimeout(() => out({ ok: false, error: "probe-timeout" }), 8000);
const proxy = new URL(process.env.HTTPS_PROXY || "http://none:1");
if (mode === "tcp") {
  const s = net.connect({ host: a, port: Number(b) });
  s.setTimeout(4000, () => { s.destroy(); out({ ok: false, error: "timeout" }); });
  s.on("connect", () => { s.destroy(); out({ ok: true }); });
  s.on("error", (e) => out({ ok: false, error: e.code || e.message }));
} else if (mode === "connect" || mode === "https") {
  const s = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
  s.on("error", (e) => out({ ok: false, error: e.code || e.message }));
  s.on("connect", () => s.write("CONNECT " + a + ":" + b + " HTTP/1.1\r\nHost: " + a + ":" + b + "\r\n\r\n"));
  let buf = "";
  const onData = (d) => {
    buf += d.toString("latin1");
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    s.off("data", onData);
    const status = Number(buf.split(" ")[1]);
    const reason = (/x-forge-egress-reason: (\S+)/i.exec(buf) || [])[1];
    if (mode === "connect" || status !== 200) return out({ ok: status === 200, status, reason });
    const t = tls.connect({ socket: s, servername: a });
    t.on("error", (e) => out({ ok: false, status, error: "tls:" + (e.code || e.message) }));
    t.on("secureConnect", () => t.write("GET / HTTP/1.1\r\nHost: " + a + "\r\nConnection: close\r\nUser-Agent: forge-probe\r\n\r\n"));
    let resp = "";
    t.on("data", (d) => { resp += d.toString("latin1"); if (resp.includes("\r\n")) out({ ok: true, status, httpStatus: Number(resp.split(" ")[1]) }); });
  };
  s.on("data", onData);
} else if (mode === "dns") {
  const dns = await import("node:dns");
  dns.promises.lookup(a).then((r) => out({ ok: true, address: r.address })).catch((e) => out({ ok: false, error: e.code || e.message }));
} else if (mode === "http") {
  const s = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
  s.on("error", (e) => out({ ok: false, error: e.code || e.message }));
  const u = new URL(a);
  s.on("connect", () => s.write("GET " + a + " HTTP/1.1\r\nHost: " + u.host + "\r\nConnection: close\r\n\r\n"));
  let buf = "";
  s.on("data", (d) => { buf += d.toString("latin1"); if (buf.includes("\r\n\r\n")) { const status = Number(buf.split(" ")[1]); const reason = (/x-forge-egress-reason: (\S+)/i.exec(buf) || [])[1]; out({ ok: status === 200, status, reason }); } });
}
`;

export interface ProbeResult {
  ok: boolean;
  status?: number;
  httpStatus?: number;
  reason?: string;
  error?: string;
}
