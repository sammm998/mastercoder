import { posix } from "node:path";
import { ForgeError } from "@forge/shared";
import { WORKDIR, type ListFilesOptions } from "./types.js";

/** POSIX single-quote a string for `sh -c`. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Resolve a sandbox path: relative paths are relative to /workspace. */
export function resolveSandboxPath(p: string | undefined, workdir = WORKDIR): string {
  if (!p || p === ".") return workdir;
  if (p.includes("\0")) throw new ForgeError("BAD_INPUT", "path contains NUL");
  return posix.resolve(workdir, p);
}

const SAFE_NAME = /^[A-Za-z0-9._@+-]+$/;

/** Shell command that lists files under `abs`; parse its output with `parseListOutput`. */
export function listFilesCommand(abs: string, opts: ListFilesOptions = {}): string {
  const exclude = (opts.exclude ?? []).filter((e) => SAFE_NAME.test(e));
  if (opts.recursive) {
    const prune = exclude.length
      ? `\\( -type d \\( ${exclude.map((e) => `-name ${shq(e)}`).join(" -o ")} \\) \\) -prune -o `
      : "";
    return `find ${shq(abs)} ${prune}-type f -print`;
  }
  return (
    `cd ${shq(abs)} && for f in * .[!.]* ..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; ` +
    `if [ -d "$f" ]; then printf '%s/\\n' "$f"; else printf '%s\\n' "$f"; fi; done`
  );
}

export function parseListOutput(abs: string, stdout: string, opts: ListFilesOptions = {}): string[] {
  const exclude = new Set(opts.exclude ?? []);
  const lines = stdout.split("\n").filter(Boolean);
  const prefix = abs.endsWith("/") ? abs : abs + "/";
  const out = opts.recursive ? lines.map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l)) : lines;
  return out.filter((l) => !exclude.has(l.replace(/\/$/, ""))).sort();
}

/** Wrap a command with coreutils/busybox `timeout` so the in-sandbox process dies when the deadline passes. */
export function withTimeout(cmd: string, timeoutMs: number): string[] {
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  return ["timeout", "-s", "KILL", String(secs), "sh", "-c", cmd];
}

export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

/** True when an exit code from `timeout -s KILL` means the deadline fired. */
export function looksTimedOut(exitCode: number, durationMs: number, timeoutMs: number): boolean {
  return (exitCode === 124 || exitCode === 137) && durationMs >= timeoutMs * 0.9;
}
