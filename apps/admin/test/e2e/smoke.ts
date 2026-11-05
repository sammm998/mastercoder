/**
 * End-to-end smoke test: real API (Postgres + Redis from docker compose) + built admin app + headless Chromium.
 *
 *   pnpm --filter @forge/admin test:e2e          (SMOKE_SKIP_BUILD=1 to reuse an existing build)
 *
 * Seeds clearly-labelled smoke rows (provider "smoke-<id>", abuse source "smoke-test"), drives the UI,
 * then deletes everything it created. Screenshots go to apps/admin/test-results/.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { abuseReports, connect, eq, providerHealth, sql, usageRecords, users } from "@forge/db";
import type { AppRouter } from "@forge/api";

const ADMIN_DIR = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const API_PORT = Number(process.env.SMOKE_API_PORT || 4791);
const ADMIN_PORT = Number(process.env.SMOKE_ADMIN_PORT || 3791);
const API = `http://localhost:${API_PORT}`;
const ADMIN = `http://localhost:${ADMIN_PORT}`;
const tag = Math.random().toString(36).slice(2, 8);
const provider = `smoke-${tag}`;
const procs: ChildProcess[] = [];
let failureShot: (() => Promise<void>) | null = null;

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

function run(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }): ChildProcess {
  const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  p.stderr?.on("data", (d: Buffer) => process.env.SMOKE_VERBOSE && process.stderr.write(d));
  p.stdout?.on("data", (d: Buffer) => process.env.SMOKE_VERBOSE && process.stdout.write(d));
  procs.push(p);
  return p;
}

async function exec(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) {
  const p = run(cmd, args, opts);
  const code = await new Promise<number>((r) => p.on("close", (c) => r(c ?? 1)));
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${code}`);
}

async function waitFor(url: string, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok - ${msg}`);
}

async function main() {
  const h = connect(undefined, 2);
  const created = { users: [] as string[], usage: [] as string[], health: [] as string[], abuse: [] as string[] };
  try {
    console.log("starting API on", API);
    run("pnpm", ["--filter", "@forge/api", "start"], { cwd: ROOT, env: { API_PORT: String(API_PORT), ADMIN_URL: ADMIN, LLM_PROVIDER: "mock" } });
    if (!process.env.SMOKE_SKIP_BUILD) {
      console.log("building admin (NEXT_PUBLIC_API_URL baked in)");
      await exec("npx", ["next", "build"], { cwd: ADMIN_DIR, env: { NEXT_PUBLIC_API_URL: API, NEXT_TELEMETRY_DISABLED: "1" } });
    }
    run("npx", ["next", "start", "--port", String(ADMIN_PORT)], { cwd: ADMIN_DIR });
    await waitFor(`${API}/health`);
    await waitFor(ADMIN);

    // Accounts: one admin, one regular user.
    const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: `${API}/trpc`, transformer: superjson })] });
    const password = `Smoke-${tag}-correct-horse-battery`;
    const adminEmail = `smoke-admin-${tag}@example.test`;
    const userEmail = `smoke-user-${tag}@example.test`;
    for (const email of [adminEmail, userEmail]) {
      const r = await client.auth.signup.mutate({ email, password, name: "Smoke", locale: "en", elapsedMs: 5000 });
      created.users.push(r.user.id);
    }
    await h.db.update(users).set({ isAdmin: true }).where(eq(users.email, adminEmail));

    // Seed: 7 days at $1 then $5 today for a smoke provider → spike; a failing health check; an open abuse report.
    const now = new Date();
    for (let i = 7; i >= 0; i--) {
      const at = i === 0 ? new Date(now.getTime() - 60_000) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i, 12));
      const id = `use_smoke_${tag}_${i}`;
      created.usage.push(id);
      await h.db.insert(usageRecords).values({ id, kind: "llm", quantity: 1, costUsd: i === 0 ? 5 : 1, provider, at });
    }
    const hid = `ph_smoke_${tag}`;
    created.health.push(hid);
    await h.db.insert(providerHealth).values({ id: hid, provider, kind: "llm", ok: false, latencyMs: 1234, error: "smoke: HTTP 503" });
    const aid = `abr_smoke_${tag}`;
    created.abuse.push(aid);
    await h.db.insert(abuseReports).values({ id: aid, source: "smoke-test", category: "phishing", evidence: { url: `https://phish-${tag}.example/login`, score: 0.99 } });

    const require = createRequire(import.meta.url);
    const { chromium } = require("playwright") as typeof import("playwright");
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const shots = `${ADMIN_DIR}test-results`;
    mkdirSync(shots, { recursive: true });
    page.on("console", (m) => process.env.SMOKE_VERBOSE && console.log("[browser]", m.type(), m.text()));
    failureShot = () => page.screenshot({ path: `${shots}/failure.png`, fullPage: true }).then(() => undefined);

    console.log("non-admin sees the admins-only state");
    await page.goto(ADMIN);
    await page.getByLabel("Email").fill(userEmail);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Admins only" }).waitFor();
    check(true, "admins-only notice shown for regular user");
    await page.getByRole("button", { name: "Sign out" }).click();

    console.log("admin flows");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Overview" }).waitFor();
    await page.getByText("Open abuse reports").first().waitFor();
    check(true, "overview stats render");
    await page.screenshot({ path: `${shots}/overview.png`, fullPage: true });

    await page.getByRole("link", { name: "Costs" }).click();
    await page.getByRole("heading", { name: "Spike check" }).waitFor();
    await page.getByText(`${provider}:`).waitFor();
    check(true, "smoke provider flagged as spiking");
    check(await page.locator('svg[role="img"]').count() === 1, "stacked cost chart rendered");
    await page.locator('svg[role="img"]').focus();
    await page.keyboard.press("End");
    check(await page.locator(".tooltip").isVisible(), "keyboard navigation shows tooltip");
    await page.screenshot({ path: `${shots}/costs.png`, fullPage: true });

    await page.getByRole("link", { name: "Provider health" }).click();
    const row = page.getByRole("row").filter({ hasText: provider });
    await row.waitFor();
    await row.getByText("Failing").waitFor();
    check(await row.evaluate((el) => el.classList.contains("row-critical")), "failing provider shown red with label");
    await page.screenshot({ path: `${shots}/providers.png`, fullPage: true });

    await page.getByRole("link", { name: "Users" }).click();
    await page.getByLabel("Search by email").fill(`smoke-admin-${tag}`);
    await page.getByRole("cell", { name: new RegExp(adminEmail) }).waitFor();
    check(true, "user search finds the admin");

    await page.getByRole("link", { name: /Abuse queue/ }).click();
    await page.getByRole("button", { name: `phishing ${aid}` }).click();
    await page.getByText(`https://phish-${tag}.example/login`).first().waitFor();
    check(true, "evidence view shows extracted link");
    await page.screenshot({ path: `${shots}/abuse.png`, fullPage: true });
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByText("Report dismissed.").waitFor();
    const [after] = await h.db.select().from(abuseReports).where(eq(abuseReports.id, aid));
    check(after?.status === "dismissed", "resolveAbuse persisted the dismissal");

    await browser.close();
    console.log("smoke passed");
  } catch (e) {
    await failureShot?.().catch(() => undefined);
    throw e;
  } finally {
    for (const id of created.usage) await h.db.delete(usageRecords).where(eq(usageRecords.id, id));
    for (const id of created.health) await h.db.delete(providerHealth).where(eq(providerHealth.id, id));
    for (const id of created.abuse) await h.db.delete(abuseReports).where(eq(abuseReports.id, id));
    // Users cascade to sessions/memberships; their personal workspaces are removed too.
    for (const id of created.users) {
      await h.db.execute(sql`delete from workspaces where id in (select workspace_id from memberships where user_id = ${id})`);
      await h.db.delete(users).where(eq(users.id, id));
    }
    await h.close();
    killAll("SIGTERM");
  }
}

main().catch((e: unknown) => {
  console.error(e);
  killAll("SIGKILL");
  process.exit(1);
});
