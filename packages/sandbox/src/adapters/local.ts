/**
 * LocalSandboxProvider — FOR TESTS ONLY. NO ISOLATION: commands run on the host as the current user, in a
 * temp directory, with full network access. Used as a fast fixture runner (e.g. by quality-gates tests).
 * Never select it for untrusted code (SANDBOX_PROVIDER=local|mock).
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { ForgeError, newId, type UsageSink } from "@forge/shared";
import { SandboxMeter, RATES } from "../metering.js";
import { defaultSnapshotStore, type SnapshotStore } from "../snapshots.js";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../shell.js";
import { parseSpec, WORKDIR, type ExecOptions, type ExecResult, type ListFilesOptions, type Sandbox, type SandboxProvider, type SandboxSpec } from "../types.js";

export interface LocalSandboxProviderOptions {
  snapshotStore?: SnapshotStore;
  usage?: UsageSink;
  /** Parent dir for sandbox roots (default os.tmpdir()). */
  root?: string;
  /** Extra env passed to every command (PATH/HOME/LANG from the host are always passed). */
  env?: Record<string, string>;
}

const registry = new Map<string, LocalSandbox>();

export class LocalSandboxProvider implements SandboxProvider {
  readonly name: string = "local";
  /** Not a real sandbox: no isolation. */
  readonly isMock = true;
  readonly snapshots: SnapshotStore;

  constructor(readonly options: LocalSandboxProviderOptions = {}) {
    this.snapshots = options.snapshotStore ?? defaultSnapshotStore();
  }

  async create(input: SandboxSpec): Promise<LocalSandbox> {
    const spec = parseSpec(input);
    const dir = await mkdtemp(join(this.options.root ?? tmpdir(), "forge-local-sbx-"));
    const id = newId("lsbx");
    const meter = new SandboxMeter(this.options.usage, { provider: this.name, projectId: spec.projectId, cpu: spec.cpu ?? 1, memoryMb: spec.memoryMb ?? 1024, rates: RATES.local });
    const sb = new LocalSandbox(id, spec.projectId, dir, { ...this.options.env, ...spec.env }, this.snapshots, meter, this.name);
    registry.set(id, sb);
    return sb;
  }

  async get(id: string): Promise<Sandbox | null> {
    return registry.get(id) ?? null;
  }
}

/** Alias selected by SANDBOX_PROVIDER=mock (same behaviour: local temp dir, no isolation). */
export class MockSandboxProvider extends LocalSandboxProvider {
  override readonly name: string = "mock";
}

export class LocalSandbox implements Sandbox {
  readonly workdir = WORKDIR;
  private readonly groups = new Set<number>();
  private paused = false;
  private destroyed = false;

  constructor(
    readonly id: string,
    readonly projectId: string,
    /** Host directory backing /workspace. */
    readonly hostDir: string,
    private readonly env: Record<string, string>,
    private readonly snapshots: SnapshotStore,
    private readonly meter: SandboxMeter,
    private readonly providerName: string,
  ) {}

  /** Map a sandbox path ("/workspace/x" or "x") to the host dir; reject anything outside /workspace. */
  hostPath(p?: string): string {
    const abs = posix.resolve(WORKDIR, p && p !== "." ? p : WORKDIR);
    if (abs !== WORKDIR && !abs.startsWith(WORKDIR + "/")) throw new ForgeError("BAD_INPUT", `local sandbox only exposes ${WORKDIR}: ${p}`);
    const host = join(this.hostDir, abs.slice(WORKDIR.length));
    const rel = relative(this.hostDir, host);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) throw new ForgeError("BAD_INPUT", "path escape");
    return host;
  }

  private check(): void {
    if (this.destroyed) throw new ForgeError("SANDBOX_ERROR", `sandbox ${this.id} was destroyed`);
    if (this.paused) throw new ForgeError("SANDBOX_ERROR", `sandbox ${this.id} is paused`);
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.check();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const cwd = this.hostPath(opts.cwd);
    const started = Date.now();
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: this.hostDir,
      LANG: process.env.LANG ?? "C.UTF-8",
      FORGE_WORKSPACE: this.hostDir,
      ...this.env,
      ...(opts.env ?? {}),
    };
    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const pid = child.pid;
      if (pid) this.groups.add(pid);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new ForgeError("SANDBOX_ERROR", e.message));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (pid) this.groups.delete(pid);
        resolve({ exitCode: code ?? (signal ? 128 + 9 : 1), stdout, stderr, durationMs: Date.now() - started, timedOut });
      });
    });
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    this.check();
    try {
      return new Uint8Array(await readFile(this.hostPath(path)));
    } catch (e) {
      throw new ForgeError("NOT_FOUND", `cannot read ${path}: ${(e as Error).message}`);
    }
  }

  async readFile(path: string): Promise<string> {
    return Buffer.from(await this.readFileBytes(path)).toString("utf8");
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.check();
    const p = this.hostPath(path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }

  async listFiles(dir?: string, opts: ListFilesOptions = {}): Promise<string[]> {
    this.check();
    const root = this.hostPath(dir);
    const exclude = new Set(opts.exclude ?? []);
    const out: string[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch (e) {
        if (!rel) throw new ForgeError("NOT_FOUND", `cannot list ${dir ?? WORKDIR}: ${(e as Error).message}`);
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (exclude.has(e.name)) continue;
          if (opts.recursive) await walk(join(abs, e.name), r);
          else out.push(`${r}/`);
        } else out.push(r);
      }
    };
    await walk(root, "");
    return out.sort();
  }

  async snapshot(label?: string): Promise<{ snapshotId: string }> {
    this.check();
    const r = await this.hostTar(["-C", this.hostDir, "-czf", "-", "."]);
    const snapshotId = this.snapshots.newId();
    await this.snapshots.save({ snapshotId, projectId: this.projectId, sandboxId: this.id, provider: this.providerName, label }, r);
    return { snapshotId };
  }

  async restore(snapshotId: string): Promise<void> {
    this.check();
    const data = await this.snapshots.load(this.projectId, snapshotId);
    for (const e of await readdir(this.hostDir)) await rm(join(this.hostDir, e), { recursive: true, force: true });
    await this.hostTar(["-C", this.hostDir, "-xzf", "-"], data);
  }

  private hostTar(args: string[], input?: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn("tar", args, { stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new ForgeError("SANDBOX_ERROR", `tar failed: ${err}`))));
      child.stdin.end(input ? Buffer.from(input) : undefined);
    });
  }

  async exposePort(port: number): Promise<{ url: string }> {
    this.check();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ForgeError("BAD_INPUT", `invalid port ${port}`);
    return { url: `http://127.0.0.1:${port}` };
  }

  private signalAll(sig: NodeJS.Signals): void {
    for (const pid of this.groups) {
      try {
        process.kill(-pid, sig);
      } catch {
        this.groups.delete(pid);
      }
    }
  }

  async pause(): Promise<void> {
    this.check();
    this.signalAll("SIGSTOP");
    this.paused = true;
    await this.meter.stop();
  }

  async resume(): Promise<void> {
    if (this.destroyed) throw new ForgeError("SANDBOX_ERROR", `sandbox ${this.id} was destroyed`);
    this.signalAll("SIGCONT");
    this.paused = false;
    this.meter.start();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.signalAll("SIGKILL");
    this.destroyed = true;
    registry.delete(this.id);
    await this.meter.stop();
    await rm(this.hostDir, { recursive: true, force: true });
  }
}
