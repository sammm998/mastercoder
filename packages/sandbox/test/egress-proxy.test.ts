import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEgressProxy, createTcpRelay, parseAuthority, parseEgressConfig, type EgressConfig, type EgressLogEntry } from "../src/egress-proxy.js";

// Loopback-only test harness: "public" names resolve to documentation-free public IPs, and the injected dialer
// sends every verified connection to a local origin server.
let origin: http.Server;
let originPort = 0;
let upstream: net.Server;
let upstreamPort = 0;
let upstreamAuth: string | undefined;
let lastOriginReq: { url?: string; headers: http.IncomingHttpHeaders } | null = null;
const logs: EgressLogEntry[] = [];

const listen = (s: net.Server): Promise<number> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as net.AddressInfo).port)));

function startProxy(config: EgressConfig, project: boolean = true): Promise<{ port: number; close: () => void }> {
  const server = createEgressProxy({
    getConfig: () => config,
    resolveProject: () => (project ? { projectId: "p1", allow: ["allowed.test", "rebind.test"] } : null),
    lookup: async (h) => (h === "rebind.test" ? [{ address: "10.0.0.7", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]),
    dial: () => net.connect(originPort, "127.0.0.1"),
    log: (e) => logs.push(e),
  });
  return listen(server).then((port) => ({ port, close: () => server.close() }));
}

function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(text));
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("latin1");
    });
    s.on("end", () => resolve(buf));
    s.on("error", reject);
    setTimeout(() => {
      s.destroy();
      resolve(buf);
    }, 1500);
  });
}

function connectThenGet(port: number, authority: string): Promise<{ connectStatus: string; body: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let buf = "";
    let stage = 0;
    let connectStatus = "";
    s.on("data", (d) => {
      buf += d.toString("latin1");
      if (stage === 0 && buf.includes("\r\n\r\n")) {
        connectStatus = buf.split("\r\n")[0] ?? "";
        stage = 1;
        buf = "";
        if (!connectStatus.includes("200")) {
          s.destroy();
          resolve({ connectStatus, body: "" });
          return;
        }
        s.write(`GET /tunnel HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n`);
      }
    });
    s.on("end", () => resolve({ connectStatus, body: buf }));
    s.on("error", reject);
  });
}

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    lastOriginReq = { url: req.url, headers: req.headers };
    res.end(`origin:${req.url}`);
  });
  originPort = await listen(origin);
  upstream = net.createServer((client) => {
    let buf = "";
    const onData = (d: Buffer): void => {
      buf += d.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      client.off("data", onData);
      upstreamAuth = /proxy-authorization: (.+)\r\n/i.exec(buf)?.[1];
      if (buf.startsWith("CONNECT blocked-upstream")) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const t = net.connect(originPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(t);
        t.pipe(client);
      });
    };
    client.on("data", onData);
  });
  upstreamPort = await listen(upstream);
});

afterAll(() => {
  origin.close();
  upstream.close();
});

describe("egress proxy", () => {
  const direct: EgressConfig = { version: "t1", listeners: {}, upstream: null };

  it("tunnels CONNECT for allowlisted hosts and logs the decision", async () => {
    const p = await startProxy(direct);
    const r = await connectThenGet(p.port, "allowed.test:443");
    p.close();
    expect(r.connectStatus).toContain("200");
    expect(r.body).toContain("origin:/tunnel");
    expect(logs.some((l) => l.host === "allowed.test" && l.allowed && l.via === "direct")).toBe(true);
  });

  it("denies non-allowlisted, rebinding, private and metadata targets with 403 + reason", async () => {
    const p = await startProxy(direct);
    const cases: Array<[string, string]> = [
      ["evil.test:443", "not-allowlisted"],
      ["rebind.test:443", "blocked-ip:private"],
      ["10.0.0.1:443", "blocked-ip:private"],
      ["169.254.169.254:80", "blocked-ip:link-local/metadata"],
      ["[::1]:443", "blocked-ip:loopback"],
      ["metadata.google.internal:80", "blocked-hostname"],
    ];
    for (const [target, reason] of cases) {
      const res = await rawRequest(p.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      expect(res, target).toMatch(/^HTTP\/1.1 403/);
      expect(res).toContain(`X-Forge-Egress-Reason: ${reason}`);
    }
    p.close();
  });

  it("denies connections from unknown networks", async () => {
    const p = await startProxy(direct, false);
    const res = await rawRequest(p.port, "CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n");
    p.close();
    expect(res).toContain("unknown-network");
  });

  it("forwards plain HTTP in origin-form and strips proxy headers", async () => {
    const p = await startProxy(direct);
    const res = await rawRequest(
      p.port,
      "GET http://allowed.test/path?q=1 HTTP/1.1\r\nHost: allowed.test\r\nProxy-Authorization: Basic c2VjcmV0\r\nConnection: close\r\n\r\n",
    );
    expect(res).toMatch(/^HTTP\/1.1 200/);
    expect(res).toContain("origin:/path?q=1");
    expect(lastOriginReq?.url).toBe("/path?q=1");
    expect(lastOriginReq?.headers["proxy-authorization"]).toBeUndefined();
    const denied = await rawRequest(p.port, "GET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\n\r\n");
    expect(denied).toMatch(/^HTTP\/1.1 403/);
    const https = await rawRequest(p.port, "GET https://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n");
    expect(https).toMatch(/^HTTP\/1.1 400/);
    const health = await rawRequest(p.port, "GET /__forge/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(health).toContain('"version":"t1"');
    p.close();
  });

  it("chains allowed traffic through an upstream proxy with Proxy-Authorization", async () => {
    const cfg: EgressConfig = { version: "t2", listeners: {}, upstream: { host: "127.0.0.1", port: upstreamPort, authorization: "Basic dXNlcjpwYXNz" } };
    const p = await startProxy(cfg);
    const r = await connectThenGet(p.port, "allowed.test:443");
    expect(r.connectStatus).toContain("200");
    expect(r.body).toContain("origin:/tunnel");
    expect(upstreamAuth).toBe("Basic dXNlcjpwYXNz");
    const plain = await rawRequest(p.port, "GET http://allowed.test/via-up HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n");
    expect(plain).toContain("origin:/via-up");
    expect(logs.some((l) => l.via === "upstream")).toBe(true);
    p.close();
  });
});

describe("tcp relay and config parsing", () => {
  it("relays TCP and enforces allowFrom", async () => {
    const relay = createTcpRelay({ targetHost: "127.0.0.1", targetPort: originPort, allowFrom: ["127.0.0.0", 8] });
    const port = await listen(relay);
    const res = await rawRequest(port, "GET /relayed HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(res).toContain("origin:/relayed");
    relay.close();
    const strict = createTcpRelay({ targetHost: "127.0.0.1", targetPort: originPort, allowFrom: ["10.0.0.0", 8] });
    const p2 = await listen(strict);
    expect(await rawRequest(p2, "GET / HTTP/1.1\r\n\r\n")).toBe("");
    strict.close();
  });

  it("parses authorities and validates config", () => {
    expect(parseAuthority("a.b:443")).toEqual({ host: "a.b", port: 443 });
    expect(parseAuthority("[::1]:80")).toEqual({ host: "::1", port: 80 });
    expect(parseAuthority("nope")).toBeNull();
    expect(parseAuthority("a:99999")).toBeNull();
    const cfg = parseEgressConfig({ version: "v", listeners: { "172.20.0.3": { projectId: "p", allow: ["x.com", 5] } }, upstream: { host: "172.20.0.1", port: 39129 } });
    expect(cfg.listeners["172.20.0.3"]?.allow).toEqual(["x.com"]);
    expect(() => parseEgressConfig({ version: "v", listeners: { "not-ip": { projectId: "p", allow: [] } } })).toThrow();
    expect(() => parseEgressConfig({ listeners: {} })).toThrow();
  });
});
