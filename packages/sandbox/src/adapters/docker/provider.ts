import { existsSync, readFileSync } from "node:fs";
import { createLogger, envInt, envList, ForgeError, type UsageSink } from "@forge/shared";
import { docker, dockerRaw, inspectOrNull, safeName, type ContainerInspect, type NetworkInspect } from "./cli.js";
import { DEFAULT_EGRESS_ALLOWLIST, DockerEgress } from "./egress.js";
import { buildTar } from "../../tar.js";
import { SandboxMeter, dockerRates } from "../../metering.js";
import { defaultSnapshotStore, type SnapshotStore } from "../../snapshots.js";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  listFilesCommand,
  looksTimedOut,
  parseListOutput,
  resolveSandboxPath,
  shq,
  withTimeout,
} from "../../shell.js";
import { parseSpec, WORKDIR, type ExecOptions, type ExecResult, type ListFilesOptions, type Sandbox, type SandboxProvider, type SandboxSpec } from "../../types.js";

const log = createLogger({ mod: "sandbox.docker" });

export interface DockerSandboxProviderOptions {
  /** Name prefix for containers/networks (default SANDBOX_DOCKER_PREFIX or "forge"). */
  prefix?: string;
  /** Default image (SANDBOX_DOCKER_IMAGE or node:22-bookworm-slim). */
  image?: string;
  /** uid:gid the sandbox runs as (never root). */
  user?: string;
  defaultCpu?: number;
  defaultMemoryMb?: number;
  pidsLimit?: number;
  tmpSizeMb?: number;
  snapshotStore?: SnapshotStore;
  usage?: UsageSink;
  /** "ip": container IP on its network (Linux docker host). "publish": loopback-published forwarder container. */
  exposeMode?: "ip" | "publish";
  egress?: {
    allowlist?: string[];
    /** Upstream proxy URL, null for none. Default: SANDBOX_UPSTREAM_PROXY, else the host's HTTPS_PROXY. */
    upstreamProxy?: string | null;
    /** CA bundle sandboxes must trust when the upstream re-terminates TLS. */
    upstreamCaFile?: string | null;
    relayPort?: number;
    image?: string;
  };
}

const CA_PATH = "/etc/forge/upstream-ca.crt";

function defaultUpstream(): string | null {
  const v = process.env.SANDBOX_UPSTREAM_PROXY;
  if (v !== undefined) return v === "" || v === "none" ? null : v;
  return process.env.HTTPS_PROXY || process.env.https_proxy || null;
}

function defaultCaFile(): string | null {
  const v = process.env.SANDBOX_UPSTREAM_CA_FILE;
  if (v !== undefined) return v === "" || v === "none" ? null : v;
  for (const c of [process.env.NODE_EXTRA_CA_CERTS, process.env.SSL_CERT_FILE]) if (c && existsSync(c)) return c;
  return null;
}

interface Resolved {
  prefix: string;
  image: string;
  user: string;
  cpu: number;
  memoryMb: number;
  pidsLimit: number;
  tmpSizeMb: number;
  exposeMode: "ip" | "publish";
  caFile: string | null;
}

/**
 * Real Docker sandboxes via the docker CLI. One hardened container per project on its own `--internal` network;
 * the only route out is the Forge egress proxy (see egress-proxy.ts).
 */
export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";
  readonly isMock = false;
  readonly egress: DockerEgress;
  readonly snapshots: SnapshotStore;
  private readonly cfg: Resolved;
  private readonly live = new Map<string, DockerSandbox>();

  constructor(readonly options: DockerSandboxProviderOptions = {}) {
    const prefix = safeName(options.prefix ?? process.env.SANDBOX_DOCKER_PREFIX ?? "forge");
    const upstreamProxy = options.egress?.upstreamProxy !== undefined ? options.egress.upstreamProxy : defaultUpstream();
    this.cfg = {
      prefix,
      image: options.image ?? process.env.SANDBOX_DOCKER_IMAGE ?? "node:22-bookworm-slim",
      user: options.user ?? process.env.SANDBOX_DOCKER_USER ?? "1000:1000",
      cpu: options.defaultCpu ?? Number(process.env.SANDBOX_DEFAULT_CPU ?? "2"),
      memoryMb: options.defaultMemoryMb ?? envInt("SANDBOX_DEFAULT_MEMORY_MB", 2048),
      pidsLimit: options.pidsLimit ?? envInt("SANDBOX_DOCKER_PIDS_LIMIT", 512),
      tmpSizeMb: options.tmpSizeMb ?? envInt("SANDBOX_DOCKER_TMP_MB", 512),
      exposeMode: options.exposeMode ?? (process.env.SANDBOX_DOCKER_EXPOSE === "publish" ? "publish" : "ip"),
      caFile: upstreamProxy ? (options.egress?.upstreamCaFile !== undefined ? options.egress.upstreamCaFile : defaultCaFile()) : null,
    };
    if (/^0(:|$)|^root(:|$)/.test(this.cfg.user)) throw new ForgeError("BAD_INPUT", "sandbox user must not be root");
    this.egress = new DockerEgress({
      prefix,
      image: options.egress?.image ?? process.env.SANDBOX_EGRESS_IMAGE ?? "node:22-bookworm-slim",
      allowlist: options.egress?.allowlist ?? envList("SANDBOX_EGRESS_ALLOWLIST", DEFAULT_EGRESS_ALLOWLIST),
      upstreamProxy,
      relayPort: options.egress?.relayPort ?? envInt("SANDBOX_EGRESS_RELAY_PORT", 39129),
    });
    this.snapshots = options.snapshotStore ?? defaultSnapshotStore();
  }

  get prefix(): string {
    return this.cfg.prefix;
  }

  containerName(projectId: string): string {
    return `${this.cfg.prefix}-sbx-${safeName(projectId)}`;
  }

  networkName(projectId: string): string {
    return `${this.cfg.prefix}-net-${safeName(projectId)}`;
  }

  private async ensureImage(image: string): Promise<void> {
    if (await inspectOrNull("image", image)) return;
    log.info("pulling sandbox image", { image });
    await docker(["pull", "-q", image], { timeoutMs: 900000 });
  }

  private async ensureNetwork(projectId: string, allow: string[]): Promise<string> {
    const name = this.networkName(projectId);
    const label = allow.join(",");
    const existing = await inspectOrNull<NetworkInspect>("network", name);
    if (existing) {
      if ((existing.Labels?.["forge.egress"] ?? "") === label && existing.Internal) return name;
      // Labels are immutable: recreate (the project's old container was removed by the caller).
      await dockerRaw(["network", "disconnect", "-f", name, this.egress.proxyName]);
      await docker(["network", "rm", name]);
    }
    const r = await dockerRaw([
      "network",
      "create",
      "--internal",
      "--label",
      "forge.role=sandbox-net",
      "--label",
      `forge.prefix=${this.cfg.prefix}`,
      "--label",
      `forge.project=${projectId}`,
      "--label",
      `forge.egress=${label}`,
      name,
    ]);
    if (r.code !== 0 && !/already exists/i.test(r.stderr)) throw new ForgeError("SANDBOX_ERROR", `create network: ${r.stderr.trim()}`);
    return name;
  }

  /** docker create argv for a project sandbox (exported for tests). */
  buildCreateArgs(spec: SandboxSpec, network: string): string[] {
    const cpu = spec.cpu ?? this.cfg.cpu;
    const mem = spec.memoryMb ?? this.cfg.memoryMb;
    const proxy = this.egress.proxyUrl;
    const env: Record<string, string> = {
      HOME: "/tmp",
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      npm_config_update_notifier: "false",
      ...(this.cfg.caFile
        ? {
            NODE_EXTRA_CA_CERTS: CA_PATH,
            SSL_CERT_FILE: CA_PATH,
            REQUESTS_CA_BUNDLE: CA_PATH,
            CURL_CA_BUNDLE: CA_PATH,
            PIP_CERT: CA_PATH,
            GIT_SSL_CAINFO: CA_PATH,
            npm_config_cafile: CA_PATH,
          }
        : {}),
      ...(spec.env ?? {}),
    };
    const args = [
      "create",
      "--name",
      this.containerName(spec.projectId),
      "--hostname",
      "sandbox",
      "--label",
      "forge.role=sandbox",
      "--label",
      `forge.prefix=${this.cfg.prefix}`,
      "--label",
      `forge.project=${spec.projectId}`,
      "--label",
      `forge.cpu=${cpu}`,
      "--label",
      `forge.memory-mb=${mem}`,
      "--network",
      network,
      "--init",
      "--user",
      this.cfg.user,
      "--cpus",
      String(cpu),
      "--memory",
      `${mem}m`,
      "--memory-swap",
      `${mem}m`,
      "--pids-limit",
      String(this.cfg.pidsLimit),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      `/tmp:rw,nosuid,nodev,size=${this.cfg.tmpSizeMb}m,mode=1777`,
      "--workdir",
      WORKDIR,
      "--stop-timeout",
      "2",
    ];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    args.push(spec.image ?? this.cfg.image);
    if (spec.timeoutSec) args.push("sleep", String(spec.timeoutSec));
    else args.push("tail", "-f", "/dev/null");
    return args;
  }

  async create(input: SandboxSpec): Promise<Sandbox> {
    const spec = parseSpec(input);
    const name = this.containerName(spec.projectId);
    const existing = await inspectOrNull<ContainerInspect>("container", name);
    if (existing) {
      if (existing.Config.Labels?.["forge.project"] === spec.projectId && (existing.State.Running || existing.State.Paused)) {
        await this.egress.sync();
        return this.wrap(existing);
      }
      await docker(["rm", "-f", name]);
    }
    const image = spec.image ?? this.cfg.image;
    await this.ensureImage(image);
    const allow = [...new Set(spec.egressAllowlist ?? [])];
    const network = await this.ensureNetwork(spec.projectId, allow);
    await this.egress.attach(network);
    const r = await dockerRaw(this.buildCreateArgs(spec, network));
    if (r.code !== 0) throw new ForgeError("SANDBOX_ERROR", `docker create failed: ${r.stderr.trim()}`);
    const [uid, gid] = this.cfg.user.split(":").map((n) => Number(n));
    const entries: Parameters<typeof buildTar>[0] = [{ name: "workspace", type: "dir", mode: 0o755, uid: uid ?? 1000, gid: gid ?? uid ?? 1000 }];
    if (this.cfg.caFile) {
      entries.push({ name: "etc/forge", type: "dir", mode: 0o755 });
      entries.push({ name: CA_PATH.slice(1), type: "file", mode: 0o644, content: readFileSync(this.cfg.caFile) });
    }
    await docker(["cp", "-a", "-", `${name}:/`], { input: buildTar(entries) });
    await docker(["start", name]);
    const info = await inspectOrNull<ContainerInspect>("container", name);
    if (!info) throw new ForgeError("SANDBOX_ERROR", "sandbox vanished after start");
    log.info("sandbox created", { name, projectId: spec.projectId, image });
    return this.wrap(info, Date.now());
  }

  async get(id: string): Promise<Sandbox | null> {
    const cached = this.live.get(id);
    if (cached && !cached.destroyed) return cached;
    const info = await inspectOrNull<ContainerInspect>("container", id);
    if (!info) return null;
    const labels = info.Config.Labels ?? {};
    if (labels["forge.role"] !== "sandbox" || labels["forge.prefix"] !== this.cfg.prefix) return null;
    if (!info.State.Running && !info.State.Paused) return null;
    return this.wrap(info);
  }

  private wrap(info: ContainerInspect, startedAt?: number): DockerSandbox {
    const labels = info.Config.Labels ?? {};
    const projectId = labels["forge.project"] ?? "";
    const name = info.Name.replace(/^\//, "");
    const cached = this.live.get(name);
    if (cached && !cached.destroyed) return cached;
    const cpu = Number(labels["forge.cpu"] ?? this.cfg.cpu);
    const memoryMb = Number(labels["forge.memory-mb"] ?? this.cfg.memoryMb);
    const since = info.State.Paused ? null : (startedAt ?? (Date.parse(info.State.StartedAt) || Date.now()));
    const meter = new SandboxMeter(this.options.usage, { provider: "docker", projectId, cpu, memoryMb, rates: dockerRates() }, since);
    const sb = new DockerSandbox(this, name, projectId, this.networkName(projectId), this.cfg.user, meter);
    this.live.set(name, sb);
    return sb;
  }

  /** @internal */
  get exposeMode(): "ip" | "publish" {
    return this.cfg.exposeMode;
  }

  /** @internal */
  forget(name: string): void {
    this.live.delete(name);
  }
}

export class DockerSandbox implements Sandbox {
  readonly workdir = WORKDIR;
  destroyed = false;

  constructor(
    private readonly provider: DockerSandboxProvider,
    readonly id: string,
    readonly projectId: string,
    readonly network: string,
    private readonly user: string,
    private readonly meter: SandboxMeter,
  ) {}

  private assertAlive(): void {
    if (this.destroyed) throw new ForgeError("SANDBOX_ERROR", `sandbox ${this.id} was destroyed`);
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertAlive();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const args = ["exec", "-u", this.user, "-w", resolveSandboxPath(opts.cwd)];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ForgeError("BAD_INPUT", `invalid env name ${k}`);
      args.push("-e", `${k}=${v}`);
    }
    args.push(this.id, ...withTimeout(cmd, timeoutMs));
    const r = await dockerRaw(args, { timeoutMs: timeoutMs + 15000 });
    if (r.code !== 0 && /is paused|is not running|No such container/i.test(r.stderr) && r.stdout.length === 0) {
      throw new ForgeError("SANDBOX_ERROR", `exec failed: ${r.stderr.trim()}`);
    }
    const timedOut = r.timedOut || looksTimedOut(r.code, r.durationMs, timeoutMs);
    return { exitCode: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr, durationMs: r.durationMs, timedOut };
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    this.assertAlive();
    const abs = resolveSandboxPath(path);
    const r = await dockerRaw(["exec", "-u", this.user, this.id, "cat", "--", abs]);
    if (r.code !== 0) throw new ForgeError("NOT_FOUND", `cannot read ${abs}: ${r.stderr.trim()}`);
    return new Uint8Array(r.stdout);
  }

  async readFile(path: string): Promise<string> {
    return Buffer.from(await this.readFileBytes(path)).toString("utf8");
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.assertAlive();
    const abs = resolveSandboxPath(path);
    await docker(["exec", "-i", "-u", this.user, this.id, "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", abs], {
      input: typeof content === "string" ? content : Buffer.from(content),
    });
  }

  async listFiles(dir?: string, opts: ListFilesOptions = {}): Promise<string[]> {
    this.assertAlive();
    const abs = resolveSandboxPath(dir);
    const r = await dockerRaw(["exec", "-u", this.user, this.id, "sh", "-c", listFilesCommand(abs, opts)]);
    if (r.code !== 0) throw new ForgeError("NOT_FOUND", `cannot list ${abs}: ${r.stderr.trim()}`);
    return parseListOutput(abs, r.stdout.toString("utf8"), opts);
  }

  async snapshot(label?: string): Promise<{ snapshotId: string }> {
    this.assertAlive();
    const r = await dockerRaw(["exec", "-u", this.user, this.id, "tar", "-C", WORKDIR, "-czf", "-", "."], { timeoutMs: 600000 });
    if (r.code !== 0) throw new ForgeError("SANDBOX_ERROR", `snapshot failed: ${r.stderr.trim()}`);
    const snapshotId = this.provider.snapshots.newId();
    await this.provider.snapshots.save({ snapshotId, projectId: this.projectId, sandboxId: this.id, provider: "docker", label }, new Uint8Array(r.stdout));
    return { snapshotId };
  }

  async restore(snapshotId: string): Promise<void> {
    this.assertAlive();
    const tarball = await this.provider.snapshots.load(this.projectId, snapshotId);
    await docker(
      ["exec", "-i", "-u", this.user, this.id, "sh", "-c", `find ${shq(WORKDIR)} -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C ${shq(WORKDIR)} -xzf -`],
      { input: Buffer.from(tarball), timeoutMs: 600000 },
    );
  }

  async exposePort(port: number): Promise<{ url: string }> {
    this.assertAlive();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ForgeError("BAD_INPUT", `invalid port ${port}`);
    const info = await inspectOrNull<ContainerInspect>("container", this.id);
    const ip = info?.NetworkSettings.Networks[this.network]?.IPAddress;
    if (!ip) throw new ForgeError("SANDBOX_ERROR", "sandbox has no address on its network");
    if (this.provider.exposeMode === "ip") return { url: `http://${ip}:${port}` };
    return { url: await this.publishForwarder(ip, port) };
  }

  /** Forwarder container on a normal bridge with a loopback-published port, attached to the project network. */
  private async publishForwarder(ip: string, port: number): Promise<string> {
    const name = `${this.id}-fwd-${port}`;
    let info = await inspectOrNull<ContainerInspect>("container", name);
    if (!info || !info.State.Running) {
      if (info) await dockerRaw(["rm", "-f", name]);
      await this.provider.egress.ensure();
      await docker([
        "create",
        "--name",
        name,
        "--label",
        "forge.role=forwarder",
        "--label",
        `forge.prefix=${this.provider.prefix}`,
        "--label",
        `forge.project=${this.projectId}`,
        "--init",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "64m",
        "--network",
        "bridge",
        "-p",
        `127.0.0.1::${port}`,
        "-e",
        "FORGE_EGRESS_MODE=relay",
        "-e",
        `FORGE_RELAY_LISTEN=0.0.0.0:${port}`,
        "-e",
        `FORGE_RELAY_TARGET=${ip}:${port}`,
        this.provider.egress.opts.image,
        "node",
        "/app/egress-proxy.js",
      ]);
      await this.provider.egress.copyBundle(name);
      await docker(["network", "connect", this.network, name]);
      await docker(["start", name]);
      info = await inspectOrNull<ContainerInspect>("container", name);
    }
    const binding = info?.NetworkSettings.Ports?.[`${port}/tcp`]?.[0];
    if (!binding) throw new ForgeError("SANDBOX_ERROR", "forwarder has no published port");
    return `http://127.0.0.1:${binding.HostPort}`;
  }

  async pause(): Promise<void> {
    this.assertAlive();
    await docker(["pause", this.id]);
    await this.meter.stop();
  }

  async resume(): Promise<void> {
    this.assertAlive();
    await docker(["unpause", this.id]);
    this.meter.start();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.meter.stop();
    this.provider.forget(this.id);
    const fwd = await dockerRaw(["ps", "-aq", "--filter", "label=forge.role=forwarder", "--filter", `label=forge.project=${this.projectId}`, "--filter", `label=forge.prefix=${this.provider.prefix}`]);
    const ids = fwd.stdout.toString("utf8").split("\n").filter(Boolean);
    await dockerRaw(["rm", "-f", this.id, ...ids]);
    const net = await inspectOrNull<NetworkInspect>("network", this.network);
    if (net) {
      const others = Object.values(net.Containers ?? {}).filter((c) => c.Name !== this.provider.egress.proxyName);
      if (others.length === 0) {
        await this.provider.egress.detach(this.network);
        await dockerRaw(["network", "rm", this.network]);
        await this.provider.egress.sync().catch((e: unknown) => log.warn("egress sync after destroy failed", { error: String(e) }));
      }
    }
    log.info("sandbox destroyed", { id: this.id });
  }
}
