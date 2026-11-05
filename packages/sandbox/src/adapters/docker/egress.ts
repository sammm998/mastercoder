import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { createLogger, ForgeError } from "@forge/shared";
import { buildTar } from "../../tar.js";
import { docker, dockerRaw, inspectOrNull, type ContainerInspect, type NetworkInspect } from "./cli.js";
import type { EgressConfig, EgressProject, UpstreamProxy } from "../../egress-proxy.js";

const log = createLogger({ mod: "sandbox.egress" });

/** Hosts every sandbox may reach (package registries). Override with SANDBOX_EGRESS_ALLOWLIST. */
export const DEFAULT_EGRESS_ALLOWLIST = ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org"];
export const EGRESS_ALIAS = "forge-egress";
export const EGRESS_PORT = 3128;

export interface DockerEgressOptions {
  prefix: string;
  image: string;
  /** Global allowlist merged into every project's allowlist. */
  allowlist: string[];
  /** Upstream proxy URL (http://[user:pass@]host:port) or null for direct egress. */
  upstreamProxy: string | null;
  relayPort: number;
}

interface ParsedUpstream {
  host: string;
  port: number;
  authorization?: string;
  loopback: boolean;
}

export function parseUpstream(url: string | null): ParsedUpstream | null {
  if (!url) return null;
  const u = new URL(url);
  if (u.protocol !== "http:") throw new ForgeError("BAD_INPUT", `upstream proxy must be http://, got ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = Number(u.port || "80");
  const authorization = u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}` : undefined;
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  return { host, port, authorization, loopback };
}

let bundleCache: { files: Record<string, string>; version: string } | null = null;

type Strip = (code: string, opts: { mode: "strip" }) => string;

/** Node >= 22.13 has module.stripTypeScriptTypes; older Nodes fall back to the TypeScript compiler. */
async function stripTypes(src: string): Promise<string> {
  const strip = (nodeModule as unknown as { stripTypeScriptTypes?: Strip }).stripTypeScriptTypes;
  if (typeof strip === "function") return strip(src, { mode: "strip" });
  const ts = (await import("typescript")) as unknown as {
    transpileModule: (s: string, o: { compilerOptions: Record<string, unknown> }) => { outputText: string };
  };
  return ts.transpileModule(src, { compilerOptions: { module: 99, target: 9, verbatimModuleSyntax: false } }).outputText;
}

/** Type-strip egress-proxy.ts + egress-policy.ts into plain ESM for the proxy container. */
export async function egressBundle(): Promise<{ files: Record<string, string>; version: string }> {
  if (bundleCache) return bundleCache;
  const files: Record<string, string> = { "package.json": JSON.stringify({ type: "module" }) };
  for (const name of ["egress-proxy", "egress-policy"]) {
    const src = await readFile(new URL(`../../${name}.ts`, import.meta.url), "utf8");
    files[`${name}.js`] = await stripTypes(src);
  }
  const version = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
  bundleCache = { files, version };
  return bundleCache;
}

/**
 * Manages the shared egress proxy container (+ optional host-network relay to a loopback upstream proxy) and keeps
 * its per-network allowlist config in sync with the project networks that exist.
 */
export class DockerEgress {
  readonly proxyName: string;
  readonly relayName: string;
  readonly netName: string;
  private readonly upstream: ParsedUpstream | null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly opts: DockerEgressOptions) {
    this.proxyName = `${opts.prefix}-egress-proxy`;
    this.relayName = `${opts.prefix}-egress-relay`;
    this.netName = `${opts.prefix}-egress`;
    this.upstream = parseUpstream(opts.upstreamProxy);
  }

  /** URL sandboxes use as HTTP(S)_PROXY. */
  get proxyUrl(): string {
    return `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;
  }

  get hasUpstream(): boolean {
    return this.upstream !== null;
  }

  /** Serialize egress mutations inside this process. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async ensureNetwork(): Promise<NetworkInspect> {
    let net = await inspectOrNull<NetworkInspect>("network", this.netName);
    if (!net) {
      const r = await dockerRaw(["network", "create", "--label", "forge.role=egress-net", "--label", `forge.prefix=${this.opts.prefix}`, this.netName]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) throw new ForgeError("SANDBOX_ERROR", `create egress network: ${r.stderr.trim()}`);
      net = await inspectOrNull<NetworkInspect>("network", this.netName);
    }
    if (!net) throw new ForgeError("SANDBOX_ERROR", "egress network missing after create");
    return net;
  }

  private async ensureImage(): Promise<void> {
    if (await inspectOrNull("image", this.opts.image)) return;
    await docker(["pull", "-q", this.opts.image], { timeoutMs: 600000 });
  }

  /** Copy the type-stripped proxy code into a created (not yet started) container at /app. */
  async copyBundle(container: string): Promise<void> {
    const { files } = await egressBundle();
    const tar = buildTar([
      { name: "app", type: "dir", mode: 0o755 },
      ...Object.entries(files).map(([name, content]) => ({ name: `app/${name}`, type: "file" as const, mode: 0o644, content })),
    ]);
    await docker(["cp", "-", `${container}:/`], { input: tar });
  }

  /** Create (or replace when the code version changed) a long-lived helper container and start it. */
  private async ensureHelper(name: string, role: string, createArgs: string[], version: string): Promise<void> {
    const existing = await inspectOrNull<ContainerInspect>("container", name);
    if (existing) {
      const ok = existing.Config.Labels?.["forge.egress.version"] === version;
      if (ok && existing.State.Running) return;
      if (ok && !existing.State.Running) {
        const r = await dockerRaw(["start", name]);
        if (r.code === 0) return;
      }
      await dockerRaw(["rm", "-f", name]);
    }
    const r = await dockerRaw([
      "create",
      "--name",
      name,
      "--label",
      `forge.role=${role}`,
      "--label",
      `forge.prefix=${this.opts.prefix}`,
      "--label",
      `forge.egress.version=${version}`,
      "--init",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--restart",
      "unless-stopped",
      "--pids-limit",
      "256",
      ...createArgs,
      this.opts.image,
      "node",
      "/app/egress-proxy.js",
    ]);
    if (r.code !== 0) {
      if (/already in use/i.test(r.stderr)) return; // another process won the race
      throw new ForgeError("SANDBOX_ERROR", `create ${role}: ${r.stderr.trim()}`);
    }
    await this.copyBundle(name);
    await docker(["start", name]);
    log.info("egress helper started", { name, role, version });
  }

  /** Ensure network, relay (when the upstream proxy is on the host loopback) and proxy are running. */
  ensure(): Promise<void> {
    return this.locked(() => this.ensureUnlocked());
  }

  private async ensureUnlocked(): Promise<void> {
    await this.ensureImage();
    const net = await this.ensureNetwork();
    const { version } = await egressBundle();
    if (this.upstream?.loopback) {
      const cfg = net.IPAM.Config?.[0];
      if (!cfg?.Gateway || !cfg.Subnet) throw new ForgeError("SANDBOX_ERROR", "egress network has no gateway/subnet");
      await this.ensureHelper(
        this.relayName,
        "egress-relay",
        [
          "--network",
          "host",
          "--memory",
          "64m",
          "-e",
          "FORGE_EGRESS_MODE=relay",
          "-e",
          `FORGE_RELAY_LISTEN=${cfg.Gateway}:${this.opts.relayPort}`,
          "-e",
          `FORGE_RELAY_TARGET=${this.upstream.host.includes(":") ? `[${this.upstream.host}]` : this.upstream.host}:${this.upstream.port}`,
          "-e",
          `FORGE_RELAY_ALLOW_CIDR=${cfg.Subnet}`,
        ],
        `${version}-${cfg.Gateway}-${this.opts.relayPort}-${this.upstream.port}`,
      );
    }
    await this.ensureHelper(
      this.proxyName,
      "egress-proxy",
      [
        "--network",
        this.netName,
        "--memory",
        "256m",
        "--tmpfs",
        "/run/forge:rw,nosuid,nodev,size=1m,uid=1000,gid=1000,mode=0700",
        "-e",
        "FORGE_EGRESS_MODE=proxy",
        "-e",
        `FORGE_EGRESS_PORT=${EGRESS_PORT}`,
      ],
      version,
    );
  }

  /** Attach the proxy to a project network (alias forge-egress) and push the new config. */
  attach(network: string): Promise<void> {
    return this.locked(async () => {
      await this.ensureUnlocked();
      const r = await dockerRaw(["network", "connect", "--alias", EGRESS_ALIAS, network, this.proxyName]);
      if (r.code !== 0 && !/already exists|already attached/i.test(r.stderr)) throw new ForgeError("SANDBOX_ERROR", `attach egress proxy: ${r.stderr.trim()}`);
      await this.syncUnlocked();
    });
  }

  /** Detach the proxy from a project network (call `sync()` after removing the network). */
  detach(network: string): Promise<void> {
    return this.locked(async () => {
      await dockerRaw(["network", "disconnect", "-f", network, this.proxyName]);
    });
  }

  sync(): Promise<void> {
    return this.locked(() => this.syncUnlocked());
  }

  private async upstreamForConfig(): Promise<UpstreamProxy | null> {
    if (!this.upstream) return null;
    if (!this.upstream.loopback) return { host: this.upstream.host, port: this.upstream.port, authorization: this.upstream.authorization };
    const net = await this.ensureNetwork();
    const gw = net.IPAM.Config?.[0]?.Gateway;
    if (!gw) throw new ForgeError("SANDBOX_ERROR", "egress network has no gateway");
    return { host: gw, port: this.opts.relayPort, authorization: this.upstream.authorization };
  }

  /** Build the config from docker state (project networks + labels) and apply it, waiting for the proxy to confirm. */
  private async syncUnlocked(): Promise<void> {
    const names = (await docker(["network", "ls", "--filter", "label=forge.role=sandbox-net", "--filter", `label=forge.prefix=${this.opts.prefix}`, "--format", "{{.Name}}"]))
      .split("\n")
      .filter(Boolean);
    const proxy = await inspectOrNull<ContainerInspect>("container", this.proxyName);
    if (!proxy) throw new ForgeError("SANDBOX_ERROR", "egress proxy container missing");
    const listeners: Record<string, EgressProject> = {};
    for (const name of names) {
      const net = await inspectOrNull<NetworkInspect>("network", name);
      if (!net) continue;
      let ip = proxy.NetworkSettings.Networks[name]?.IPAddress;
      if (!ip) {
        const r = await dockerRaw(["network", "connect", "--alias", EGRESS_ALIAS, name, this.proxyName]);
        if (r.code !== 0 && !/already/i.test(r.stderr)) continue;
        const again = await inspectOrNull<ContainerInspect>("container", this.proxyName);
        ip = again?.NetworkSettings.Networks[name]?.IPAddress;
      }
      if (!ip) continue;
      const labels = net.Labels ?? {};
      const projectAllow = (labels["forge.egress"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      listeners[ip] = { projectId: labels["forge.project"] ?? name, allow: [...new Set([...this.opts.allowlist, ...projectAllow])] };
    }
    const body = { listeners, upstream: await this.upstreamForConfig() };
    const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
    const config: EgressConfig = { version, ...body };
    await docker(
      ["exec", "-i", this.proxyName, "sh", "-c", "cat > /run/forge/egress.json.tmp && mv -f /run/forge/egress.json.tmp /run/forge/egress.json && kill -HUP 1"],
      { input: JSON.stringify(config) },
    );
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const r = await dockerRaw(["exec", this.proxyName, "cat", "/run/forge/egress.applied"]);
      if (r.code === 0 && r.stdout.toString("utf8").trim() === version) return;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new ForgeError("SANDBOX_ERROR", "egress proxy did not apply config in time");
  }

  /** Remove proxy, relay and egress network (only when no project networks remain). */
  async teardown(): Promise<void> {
    await this.locked(async () => {
      await dockerRaw(["rm", "-f", this.proxyName, this.relayName]);
      await dockerRaw(["network", "rm", this.netName]);
    });
  }
}
