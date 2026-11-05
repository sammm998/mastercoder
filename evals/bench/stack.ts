import { spawn, type ChildProcess } from "node:child_process";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { AppRouter } from "@forge/api";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface Stack {
  apiUrl: string;
  stop(): Promise<void>;
}

/** Env for a benchmark run: mock providers unless the caller's env sets real ones. */
export function benchEnv(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: String(port),
    API_URL: `http://127.0.0.1:${port}`,
    APP_URL: process.env.APP_URL ?? "http://localhost:3000",
    LLM_PROVIDER: process.env.LLM_PROVIDER ?? "mock",
    MEDIA_PROVIDER: process.env.MEDIA_PROVIDER ?? "mock",
    STT_PROVIDER: process.env.STT_PROVIDER ?? "mock",
    MEETING_BOT_PROVIDER: process.env.MEETING_BOT_PROVIDER ?? "mock",
    CONNECTOR_PROVIDER: process.env.CONNECTOR_PROVIDER ?? "mock",
    BILLING_PROVIDER: process.env.BILLING_PROVIDER ?? "mock",
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER ?? "mock",
    SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER ?? "local",
    DEPLOY_PROVIDER: process.env.DEPLOY_PROVIDER ?? "mock",
    DB_BRANCH_PROVIDER: process.env.DB_BRANCH_PROVIDER ?? "pgclone",
    STORAGE_PROVIDER: process.env.STORAGE_PROVIDER ?? "local",
    LOCAL_STORAGE_DIR: process.env.LOCAL_STORAGE_DIR ?? resolve(ROOT, ".data/bench-storage"),
    VAULT_MASTER_KEY: process.env.VAULT_MASTER_KEY ?? "b".repeat(64),
    STT_MOCK_FIXTURES: resolve(ROOT, "evals/speech/fixtures.json"),
    RATE_LIMIT_PER_MIN_USER: "100000",
    RATE_LIMIT_PER_MIN_IP: "100000",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
  };
}

function start(name: string, cwd: string, env: NodeJS.ProcessEnv, log: (s: string) => void): ChildProcess {
  const p = spawn("npx", ["tsx", "src/index.ts"], { cwd: resolve(ROOT, cwd), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  p.stdout?.on("data", (d: Buffer) => log(`[${name}] ${d.toString().trimEnd()}`));
  p.stderr?.on("data", (d: Buffer) => log(`[${name}] ${d.toString().trimEnd()}`));
  return p;
}

export async function startStack(opts: { port?: number; log?: (s: string) => void; workers?: number } = {}): Promise<Stack> {
  const port = opts.port ?? 4600 + Math.floor(Math.random() * 300);
  const env = benchEnv(port);
  const log = opts.log ?? (() => undefined);
  const procs = [start("api", "apps/api", env, log)];
  for (let i = 0; i < (opts.workers ?? 1); i++) procs.push(start(`worker${i}`, "apps/agent-worker", env, log));
  const apiUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${apiUrl}/health`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {
    apiUrl,
    async stop() {
      for (const p of procs) {
        try {
          if (p.pid) process.kill(-p.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    },
  };
}

export function client(apiUrl: string, token?: string) {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `${apiUrl}/trpc`, transformer: superjson, maxURLLength: 2000, maxItems: 10, headers: () => (token ? { authorization: `Bearer ${token}` } : {}) })],
  });
}
export type Client = ReturnType<typeof client>;

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1500): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
}
