/**
 * Kit files must be real code in their target templates. Scaffolds templates + kit features into
 * temp dirs, installs real dependencies (npm/PyPI over the network) and runs each toolchain.
 * nextjs + every feature: typecheck, lint, test, drizzle generate + migrate (docker Postgres), build.
 * hono-api + server features: same, then boots the server and exercises Better Auth sign-up,
 * cron secret protection and Stripe webhook signature verification end-to-end.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { PgCloneBranchProvider, kitSupport, scaffoldWithKit, KIT_FEATURES, type KitFeature } from "../src/index.js";

const ADMIN = process.env.DATABASE_ADMIN_URL ?? "postgres://forge:forge@localhost:5432/forge";
const pg = new PgCloneBranchProvider({ adminUrl: ADMIN });
const suffix = Math.random().toString(36).slice(2, 7);
const dirs: string[] = [];
const dbs: string[] = [];
const procs: ChildProcess[] = [];

afterAll(async () => {
  for (const p of procs) p.kill("SIGTERM");
  for (const d of dbs) await pg.dropProject(d).catch(() => undefined);
  await pg.close();
  if (!process.env.KEEP_SCAFFOLDS) await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function run(cmd: string, cwd: string, env: Record<string, string> = {}, timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true, env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", ...env } });
    let out = "";
    const add = (b: Buffer) => {
      out = (out + b.toString()).slice(-200_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`\`${cmd}\` failed (${code}) in ${cwd}:\n${out.slice(-6000)}`));
    });
  });
}

async function project(templateId: string, features: KitFeature[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `forge-kit-${templateId}-`));
  dirs.push(dir);
  await scaffoldWithKit(templateId, dir, { projectName: `Kit ${templateId}` }, features);
  return dir;
}

async function freshDb(name: string): Promise<string> {
  const db = `forge_kit_${name}_${suffix}`;
  dbs.push(db);
  return pg.createDatabase(db);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

const NPM_INSTALL = "npm install --no-audit --no-fund --loglevel=error";

describe("nextjs + every kit feature", () => {
  it("installs, typechecks, lints, tests, migrates and builds", async () => {
    const features = KIT_FEATURES.filter((f) => kitSupport("nextjs")[f] === "supported");
    expect(features).toHaveLength(KIT_FEATURES.length);
    const dir = await project("nextjs", features);
    await run(NPM_INSTALL, dir);
    await run("npm run typecheck", dir);
    await run("npm run lint", dir);
    expect(await run("npm test", dir)).toMatch(/passed/);
    const url = await freshDb("next");
    expect(await run("npx drizzle-kit generate", dir)).toMatch(/cms_content/);
    await run("npx drizzle-kit migrate", dir, { DATABASE_URL: url });
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql<Array<{ t: string }>>`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`;
      expect(tables.map((r) => r.t)).toEqual(expect.arrayContaining(["account", "cms_content", "session", "user", "verification"]));
      expect(await sql`select forge_current_user_id() as u`).toEqual([{ u: null }]);
    } finally {
      await sql.end();
    }
    await run("npm run build", dir, { BETTER_AUTH_SECRET: "build-secret-build-secret-build-secret", BETTER_AUTH_URL: "http://localhost:3000" });
  });
});

function stripeSignature(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

describe("hono-api + server kit features", () => {
  it("builds, migrates, and serves auth, cron and Stripe webhooks for real", async () => {
    const dir = await project("hono-api", ["auth", "db", "email", "storage", "ai", "payments", "cron", "i18n", "observability"]);
    await run(NPM_INSTALL, dir);
    await run("npm run typecheck", dir);
    await run("npm run lint", dir);
    expect(await run("npm test", dir)).toMatch(/passed/);
    await run("npm run build", dir);
    const url = await freshDb("hono");
    await run("npx drizzle-kit generate", dir);
    await run("npx drizzle-kit migrate", dir, { DATABASE_URL: url });

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const whsec = "whsec_test_forge_kit";
    const env = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "it-secret-it-secret-it-secret-it-secret",
      BETTER_AUTH_URL: base,
      CRON_SECRET: "cron-secret-0123456789",
      STRIPE_SECRET_KEY: "sk_test_forge_kit_offline",
      STRIPE_WEBHOOK_SECRET: whsec,
      EMAIL_FROM: "Forge <noreply@forge.test>",
      SMTP_URL: "smtp://localhost:1025",
    };
    const server = spawn("node", ["dist/index.js"], { cwd: dir, env });
    procs.push(server);
    let log = "";
    server.stdout.on("data", (b: Buffer) => (log += b.toString()));
    server.stderr.on("data", (b: Buffer) => (log += b.toString()));
    for (let i = 0; i < 60; i++) {
      const ok = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect((await fetch(`${base}/health`)).status, log).toBe(200);

    // Better Auth: email + password sign-up writes the user via Drizzle and returns a session cookie.
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: `ada-${suffix}@example.eu`, password: "correct horse battery", name: "Ada" }),
    });
    expect(signUp.status, await signUp.clone().text()).toBe(200);
    const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
    const session = (await (await fetch(`${base}/api/auth/get-session`, { headers: { cookie, origin: base } })).json()) as { user?: { email: string } };
    expect(session.user?.email).toBe(`ada-${suffix}@example.eu`);
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      expect(await sql`select name from "user"`).toEqual([{ name: "Ada" }]);
    } finally {
      await sql.end();
    }

    // Cron: secret required; jobs run.
    expect((await fetch(`${base}/cron/heartbeat`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/cron/heartbeat`, { method: "POST", headers: { authorization: "Bearer wrong-secret-xxxxxxx" } })).status).toBe(401);
    const hb = await fetch(`${base}/cron/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
    expect(await hb.json()).toMatchObject({ job: "heartbeat", ok: true });
    const cleanup = await fetch(`${base}/cron/cleanup-auth`, { method: "POST", headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
    expect(await cleanup.json()).toMatchObject({ ok: true, result: { expiredSessions: 0 } });

    // Stripe webhook: forged signature rejected, correctly signed event handled.
    const event = JSON.stringify({ id: `evt_${suffix}`, object: "event", type: "checkout.session.completed", data: { object: { id: "cs_test_1", object: "checkout.session", payment_status: "paid", amount_total: 1000, currency: "eur" } } });
    expect((await fetch(`${base}/webhooks/stripe`, { method: "POST", body: event, headers: { "stripe-signature": "t=1,v1=deadbeef" } })).status).toBe(400);
    const ok = await fetch(`${base}/webhooks/stripe`, { method: "POST", body: event, headers: { "stripe-signature": stripeSignature(event, whsec) } });
    expect(await ok.json()).toEqual({ received: true, handled: true });
    expect((await fetch(`${base}/v1/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ priceId: "not-a-price" }) })).status).toBe(400);
  });
});

describe("vite-react-ts + client kit features", () => {
  it("installs, typechecks, lints, tests and builds", async () => {
    const dir = await project("vite-react-ts", ["seo", "analytics", "cookie-consent", "i18n", "observability"]);
    await run(NPM_INSTALL, dir);
    await run("npm run typecheck", dir);
    await run("npm run lint", dir);
    expect(await run("npm test", dir)).toMatch(/passed/);
    await run("npm run build", dir);
  });
});

describe("astro-site + kit features", () => {
  it("passes astro check, lint and build", async () => {
    const dir = await project("astro-site", ["seo", "analytics", "cookie-consent"]);
    await run(NPM_INSTALL, dir);
    await run("npm run typecheck", dir);
    await run("npm run lint", dir);
    await run("npm run build", dir);
  });
});

function hasPython(): boolean {
  try {
    execSync("python3 -c 'import venv, ensurepip'", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasPython())("fastapi + kit features", () => {
  it("installs with pip and passes pytest, mypy and ruff", async () => {
    const dir = await project("fastapi", ["ai", "cron", "observability"]);
    await run("python3 -m venv .venv && .venv/bin/pip install -q -r requirements-dev.txt", dir);
    await run(".venv/bin/pytest -q", dir);
    await run(".venv/bin/mypy app tests", dir);
    await run(".venv/bin/ruff check . && .venv/bin/ruff format --check .", dir);
    const probe = await run(
      `.venv/bin/python -c "from fastapi.testclient import TestClient; from app.main import create_app; c = TestClient(create_app()); print(c.post('/cron/heartbeat').status_code, c.post('/cron/heartbeat', headers={'Authorization': 'Bearer py-cron-secret-123456'}).status_code)"`,
      dir,
      { CRON_SECRET: "py-cron-secret-123456" },
    );
    expect(probe.trim().split("\n").at(-1)).toBe("401 200");
  });
});
