import { z } from "zod";

/** Contract from BUILD_PLAN.md (extend, don't break). */
export interface SandboxSpec {
  projectId: string;
  image?: string;
  /** vCPUs. */
  cpu?: number;
  memoryMb?: number;
  /** Max lifetime of the sandbox in seconds (the sandbox stops itself afterwards). */
  timeoutSec?: number;
  /** Extra hosts (beyond SANDBOX_EGRESS_ALLOWLIST) the sandbox may reach through the egress proxy. */
  egressAllowlist?: string[];
  env?: Record<string, string>;
  template?: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ListFilesOptions {
  recursive?: boolean;
  /** Directory names to prune while walking (e.g. ["node_modules", ".git"]). Extension. */
  exclude?: string[];
}

export interface Sandbox {
  readonly id: string;
  readonly projectId: string;
  /** Always "/workspace". */
  readonly workdir: string;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /**
   * Paths relative to `dir` (default: workdir). Recursive listings return files only; non-recursive listings
   * return files and directories, directories suffixed with "/".
   */
  listFiles(dir?: string, opts?: ListFilesOptions): Promise<string[]>;
  snapshot(label?: string): Promise<{ snapshotId: string }>;
  restore(snapshotId: string): Promise<void>;
  exposePort(port: number): Promise<{ url: string }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  readonly isMock: boolean;
  create(spec: SandboxSpec): Promise<Sandbox>;
  get(id: string): Promise<Sandbox | null>;
}

export const WORKDIR = "/workspace";

/** Hostname or wildcard (`*.example.com`), optionally with `:port`. */
const hostEntry = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/i, "egress allowlist entries must be host, *.host or host:port");

export const SandboxSpecSchema = z.object({
  projectId: z.string().min(1).max(128),
  image: z.string().min(1).max(256).optional(),
  cpu: z.number().positive().max(64).optional(),
  memoryMb: z.number().int().min(64).max(262144).optional(),
  timeoutSec: z.number().int().positive().max(7 * 24 * 3600).optional(),
  egressAllowlist: z.array(hostEntry).max(256).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  template: z.string().min(1).max(256).optional(),
});

export function parseSpec(spec: SandboxSpec): SandboxSpec {
  return SandboxSpecSchema.parse(spec);
}
