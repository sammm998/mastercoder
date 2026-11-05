import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a binary with an argument array (never through a shell). Injectable for unit tests. */
export type CommandRunner = (cmd: string, args: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number }) => Promise<CommandResult>;

export const spawnRunner: CommandRunner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
