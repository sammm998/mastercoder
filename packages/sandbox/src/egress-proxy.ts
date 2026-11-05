/**
 * Forge egress proxy: HTTP CONNECT + plain-HTTP forward proxy that is the ONLY way out of a sandbox network.
 *
 * - Runs in its own container attached to every project's `--internal` network (alias `forge-egress`) plus a
 *   normal bridge. The project of a connection is identified by the proxy's own address on the network the
 *   connection arrived on (`socket.localAddress`), so project A can never use project B's allowlist.
 * - Enforces the per-project host allowlist, always denies private/loopback/link-local/metadata targets and
 *   resolves DNS itself, checking every resolved address and dialing only verified addresses (no DNS rebinding).
 * - Optionally chains to an upstream HTTP proxy (CONNECT only) for allowed hosts.
 * - `relay` mode is a plain TCP forwarder used to reach an upstream proxy bound to the docker host's loopback.
 *
 * Self-contained (node: imports + ./egress-policy.js, erasable TypeScript only) because the Docker provider
 * type-strips this file and runs it inside the proxy container without node_modules.
 */
import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decide, type LookupFn, type Decision } from "./egress-policy.js";

export interface EgressProject {
  projectId: string;
  allow: string[];
}

export interface UpstreamProxy {
  host: string;
  port: number;
  /** Value for Proxy-Authorization (e.g. "Basic ..."). Never logged. */
  authorization?: string;
}

export interface EgressConfig {
  version: string;
  /** Keyed by the proxy's own IP address on the project's network. */
  listeners: Record<string, EgressProject>;
  upstream?: UpstreamProxy | null;
}

export interface EgressLogEntry {
  t: string;
  project: string | null;
  method: string;
  host: string;
  port: number;
  allowed: boolean;
  reason: string;
  via?: "direct" | "upstream";
}

export interface EgressProxyOptions {
  getConfig: () => EgressConfig;
  /** DNS resolution (default: dns.promises.lookup all=true). */
  lookup?: LookupFn;
  /** Dial a verified address (default: net.connect). */
  dial?: (address: string, port: number) => net.Socket;
  /** Map an incoming socket to its project (default: config.listeners[socket.localAddress]). */
  resolveProject?: (socket: net.Socket, config: EgressConfig) => EgressProject | null;
  log?: (entry: EgressLogEntry) => void;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function stripMappedPrefix(addr: string | undefined): string {
  if (!addr) return "";
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

export const defaultLookup: LookupFn = async (host) => {
  const res = await dns.promises.lookup(host, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family }));
};

function defaultResolveProject(socket: net.Socket, config: EgressConfig): EgressProject | null {
  const local = stripMappedPrefix(socket.localAddress);
  return config.listeners[local] ?? null;
}

/** Parse "host:port" / "[v6]:port" CONNECT authority. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(authority) ?? /^([^:[\]]+):(\d{1,5})$/.exec(authority);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

function denyRaw(socket: net.Socket, reason: string, status = 403): void {
  const body = `forge-egress denied: ${reason}\n`;
  const text = status === 403 ? "Forbidden" : status === 400 ? "Bad Request" : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nX-Forge-Egress: denied\r\nX-Forge-Egress-Reason: ${reason}\r\n` +
      `Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

/** Open a CONNECT tunnel through an upstream proxy. Resolves with the raw socket once the upstream says 200. */
export function connectViaUpstream(upstream: UpstreamProxy, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(upstream.port, upstream.host);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("upstream-timeout"));
    }, timeoutMs);
    const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
    sock.once("connect", () => {
      let req = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
      if (upstream.authorization) req += `Proxy-Authorization: ${upstream.authorization}\r\n`;
      sock.write(req + "\r\n");
    });
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buf.length > 16384) {
          sock.destroy();
          clearTimeout(timer);
          reject(new Error("upstream-bad-response"));
        }
        return;
      }
      sock.off("data", onData);
      clearTimeout(timer);
      const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
      const status = Number(statusLine.split(" ")[1]);
      if (status !== 200) {
        sock.destroy();
        reject(new Error(`upstream-status-${status || "invalid"}`));
        return;
      }
      const rest = buf.subarray(end + 4);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    sock.on("data", onData);
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function dialDirect(
  dial: (address: string, port: number) => net.Socket,
  addresses: string[],
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = (lastErr?: Error): void => {
      const address = addresses[i++];
      if (address === undefined) {
        reject(lastErr ?? new Error("no-address"));
        return;
      }
      const s = dial(address, port);
      const timer = setTimeout(() => {
        s.destroy();
        next(new Error("connect-timeout"));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        next(e);
      });
    };
    next();
  });
}

/** Create the proxy server (not yet listening). */
export function createEgressProxy(opts: EgressProxyOptions): http.Server {
  const lookup = opts.lookup ?? defaultLookup;
  const dial = opts.dial ?? ((address: string, port: number) => net.connect({ host: address, port }));
  const resolveProject = opts.resolveProject ?? defaultResolveProject;
  const log = opts.log ?? ((e: EgressLogEntry) => process.stdout.write(JSON.stringify(e) + "\n"));
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 300000;

  const open = async (host: string, port: number, decision: Decision): Promise<{ sock: net.Socket; via: "direct" | "upstream" }> => {
    const upstream = opts.getConfig().upstream;
    if (upstream) return { sock: await connectViaUpstream(upstream, host, port, connectTimeoutMs), via: "upstream" };
    return { sock: await dialDirect(dial, decision.addresses, port, connectTimeoutMs), via: "direct" };
  };

  const authorize = async (socket: net.Socket, method: string, host: string, port: number): Promise<{ decision: Decision; project: EgressProject | null }> => {
    const config = opts.getConfig();
    const project = resolveProject(socket, config);
    if (!project) {
      const decision: Decision = { allowed: false, reason: "unknown-network", addresses: [] };
      log({ t: new Date().toISOString(), project: null, method, host, port, allowed: false, reason: decision.reason });
      return { decision, project };
    }
    const decision = await decide(host, port, project.allow, lookup);
    if (!decision.allowed) log({ t: new Date().toISOString(), project: project.projectId, method, host, port, allowed: false, reason: decision.reason });
    return { decision, project };
  };

  const server = http.createServer((req, res) => {
    // One request per client connection: keeps forwarding simple and avoids cross-request socket reuse.
    res.setHeader("connection", "close");
    const url = req.url ?? "";
    if (url === "/__forge/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: opts.getConfig().version }));
      return;
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      res.writeHead(400, { "x-forge-egress": "denied", "x-forge-egress-reason": "not-a-proxy-request" });
      res.end("forge-egress: absolute-form http:// URL required (use CONNECT for https)\n");
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(400, { "x-forge-egress": "denied", "x-forge-egress-reason": "unsupported-scheme" });
      res.end("forge-egress: only http:// is forwarded; use CONNECT for https\n");
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const port = target.port ? Number(target.port) : 80;
    void (async () => {
      const { decision, project } = await authorize(req.socket, req.method ?? "GET", host, port);
      if (!decision.allowed) {
        res.writeHead(403, { "x-forge-egress": "denied", "x-forge-egress-reason": decision.reason, "content-type": "text/plain" });
        res.end(`forge-egress denied: ${decision.reason}\n`);
        return;
      }
      let opened: { sock: net.Socket; via: "direct" | "upstream" };
      try {
        opened = await open(host, port, decision);
      } catch (e) {
        log({ t: new Date().toISOString(), project: project?.projectId ?? null, method: req.method ?? "GET", host, port, allowed: true, reason: `connect-failed:${(e as Error).message}` });
        res.writeHead(502, { "x-forge-egress": "error", "content-type": "text/plain" });
        res.end(`forge-egress: upstream connect failed\n`);
        return;
      }
      log({ t: new Date().toISOString(), project: project?.projectId ?? null, method: req.method ?? "GET", host, port, allowed: true, reason: decision.reason, via: opened.via });
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
        headers[k] = v;
      }
      headers["connection"] = "close";
      const upstreamReq = http.request({
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        // No `agent`: with createConnection and no agent, node uses our already-verified socket.
        createConnection: () => opened.sock,
      });
      upstreamReq.on("response", (ures) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(ures.headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
        res.writeHead(ures.statusCode ?? 502, out);
        ures.pipe(res);
      });
      upstreamReq.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "x-forge-egress": "error" });
        res.end();
      });
      req.pipe(upstreamReq);
    })();
  });

  server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    clientSocket.on("error", () => clientSocket.destroy());
    const parsed = parseAuthority(req.url ?? "");
    if (!parsed) {
      denyRaw(clientSocket, "bad-target", 400);
      return;
    }
    void (async () => {
      const { decision, project } = await authorize(clientSocket, "CONNECT", parsed.host, parsed.port);
      if (!decision.allowed) {
        denyRaw(clientSocket, decision.reason);
        return;
      }
      let opened: { sock: net.Socket; via: "direct" | "upstream" };
      try {
        opened = await open(parsed.host, parsed.port, decision);
      } catch (e) {
        log({ t: new Date().toISOString(), project: project?.projectId ?? null, method: "CONNECT", host: parsed.host, port: parsed.port, allowed: true, reason: `connect-failed:${(e as Error).message}` });
        denyRaw(clientSocket, "connect-failed", 502);
        return;
      }
      log({ t: new Date().toISOString(), project: project?.projectId ?? null, method: "CONNECT", host: parsed.host, port: parsed.port, allowed: true, reason: decision.reason, via: opened.via });
      const up = opened.sock;
      up.setTimeout(idleTimeoutMs, () => up.destroy());
      clientSocket.setTimeout(idleTimeoutMs, () => clientSocket.destroy());
      up.on("error", () => clientSocket.destroy());
      clientSocket.on("close", () => up.destroy());
      up.on("close", () => clientSocket.destroy());
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: forge-egress\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    })();
  });

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

export interface TcpRelayOptions {
  targetHost: string;
  targetPort: number;
  /** Only accept clients from this subnet, e.g. ["172.20.0.0", 16]. */
  allowFrom?: [string, number];
}

/** Plain TCP forwarder (relay to a loopback-bound upstream proxy, or published-port forwarder). */
export function createTcpRelay(opts: TcpRelayOptions): net.Server {
  let allow: net.BlockList | null = null;
  if (opts.allowFrom) {
    allow = new net.BlockList();
    allow.addSubnet(opts.allowFrom[0], opts.allowFrom[1], net.isIP(opts.allowFrom[0]) === 6 ? "ipv6" : "ipv4");
  }
  return net.createServer((client) => {
    const remote = stripMappedPrefix(client.remoteAddress);
    if (allow && !allow.check(remote, net.isIP(remote) === 6 ? "ipv6" : "ipv4")) {
      client.destroy();
      return;
    }
    const up = net.connect(opts.targetPort, opts.targetHost);
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    up.on("close", () => client.destroy());
    client.on("close", () => up.destroy());
    client.pipe(up);
    up.pipe(client);
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a config document (the proxy container has no zod; this is a strict hand-written check). */
export function parseEgressConfig(raw: unknown): EgressConfig {
  if (!isRecord(raw) || typeof raw.version !== "string" || !isRecord(raw.listeners)) throw new Error("invalid egress config");
  const listeners: Record<string, EgressProject> = {};
  for (const [ip, p] of Object.entries(raw.listeners)) {
    if (!net.isIP(ip) || !isRecord(p) || typeof p.projectId !== "string" || !Array.isArray(p.allow)) throw new Error(`invalid listener ${ip}`);
    listeners[ip] = { projectId: p.projectId, allow: p.allow.filter((a): a is string => typeof a === "string") };
  }
  let upstream: UpstreamProxy | null = null;
  if (raw.upstream !== undefined && raw.upstream !== null) {
    const u = raw.upstream;
    if (!isRecord(u) || typeof u.host !== "string" || typeof u.port !== "number") throw new Error("invalid upstream");
    upstream = { host: u.host, port: u.port, authorization: typeof u.authorization === "string" ? u.authorization : undefined };
  }
  return { version: raw.version, listeners, upstream };
}

function parseHostPort(v: string): { host: string; port: number } {
  const p = parseAuthority(v);
  if (!p) throw new Error(`expected host:port, got ${v}`);
  return p;
}

/** Container entrypoint. */
export function main(): void {
  const mode = process.env.FORGE_EGRESS_MODE ?? "proxy";
  if (mode === "relay") {
    const listen = parseHostPort(process.env.FORGE_RELAY_LISTEN ?? "");
    const target = parseHostPort(process.env.FORGE_RELAY_TARGET ?? "");
    const cidr = process.env.FORGE_RELAY_ALLOW_CIDR;
    let allowFrom: [string, number] | undefined;
    if (cidr) {
      const [net0, bits] = cidr.split("/");
      if (net0 && bits) allowFrom = [net0, Number(bits)];
    }
    createTcpRelay({ targetHost: target.host, targetPort: target.port, allowFrom }).listen(listen.port, listen.host, () => {
      process.stdout.write(JSON.stringify({ msg: "forge relay listening", listen, target: `${target.host}:${target.port}` }) + "\n");
    });
    return;
  }
  const configPath = process.env.FORGE_EGRESS_CONFIG ?? "/run/forge/egress.json";
  const appliedPath = process.env.FORGE_EGRESS_APPLIED ?? "/run/forge/egress.applied";
  const port = Number(process.env.FORGE_EGRESS_PORT ?? "3128");
  let config: EgressConfig = { version: "empty", listeners: {}, upstream: null };
  const load = (): void => {
    try {
      config = parseEgressConfig(JSON.parse(readFileSync(configPath, "utf8")));
      writeFileSync(appliedPath + ".tmp", config.version);
      renameSync(appliedPath + ".tmp", appliedPath);
      process.stdout.write(JSON.stringify({ msg: "forge egress config loaded", version: config.version, networks: Object.keys(config.listeners).length, upstream: Boolean(config.upstream) }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ msg: "forge egress config not loaded (deny all)", error: (e as Error).message }) + "\n");
    }
  };
  load();
  process.on("SIGHUP", load);
  process.on("SIGTERM", () => process.exit(0));
  createEgressProxy({ getConfig: () => config }).listen(port, "0.0.0.0", () => {
    process.stdout.write(JSON.stringify({ msg: "forge egress proxy listening", port }) + "\n");
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
