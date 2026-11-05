import { spawn } from "node:child_process";
import { ForgeError } from "@forge/shared";

export interface DockerRunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface DockerRunOptions {
  input?: Buffer | string;
  timeoutMs?: number;
  /** Max bytes of stdout kept (default 512 MiB). */
  maxStdout?: number;
}

/** Run the docker CLI (no shell; args passed as argv). */
export function dockerRaw(args: string[], opts: DockerRunOptions = {}, bin = process.env.DOCKER_BIN || "docker"): Promise<DockerRunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outLen = 0;
    const maxOut = opts.maxStdout ?? 512 * 1024 * 1024;
    let err = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d: Buffer) => {
      if (outLen < maxOut) {
        out.push(d);
        outLen += d.length;
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 1_000_000) err += d.toString("utf8");
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new ForgeError("SANDBOX_ERROR", `docker CLI not runnable: ${e.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (timedOut ? 137 : 1), stdout: Buffer.concat(out), stderr: err, timedOut, durationMs: Date.now() - started });
    });
    child.stdin.on("error", () => undefined);
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run docker and throw ForgeError(SANDBOX_ERROR) on non-zero exit. Returns trimmed stdout text. */
export async function docker(args: string[], opts: DockerRunOptions = {}): Promise<string> {
  const r = await dockerRaw(args, opts);
  if (r.code !== 0) {
    throw new ForgeError("SANDBOX_ERROR", `docker ${args[0]} failed (${r.code}): ${r.stderr.trim().slice(0, 500)}`, {
      args: args.slice(0, 2),
    });
  }
  return r.stdout.toString("utf8").trim();
}

export async function dockerJson<T>(args: string[]): Promise<T> {
  const text = await docker(args);
  return JSON.parse(text) as T;
}

/** docker inspect that returns null when the object does not exist. */
export async function inspectOrNull<T>(kind: "container" | "network" | "image", name: string): Promise<T | null> {
  const r = await dockerRaw([kind, "inspect", name]);
  if (r.code !== 0) return null;
  const arr = JSON.parse(r.stdout.toString("utf8")) as T[];
  return arr[0] ?? null;
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  State: { Status: string; Running: boolean; Paused: boolean; StartedAt: string };
  Config: { Labels: Record<string, string> | null; Image: string; Env: string[] | null; User: string };
  HostConfig: {
    NanoCpus: number;
    Memory: number;
    MemorySwap: number;
    PidsLimit: number | null;
    CapDrop: string[] | null;
    SecurityOpt: string[] | null;
    Tmpfs: Record<string, string> | null;
    Init: boolean | null;
    NetworkMode: string;
  };
  NetworkSettings: { Networks: Record<string, { IPAddress: string; NetworkID: string; Aliases: string[] | null }>; Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | null };
}

export interface NetworkInspect {
  Name: string;
  Id: string;
  Internal: boolean;
  Labels: Record<string, string> | null;
  IPAM: { Config: Array<{ Subnet?: string; Gateway?: string }> | null };
  Containers: Record<string, { Name: string; IPv4Address: string }> | null;
}

/** Make a docker-safe name fragment from an arbitrary id (lowercase, [a-z0-9_.-], max 40 chars + hash). */
export function safeName(id: string): string {
  const base = id.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-.]+/, "").slice(0, 40).replace(/-+$/, "") || "x";
  if (base === id) return base;
  let h = 0;
  for (const ch of id) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return `${base}-${h.toString(36)}`;
}
