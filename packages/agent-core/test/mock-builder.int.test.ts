/**
 * End-to-end: the real BuildAgent with MockLLMProvider (rule-based planner + mock builder), real
 * @forge/templates scaffolds (+ app-kit auth/db for auth specs), LocalSandboxProvider (npm install over
 * the network) and real @forge/quality-gates runGates. The dev server preview is started for real and
 * killed afterwards. e2e / lighthouse / visual-qa gates are not run here (no browser harness).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MockLLMProvider } from "@forge/llm";
import { EventBus, MemoryUsageSink, type IntentKind } from "@forge/shared";
import { LocalSandboxProvider, type Sandbox } from "@forge/sandbox";
import { runGates, GATE_NAMES, type GateName } from "@forge/quality-gates";
import { getManifest, scaffold, selectTemplate, type TemplateVars } from "@forge/templates";
import { kitFilesFor } from "@forge/app-kit";
import { BuildAgent, MOCK_BUILDER_HEADER, mockPlan, type AgentDeps, type GatesPort, type TemplatesPort } from "../src/index.js";

const GATES: GateName[] = GATE_NAMES.filter((g) => !["e2e", "lighthouse", "visual-qa"].includes(g));
const previewGroups: number[] = [];
const timings: Array<{ name: string; seconds: number; fixIterations: number; gates: string }> = [];

/** Track the process group of the backgrounded dev server so it can be killed after the test. */
function trackPreview(sb: Sandbox): Sandbox {
  const exec = sb.exec.bind(sb);
  sb.exec = async (cmd, opts) => {
    if (!cmd.startsWith("nohup ")) return exec(cmd, opts);
    const r = await exec(`${cmd}\necho "FORGE_PGID=$$"`, opts);
    const pgid = Number(/FORGE_PGID=(\d+)/.exec(r.stdout)?.[1]);
    if (pgid) previewGroups.push(pgid);
    return r;
  };
  return sb;
}

function templatesPort(features: Array<"auth" | "db">): TemplatesPort {
  return {
    select: (kind, hint) => selectTemplate(kind as IntentKind, hint),
    manifest: (id) => getManifest(id),
    scaffold: async (id, writer, vars) => {
      const res = await scaffold(id, writer, vars as TemplateVars);
      if (!features.length) return res.files;
      const kit = kitFilesFor(id, features, { vars: vars as TemplateVars });
      for (const [p, c] of Object.entries(kit)) await writer.writeFile(p, c);
      return [...new Set([...res.files, ...Object.keys(kit)])];
    },
  };
}

const gatesPort: GatesPort = {
  run: (sandbox, opts) => runGates(sandbox as Sandbox, { ...opts, gates: GATES, commandTimeoutMs: 600_000 }),
};

/**
 * LocalSandbox runs with HOME = its temp dir and only PATH/HOME/LANG from the host, so pass the host's
 * proxy / CA settings and npm user config + cache explicitly (npm install needs the network).
 */
function hostNetworkEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /proxy|^npm_config_|^NODE_EXTRA_CA_CERTS$|^SSL_CERT_FILE$|^REQUESTS_CA_BUNDLE$|^PIP_/i.test(k)) env[k] = v;
  const home = process.env.HOME;
  if (home) {
    if (existsSync(join(home, ".npmrc"))) env.npm_config_userconfig ??= join(home, ".npmrc");
    env.npm_config_cache ??= join(home, ".npm");
  }
  return env;
}

async function build(name: string, prompt: string, kind: IntentKind, hint?: string) {
  const template = selectTemplate(kind, hint);
  const planned = mockPlan(prompt, kind as "app", template);
  const provider = new LocalSandboxProvider({ env: hostNetworkEnv() });
  const sandbox = trackPreview(await provider.create({ projectId: `prj_${name}` }));
  const bus = new EventBus();
  const llm = new MockLLMProvider();
  const deps: AgentDeps = { llm, events: bus, usage: new MemoryUsageSink(), sandbox, templates: templatesPort(planned.auth ? ["auth", "db"] : []), gates: gatesPort };
  const started = Date.now();
  const outcome = await new BuildAgent(deps, { maxFixIterations: 3 }).run({
    taskId: `tsk_${name}`,
    projectId: `prj_${name}`,
    workspaceId: "ws_test",
    prompt,
    intents: [{ kind, confidence: 0.9, summary: prompt, hint }],
    planMode: false,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const results = outcome.gateReport?.results ?? [];
  timings.push({ name, seconds, fixIterations: outcome.fixIterations, gates: results.map((r) => `${r.gate}:${r.skipped ? "skip" : r.passed ? "pass" : "FAIL"}`).join(" ") });
  const replies = bus.ofType("message").filter((m) => m.role === "assistant").map((m) => m.text);
  return { outcome, sandbox, replies, template, llm };
}

function killPreviews(): void {
  for (const g of previewGroups.splice(0)) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      // already exited
    }
  }
}

/** Stop the dev server first (it keeps writing .next/ or node_modules/.vite), then remove the sandbox. */
async function cleanup(sb: Sandbox): Promise<void> {
  killPreviews();
  for (let i = 0; i < 5; i++) {
    try {
      await sb.destroy();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

afterAll(() => {
  killPreviews();
  console.log(`mock builder e2e timings:\n${timings.map((t) => `  ${t.name}: ${t.seconds}s, fix iterations ${t.fixIterations}, ${t.gates}`).join("\n")}`);
});

describe("mock builder end-to-end (BuildAgent + templates + LocalSandbox + quality gates)", () => {
  it("salon booking: Next.js + Better Auth + Drizzle RLS + no double booking", async () => {
    const { outcome, sandbox, replies, template } = await build("salon", "Build a booking system for a hair salon where customers book a stylist", "app");
    expect(template).toBe("nextjs");
    if (outcome.status !== "succeeded") console.error(outcome.reason, JSON.stringify(outcome.gateReport?.blockers, null, 2), replies.join("\n---\n"));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.gateReport?.blockers).toEqual([]);
    for (const g of ["typecheck", "lint", "unit", "rls", "auth", "validation", "client-secrets"]) expect(outcome.gateReport?.results.find((r) => r.gate === g)?.passed).toBe(true);
    const files = await sandbox.listFiles("drizzle");
    expect(files.some((f) => /0001_app\.sql$/.test(f))).toBe(true);
    const migration = await sandbox.readFile(`drizzle/${files.find((f) => /booking_rules\.sql$/.test(f))}`);
    expect(migration).toMatch(/EXCLUDE USING gist/);
    expect(await sandbox.readFile("src/app/bookings/actions.ts")).toContain(MOCK_BUILDER_HEADER);
    expect(replies.some((r) => r.includes(MOCK_BUILDER_HEADER))).toBe(true);
    await cleanup(sandbox);
  }, 1_800_000);

  it("CSV dashboard: Vite + React with CSV parsing and SVG charts", async () => {
    const { outcome, sandbox, replies, template } = await build("csv", "Build a dashboard where I upload a CSV of sales and see revenue per month and top products", "app", "dashboard");
    expect(template).toBe("vite-react-ts");
    if (outcome.status !== "succeeded") console.error(outcome.reason, JSON.stringify(outcome.gateReport?.blockers, null, 2), replies.join("\n---\n"));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.gateReport?.blockers).toEqual([]);
    expect(await sandbox.readFile("public/sample-sales.csv")).toMatch(/^date,product,quantity,revenue\n/);
    expect(await sandbox.readFile("src/components/sales-dashboard.tsx")).toContain("sample data (fictional)");
    await cleanup(sandbox);
  }, 1_800_000);

  it("inventory: Hono API with zod validation, OpenAPI and public-route markers", async () => {
    const { outcome, sandbox, replies, template } = await build("inventory", "Build a REST API for an inventory of items with CRUD and validation", "backend");
    expect(template).toBe("hono-api");
    if (outcome.status !== "succeeded") console.error(outcome.reason, JSON.stringify(outcome.gateReport?.blockers, null, 2), replies.join("\n---\n"));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.gateReport?.blockers).toEqual([]);
    expect(await sandbox.readFile("src/routes/items.ts")).toMatch(/^\/\/ forge:public/);
    await cleanup(sandbox);
  }, 1_800_000);
});
