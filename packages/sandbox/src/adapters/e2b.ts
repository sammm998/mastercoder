import { Sandbox as E2BSdkSandbox, CommandExitError, TimeoutError, NotFoundError, ALL_TRAFFIC } from "e2b";
import { ForgeError, envList, type UsageSink } from "@forge/shared";
import { SandboxMeter, RATES } from "../metering.js";
import { defaultSnapshotStore, type SnapshotStore } from "../snapshots.js";
import { DEFAULT_EXEC_TIMEOUT_MS, listFilesCommand, parseListOutput, resolveSandboxPath, shq } from "../shell.js";
import { DEFAULT_EGRESS_ALLOWLIST } from "./docker/egress.js";
import { parseSpec, WORKDIR, type ExecOptions, type ExecResult, type ListFilesOptions, type Sandbox, type SandboxProvider, type SandboxSpec } from "../types.js";

export interface E2BSandboxProviderOptions {
  apiKey?: string;
  /** Default template (E2B_TEMPLATE or "base"). */
  template?: string;
  allowlist?: string[];
  usage?: UsageSink;
  snapshotStore?: SnapshotStore;
  /** E2B default template size; used for metering (cpu/memory are set by the template on E2B). */
  defaultCpu?: number;
  defaultMemoryMb?: number;
}

/**
 * E2B Firecracker microVM sandboxes via the official `e2b` SDK. Egress is enforced by E2B's network policy:
 * deny all (`ALL_TRAFFIC`) except the allowlisted hostnames.
 */
export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b";
  readonly isMock = false;
  readonly snapshots: SnapshotStore;

  constructor(private readonly opts: E2BSandboxProviderOptions = {}) {
    this.snapshots = opts.snapshotStore ?? defaultSnapshotStore();
  }

  private get apiKey(): string {
    const k = this.opts.apiKey ?? process.env.E2B_API_KEY;
    if (!k) throw new ForgeError("PROVIDER_ERROR", "E2B_API_KEY is not set");
    return k;
  }

  async create(input: SandboxSpec): Promise<Sandbox> {
    const spec = parseSpec(input);
    const allow = [...new Set([...(this.opts.allowlist ?? envList("SANDBOX_EGRESS_ALLOWLIST", DEFAULT_EGRESS_ALLOWLIST)), ...(spec.egressAllowlist ?? [])])].map((h) =>
      h.replace(/:\d+$/, ""),
    );
    const template = spec.template ?? this.opts.template ?? process.env.E2B_TEMPLATE ?? "base";
    const sdk = await E2BSdkSandbox.create(template, {
      apiKey: this.apiKey,
      metadata: { "forge.project": spec.projectId },
      envs: spec.env,
      timeoutMs: (spec.timeoutSec ?? 3600) * 1000,
      network: { allowOut: allow, denyOut: [ALL_TRAFFIC] },
    });
    await sdk.commands.run(`mkdir -p ${WORKDIR} && chown $(id -u user 2>/dev/null || echo 1000):$(id -g user 2>/dev/null || echo 1000) ${WORKDIR}`, { user: "root" });
    return this.wrap(sdk, spec.projectId, spec.cpu, spec.memoryMb);
  }

  async get(id: string): Promise<Sandbox | null> {
    try {
      const sdk = await E2BSdkSandbox.connect(id, { apiKey: this.apiKey });
      const info = await sdk.getInfo();
      const projectId = info.metadata?.["forge.project"];
      if (!projectId) return null;
      return this.wrap(sdk, projectId);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }

  private wrap(sdk: E2BSdkSandbox, projectId: string, cpu?: number, memoryMb?: number): E2BSandbox {
    const meter = new SandboxMeter(this.opts.usage, {
      provider: "e2b",
      projectId,
      cpu: cpu ?? this.opts.defaultCpu ?? 2,
      memoryMb: memoryMb ?? this.opts.defaultMemoryMb ?? 512,
      rates: RATES.e2b,
    });
    return new E2BSandbox(sdk, projectId, this.snapshots, meter, this.apiKey);
  }
}

export class E2BSandbox implements Sandbox {
  readonly workdir = WORKDIR;
  readonly id: string;

  constructor(
    private sdk: E2BSdkSandbox,
    readonly projectId: string,
    private readonly snapshots: SnapshotStore,
    private readonly meter: SandboxMeter,
    private readonly apiKey: string,
  ) {
    this.id = sdk.sandboxId;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    try {
      const r = await this.sdk.commands.run(cmd, { cwd: resolveSandboxPath(opts.cwd), envs: opts.env, timeoutMs });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: Date.now() - started, timedOut: false };
    } catch (e) {
      if (e instanceof CommandExitError) return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr, durationMs: Date.now() - started, timedOut: false };
      if (e instanceof TimeoutError) return { exitCode: 124, stdout: "", stderr: e.message, durationMs: Date.now() - started, timedOut: true };
      throw new ForgeError("SANDBOX_ERROR", `e2b exec failed: ${(e as Error).message}`);
    }
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    try {
      return await this.sdk.files.read(resolveSandboxPath(path), { format: "bytes" });
    } catch (e) {
      throw new ForgeError("NOT_FOUND", `cannot read ${path}: ${(e as Error).message}`);
    }
  }

  async readFile(path: string): Promise<string> {
    return Buffer.from(await this.readFileBytes(path)).toString("utf8");
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sdk.files.write(resolveSandboxPath(path), content);
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
    const data = await this.sdk.files.read(tmp, { format: "bytes" });
    await this.exec(`rm -f ${shq(tmp)}`);
    await this.snapshots.save({ snapshotId, projectId: this.projectId, sandboxId: this.id, provider: "e2b", label }, data);
    return { snapshotId };
  }

  async restore(snapshotId: string): Promise<void> {
    const data = await this.snapshots.load(this.projectId, snapshotId);
    const tmp = `/tmp/restore-${snapshotId}.tar.gz`;
    await this.sdk.files.write(tmp, data);
    const r = await this.exec(`find ${shq(WORKDIR)} -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C ${shq(WORKDIR)} -xzf ${shq(tmp)} && rm -f ${shq(tmp)}`);
    if (r.exitCode !== 0) throw new ForgeError("SANDBOX_ERROR", `restore failed: ${r.stderr}`);
  }

  async exposePort(port: number): Promise<{ url: string }> {
    return { url: `https://${this.sdk.getHost(port)}` };
  }

  async pause(): Promise<void> {
    await this.sdk.pause();
    await this.meter.stop();
  }

  async resume(): Promise<void> {
    this.sdk = await E2BSdkSandbox.connect(this.id, { apiKey: this.apiKey });
    this.meter.start();
  }

  async destroy(): Promise<void> {
    await this.meter.stop();
    await this.sdk.kill();
  }
}
