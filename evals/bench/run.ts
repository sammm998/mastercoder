import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { CASES, type CaseResult } from "./cases.js";
import { ROOT, client, startStack } from "./stack.js";

/**
 * Forge benchmark runner (evals/benchmark.md). Starts the real api + worker processes, signs up a
 * bench user, runs every case over the public API and writes evals/results/<ts>/report.{md,json}.
 *
 *   pnpm bench                 # all 20
 *   pnpm bench --only 06,13    # selected
 *   pnpm bench --concurrency 4
 *
 * Providers default to mock (see stack.ts); export real keys + *_PROVIDER to benchmark real models.
 */
const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = arg("only")?.split(",");
const concurrency = Number(arg("concurrency") ?? 3);
const timeoutMs = Number(arg("timeout") ?? 15 * 60) * 1000;

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(ROOT, "evals/results", ts);
mkdirSync(outDir, { recursive: true });
const logFile = resolve(outDir, "stack.log");

const stack = await startStack({ log: (s) => appendFileSync(logFile, s + "\n"), workers: Number(arg("workers") ?? 1) });
const anon = client(stack.apiUrl);
const email = `bench-${Date.now()}@bench.forge.test`;
const su = await anon.auth.signup.mutate({ email, password: "Bench-Password-2026", name: "Benchmark", locale: "en", elapsedMs: 5000 });
const c = client(stack.apiUrl, su.token);
const ctx = { c, apiUrl: stack.apiUrl, token: su.token, workspaceId: su.workspaceId, timeoutMs };

const selected = CASES.filter((x) => !only || only.includes(x.id));
const results: Array<{ id: string; slug: string; ok: boolean; ms: number; result?: CaseResult; error?: string }> = [];
let next = 0;
async function worker() {
  for (;;) {
    const i = next++;
    const k = selected[i];
    if (!k) return;
    const t0 = Date.now();
    try {
      const result = await k.run(ctx);
      const ok = result.checks.every((ch) => ch.passed);
      results.push({ id: k.id, slug: k.slug, ok, ms: Date.now() - t0, result });
      console.log(`${ok ? "PASS" : "FAIL"} ${k.id} ${k.slug} (${Math.round((Date.now() - t0) / 1000)}s)${ok ? "" : " — " + result.checks.filter((x) => !x.passed).map((x) => `${x.name}: ${x.detail ?? ""}`).join("; ")}`);
    } catch (e) {
      results.push({ id: k.id, slug: k.slug, ok: false, ms: Date.now() - t0, error: (e as Error).message });
      console.log(`ERROR ${k.id} ${k.slug}: ${(e as Error).message}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await stack.stop();

results.sort((a, b) => a.id.localeCompare(b.id));
const passed = results.filter((r) => r.ok).length;
const cost = results.reduce((a, r) => a + (r.result?.costUsd ?? 0), 0);
const charged = results.reduce((a, r) => a + (r.result?.chargedUsd ?? 0), 0);
const providers = ["LLM_PROVIDER", "MEDIA_PROVIDER", "STT_PROVIDER", "SANDBOX_PROVIDER", "CONNECTOR_PROVIDER"].map((k) => `${k}=${process.env[k] ?? (k === "SANDBOX_PROVIDER" ? "local" : "mock")}`).join(" ");
const md = [
  `# Forge benchmark — ${new Date().toISOString()}`,
  ``,
  `**${passed}/${results.length} passed** (target ≥ 16/20). Providers: \`${providers}\`.`,
  `Provider cost: $${cost.toFixed(4)} · charged to user: $${charged.toFixed(4)}.`,
  ``,
  `> With mock providers the LLM, media and STT calls are rule-based stand-ins; this measures the pipeline`,
  `> (classification → plan → scaffold → generate → gates → checkpoint/artifacts), not model quality.`,
  ``,
  `| # | Case | Result | Time | Cost (USD) | Failed checks |`,
  `|---|---|---|---|---|---|`,
  ...results.map((r) => `| ${r.id} | ${r.slug} | ${r.ok ? "✅" : "❌"} | ${Math.round(r.ms / 1000)}s | ${(r.result?.costUsd ?? 0).toFixed(4)} | ${r.error ?? (r.result?.checks.filter((x) => !x.passed).map((x) => `${x.name}${x.detail ? ` (${x.detail.slice(0, 120)})` : ""}`).join("; ") || "")} |`),
  ``,
].join("\n");
writeFileSync(resolve(outDir, "report.md"), md);
writeFileSync(resolve(outDir, "report.json"), JSON.stringify({ passed, total: results.length, costUsd: cost, chargedUsd: charged, results }, null, 2));
writeFileSync(resolve(ROOT, "evals/results/latest.md"), md);
console.log(`\n${passed}/${results.length} passed · report: ${outDir}/report.md`);
process.exit(0);
