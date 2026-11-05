import { Daytona, DaytonaNotFoundError, type Sandbox as DaytonaSdkSandbox } from "@daytonaio/sdk";
import { ForgeError, envList, newId, type UsageSink } from "@forge/shared";
import { SandboxMeter, RATES } from "../metering.js";
import { defaultSnapshotStore, type SnapshotStore } from "../snapshots.js";
import { DEFAULT_EXEC_TIMEOUT_MS, listFilesCommand, parseListOutput, resolveSandboxPath, shq } from "../shell.js";
import { DEFAULT_EGRESS_ALLOWLIST } from "./docker/egress.js";
import { parseSpec, WORKDIR, type ExecOptions, type ExecResult, type ListFilesOptions, type Sandbox, type SandboxProvider, type SandboxSpec } from "../types.js";

export interface DaytonaSandboxProviderOptions {
  apiKey?: string;
  /** API URL (DAYTONA_API_URL); EU: set DAYTONA_TARGET=eu. */
  apiUrl?: string;
  target?: string;
  image?: string;
  allowlist?: string[];
  usage?: UsageSink;
  snapshotStore?: SnapshotStore;
  /** Pre-built client (tests). */
  client?: Daytona;
}

/**
 * Daytona sandboxes via the official `@daytonaio/sdk`. Egress is enforced by Daytona's domain allowlist
 * (`domainAllowList`); everything else is blocked by the platform.
 */
export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona";
  readonly isMock = false;
  readonly snapshots: SnapshotStore;
  private clientInstance: Daytona | null;

  constructor(private readonly opts: DaytonaSandboxProviderOptions = {}) {
    this.snapshots = opts.snapshotStore ?? defaultSnapshotStore();
    this.clientInstance = opts.client ?? null;
  }

  private get client(): Daytona {
    if (!this.clientInstance) {
      const apiKey = this.opts.apiKey ?? process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new ForgeError("PROVIDER_ERROR", "DAYTONA_API_KEY is not set");
      this.clientInstance = new Daytona({
        apiKey,
        apiUrl: this.opts.apiUrl ?? process.env.DAYTONA_API_URL,
        target: this.opts.target ?? process.env.DAYTONA_TARGET ?? "eu",
      });
    }
    return this.clientInstance;
  }

  async create(input: SandboxSpec): Promise<Sandbox> {
    const spec = parseSpec(input);
    const allow = [...new Set([...(this.opts.allowlist ?? envList("SANDBOX_EGRESS_ALLOWLIST", DEFAULT_EGRESS_ALLOWLIST)), ...(spec.egressAllowlist ?? [])])].map((h) =>
      h.replace(/:\d+$/, ""),
    );
    const cpu = spec.cpu ?? 2;
    const memoryMb = spec.memoryMb ?? 4096;
    const base = {
      labels: { "forge.project": spec.projectId },
      envVars: spec.env,
      domainAllowList: allow.join(","),
      autoStopInterval: spec.timeoutSec ? Math.max(1, Math.ceil(spec.timeoutSec / 60)) : 30,
    };
    const sdk = spec.template
      ? await this.client.create({ ...base, snapshot: spec.template }, { timeout: 180 })
      : await this.client.create(
          { ...base, image: spec.image ?? this.opts.image ?? "node:22-bookworm-slim", resources: { cpu: Math.ceil(cpu), memory: Math.max(1, Math.ceil(memoryMb / 1024)) } },
          { timeout: 180 },
        );
    const sb = this.wrap(sdk, spec.projectId, cpu, memoryMb);
    await sb.exec(`(sudo -n mkdir -p ${WORKDIR} && sudo -n chown "$(id -u):$(id -g)" ${WORKDIR}) 2>/dev/null || mkdir -p ${WORKDIR}`);
    return sb;
  }

  async get(id: string): Promise<Sandbox | null> {
    try {
      const sdk = await this.client.get(id);
      const projectId = sdk.labels?.["forge.project"];
      if (!projectId) return null;
      return this.wrap(sdk, projectId, sdk.cpu, sdk.memory * 1024);
    } catch (e) {
      if (e instanceof DaytonaNotFoundError) return null;
      throw e;
    }
  }

  private wrap(sdk: DaytonaSdkSandbox, projectId: string, cpu: number, memoryMb: number): DaytonaSandbox {
    const meter = new SandboxMeter(this.opts.usage, { provider: "daytona", projectId, cpu, memoryMb, rates: RATES.daytona });
    return new DaytonaSandbox(sdk, projectId, this.snapshots, meter);
  }
}

const STDERR_MARK = "__FORGE_STDERR_9f2c__";

export class DaytonaSandbox implements Sandbox {
  readonly workdir = WORKDIR;
  readonly id: string;

  constructor(
    private readonly sdk: DaytonaSdkSandbox,
    readonly projectId: string,
    private readonly snapshots: SnapshotStore,
    private readonly meter: SandboxMeter,
  ) {
    this.id = sdk.id;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    // Daytona returns combined output; capture stderr separately via a temp file and a marker.
    const errFile = `/tmp/.forge-err-${newId("x", 6)}`;
    const wrapped =
      `timeout -s KILL ${secs} sh -c ${shq(cmd)} 2>${errFile}; ec=$?; printf '\\n${STDERR_MARK}\\n'; cat ${errFile} 2>/dev/null; rm -f ${errFile}; exit $ec`;
    try {
      const r = await this.sdk.process.executeCommand(`sh -c ${shq(wrapped)}`, resolveSandboxPath(opts.cwd), opts.env, secs + 10);
      const idx = r.result.lastIndexOf(`\n${STDERR_MARK}\n`);
      const stdout = idx >= 0 ? r.result.slice(0, idx) : r.result;
      const stderr = idx >= 0 ? r.result.slice(idx + STDERR_MARK.length + 2) : "";
      const durationMs = Date.now() - started;
      return { exitCode: r.exitCode, stdout, stderr, durationMs, timedOut: (r.exitCode === 124 || r.exitCode === 137) && durationMs >= timeoutMs * 0.9 };
    } catch (e) {
      const err = e as Error;
      if (/timeout/i.test(err.name) || /timed? ?out/i.test(err.message)) return { exitCode: 124, stdout: "", stderr: err.message, durationMs: Date.now() - started, timedOut: true };
      throw new ForgeError("SANDBOX_ERROR", `daytona exec failed: ${err.message}`);
    }
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.sdk.fs.downloadFile(resolveSandboxPath(path)));
    } catch (e) {
      throw new ForgeError("NOT_FOUND", `cannot read ${path}: ${(e as Error).message}`);
    }
  }

  async readFile(path: string): Promise<string> {
    return Buffer.from(await this.readFileBytes(path)).toString("utf8");
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const abs = resolveSandboxPath(path);
    const dir = abs.slice(0, abs.lastIndexOf("/")) || "/";
    await this.exec(`mkdir -p ${shq(dir)}`);
    await this.sdk.fs.uploadFile(Buffer.from(content), abs);
  }

  async listFiles(dir?: string, opts: ListFilesOptions = {}): Promise<string[]> {
    const abs = resolveSandboxPath(dir);
    const r = await this.exec(listFilesCommand(abs, opts));
    if (r.exitCode !== 0) throw new ForgeError("NOT_FOUND", `cannot list ${abs}: ${r.stderr}`);
    return parseListOutput(abs, r.stdout, opts);
  }

  async snapshot(label?: string): Promise<{ snapshotId: string }> {
    const snapshotId = this.snapshots.newId();
    const tmp = `/tmp/${snapshotId}.tar.gz`;
    const r = await this.exec(`tar -C ${shq(WORKDIR)} -czf ${shq(tmp)} .`);
    if (r.exitCode !== 0) throw new ForgeError("SANDBOX_ERROR", `snapshot failed: ${r.stderr}`);
    const data = new Uint8Array(await this.sdk.fs.downloadFile(tmp));
    await this.exec(`rm -f ${shq(tmp)}`);
    await this.snapshots.save({ snapshotId, projectId: this.projectId, sandboxId: this.id, provider: "daytona", label }, data);
    return { snapshotId };
  }

  async restore(snapshotId: string): Promise<void> {
    const data = await this.snapshots.load(this.projectId, snapshotId);
    const tmp = `/tmp/restore-${snapshotId}.tar.gz`;
    await this.sdk.fs.uploadFile(Buffer.from(data), tmp);
    const r = await this.exec(`find ${shq(WORKDIR)} -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C ${shq(WORKDIR)} -xzf ${shq(tmp)} && rm -f ${shq(tmp)}`);
    if (r.exitCode !== 0) throw new ForgeError("SANDBOX_ERROR", `restore failed: ${r.stderr}`);
  }

  async exposePort(port: number): Promise<{ url: string }> {
    const signed = await this.sdk.getSignedPreviewUrl(port, 3600);
    return { url: signed.url };
  }

  /** Daytona stop keeps the filesystem; start brings it back. */
  async pause(): Promise<void> {
    await this.sdk.stop();
    await this.meter.stop();
  }

  async resume(): Promise<void> {
    await this.sdk.start();
    this.meter.start();
  }

  async destroy(): Promise<void> {
    await this.meter.stop();
    await this.sdk.delete();
  }
}
