/**
 * Web smoke test of the Expo app (react-native-web build) against the real API + Postgres/Redis, in headless
 * Chromium at phone size. Native-only features (microphone streaming, file-system chunk reads, Expo Go
 * deep links) cannot run here; their pure logic is covered by the vitest unit tests.
 *
 *   pnpm --filter @forge/mobile test:e2e      (SMOKE_SKIP_BUILD=1 to reuse dist/)
 *
 * Seeds a user, a project and clearly-labelled event rows ("smoke" ids), drives sign-in → projects → chat
 * (history + live WebSocket) → preview → meetings → settings (language switch), then deletes what it created.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { connect, eq, events, sql, users } from "@forge/db";
import type { AppRouter } from "@forge/api";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const API_PORT = Number(process.env.SMOKE_API_PORT || 4792);
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT || 8792);
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const tag = Math.random().toString(36).slice(2, 8);
const procs: ChildProcess[] = [];

/** Children run in their own process group (detached) so pnpm/npx wrappers and their servers die together. */
function killAll(signal: NodeJS.Signals) {
  for (const p of procs) {
    try {
      if (p.pid) process.kill(-p.pid, signal);
    } catch {
      /* already exited */
    }
  }
}

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  if (process.env.SMOKE_VERBOSE) {
    p.stdout?.pipe(process.stdout);
    p.stderr?.pipe(process.stderr);
  }
  procs.push(p);
  return p;
}
const exited = (p: ChildProcess) => new Promise<number>((r) => p.on("close", (c) => r(c ?? 1)));

async function waitFor(url: string, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok - ${msg}`);
}

/** Static server for dist/ with SPA fallback (web.output = "single"). */
function serveDist(dir: string, port: number) {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".ttf": "font/ttf" };
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/")).replace(/^(\.\.[/\\])+/, "");
    let file = join(dir, path);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html");
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  server.listen(port);
  return server;
}

async function main() {
  const h = connect(undefined, 2);
  let userId: string | null = null;
  let server: ReturnType<typeof serveDist> | null = null;
  try {
    run("pnpm", ["--filter", "@forge/api", "start"], ROOT, { API_PORT: String(API_PORT), LLM_PROVIDER: "mock" });
    if (!process.env.SMOKE_SKIP_BUILD) {
      console.log("exporting web bundle (EXPO_PUBLIC_API_URL baked in)…");
      const code = await exited(run("npx", ["expo", "export", "--platform", "web", "--output-dir", "dist"], APP_DIR, { EXPO_PUBLIC_API_URL: API, CI: "1", EXPO_NO_TELEMETRY: "1" }));
      if (code !== 0) throw new Error("expo export failed");
    }
    server = serveDist(join(APP_DIR, "dist"), WEB_PORT);
    await waitFor(`${API}/health`);

    const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: `${API}/trpc`, transformer: superjson })] });
    const email = `smoke-mobile-${tag}@example.test`;
    const password = `Smoke-${tag}-correct-horse`;
    const s = await client.auth.signup.mutate({ email, password, name: "Smoke", locale: "en", elapsedMs: 5000 });
    userId = s.user.id;
    const authed = createTRPCClient<AppRouter>({ links: [httpLink({ url: `${API}/trpc`, transformer: superjson, headers: { authorization: `Bearer ${s.token}` } })] });
    const projectName = `Smoke booking ${tag}`;
    const project = { ...(await authed.project.create.mutate({ workspaceId: s.workspaceId, name: projectName })), name: projectName };

    // Event history as a worker would have published it (persisted payload = full ForgeEvent).
    const base = Date.now() - 60_000;
    const evs = [
      { type: "intent.classified", taskId: "tsk_smoke", intents: [{ kind: "app", confidence: 0.92, summary: "booking app" }] },
      { type: "cost.estimate", taskId: "tsk_smoke", lowUsd: 0.4, highUsd: 1.2, breakdown: [{ label: "build", usd: 0.8 }] },
      { type: "phase.started", taskId: "tsk_smoke", phase: "build" },
      { type: "checkpoint.created", taskId: "tsk_smoke", checkpointId: "cp_smoke", commit: "a1b2c3d4e5f6", label: "Scaffold" },
      { type: "preview.ready", taskId: "tsk_smoke", url: `${WEB}/smoke-preview.html` },
      { type: "task.completed", taskId: "tsk_smoke", summary: "Booking app ready with calendar and payments.", chargedUsd: 0.93 },
    ];
    for (const [i, e] of evs.entries()) {
      const id = `evt_smoke_${tag}_${i}`;
      const at = new Date(base + i * 1000).toISOString();
      await h.db.insert(events).values({ id, projectId: project.id, taskId: "tsk_smoke", type: e.type, payload: { ...e, id, projectId: project.id, at }, at: new Date(at) });
    }

    const require = createRequire(import.meta.url);
    const { chromium } = require("playwright") as typeof import("playwright");
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "en-US" });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const shots = join(APP_DIR, "test-results");
    mkdirSync(shots, { recursive: true });

    await page.goto(WEB);
    await page.getByText("Say it. Forge builds it.").waitFor();
    await page.screenshot({ path: join(shots, "01-sign-in.png") });
    check(true, "sign-in screen renders");

    await page.getByLabel("Email").first().fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText(project.name).waitFor();
    await page.screenshot({ path: join(shots, "02-projects.png") });
    check(true, "projects list shows the project after password sign-in");

    await page.getByRole("button", { name: `Open project ${project.name}` }).click();
    await page.getByText("Booking app ready with calendar and payments.").waitFor();
    check(await page.getByText("Checkpoint: Scaffold").isVisible(), "chat renders event history (checkpoint, result)");
    await page.getByText("Live", { exact: true }).waitFor({ timeout: 15_000 });
    check(true, "live WebSocket connected (/ws/events with ?token=)");

    // Live event over Redis pub/sub → WebSocket: a comment publishes a system message to the project stream.
    await authed.project.addComment.mutate({ projectId: project.id, body: `live-${tag}` });
    await page.getByText(new RegExp(`live-${tag}`)).waitFor({ timeout: 15_000 });
    check(true, "live event arrives over the WebSocket");

    // Sending a prompt: this server has no intent router wired, so the API answers PRECONDITION_FAILED.
    await page.getByLabel("Describe what to build or change…").fill("Add a dark mode");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText(/isn't fully configured|Intent router/).waitFor({ timeout: 15_000 });
    check(true, "task.create error from the API is shown to the user");
    await page.screenshot({ path: join(shots, "03-chat.png") });

    await page.getByRole("button", { name: "Open preview" }).click();
    await page.getByText("Reload").waitFor();
    check((await page.locator("iframe").count()) === 1, "web preview renders in an iframe (WebView on native)");
    await page.screenshot({ path: join(shots, "04-preview.png") });

    await page.goto(`${WEB}/meetings`);
    await page.getByText("Record a meeting").first().waitFor();
    await page.screenshot({ path: join(shots, "05-meetings.png") });
    check(true, "meetings screen renders");

    await page.goto(`${WEB}/meetings/record`);
    await page.getByText("Tell everyone first").waitFor();
    await page.screenshot({ path: join(shots, "06-record.png") });
    check(true, "record screen shows the consent notice");

    await page.goto(`${WEB}/settings`);
    await page.getByRole("button", { name: "Svenska" }).click();
    await page.getByText("Appens språk").waitFor();
    await page.screenshot({ path: join(shots, "07-settings-sv.png") });
    check(true, "switching to Swedish re-renders the UI in Swedish");

    check(errors.length === 0, `no uncaught page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await browser.close();
    console.log("mobile web smoke passed");
  } finally {
    if (userId) {
      await h.db.execute(sql`delete from events where id like ${`evt_smoke_${tag}_%`}`);
      await h.db.execute(sql`delete from workspaces where id in (select workspace_id from memberships where user_id = ${userId})`);
      await h.db.delete(users).where(eq(users.id, userId));
    }
    void events;
    await h.close();
    server?.close();
    killAll("SIGTERM");
  }
}

main().catch((e: unknown) => {
  console.error(e);
  killAll("SIGKILL");
  process.exit(1);
});
