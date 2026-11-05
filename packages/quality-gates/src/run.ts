import { createLogger } from "@forge/shared";
import type { Sandbox } from "@forge/sandbox";
import { GATE_NAMES, type GateName, type GateReport, type GateResult, type RunGatesOptions } from "./types.js";
import { detectProject } from "./project.js";
import { collectFiles, type SourceFile } from "./files.js";
import { runCommandGate } from "./gates/commands.js";
import { gitleaksGate, osvGate, semgrepGate } from "./gates/security.js";
import { authGate, clientSecretsGate, rlsGate, validationGate } from "./gates/static.js";
import { lighthouseGate, visualQaGate } from "./gates/perf.js";
import type { GateContext, GateOutcome } from "./gates/context.js";

const log = createLogger({ mod: "quality-gates" });

const RUNNERS: Record<GateName, (ctx: GateContext) => Promise<GateOutcome>> = {
  typecheck: (c) => runCommandGate(c, "typecheck"),
  lint: (c) => runCommandGate(c, "lint"),
  unit: (c) => runCommandGate(c, "unit"),
  integration: (c) => runCommandGate(c, "integration"),
  e2e: (c) => runCommandGate(c, "e2e"),
  semgrep: semgrepGate,
  gitleaks: gitleaksGate,
  osv: osvGate,
  rls: rlsGate,
  auth: authGate,
  validation: validationGate,
  "client-secrets": clientSecretsGate,
  lighthouse: lighthouseGate,
  "visual-qa": visualQaGate,
};

/**
 * Run quality/security/performance gates against the project in `sandbox` (/workspace).
 * A gate that throws fails closed (blocker) with the error in `details`.
 */
export async function runGates(sandbox: Sandbox, opts: RunGatesOptions = {}): Promise<GateReport> {
  const gates = opts.gates ?? [...GATE_NAMES];
  let topLevel: string[] = [];
  try {
    topLevel = (await sandbox.listFiles(".")).map((p) => p.replace(/\/$/, ""));
  } catch {
    /* empty workspace */
  }
  const project = await detectProject(sandbox, topLevel);
  let filesPromise: Promise<SourceFile[]> | null = null;
  const ctx: GateContext = {
    sb: sandbox,
    opts,
    project,
    files: () => (filesPromise ??= collectFiles(sandbox, opts.env)),
  };
  const results: GateResult[] = [];
  for (const gate of gates) {
    const started = Date.now();
    let outcome: GateOutcome;
    try {
      outcome = await RUNNERS[gate](ctx);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      outcome = {
        passed: false,
        details: `gate crashed: ${msg.slice(0, 300)}`,
        findings: [{ rule: `${gate}/crashed`, message: msg.slice(0, 300), severity: "error" }],
        fix: `The ${gate} gate could not run (${msg.slice(0, 120)}). Fix the project setup so the gate can execute, then re-run it.`,
      };
    }
    if (project.manifestError && gate === gates[0]) outcome.details += ` [${project.manifestError}]`;
    results.push({ gate, ...outcome, durationMs: Date.now() - started });
  }
  const blockers = results.filter((r) => !r.passed && !r.skipped);
  log.info("gates finished", { sandbox: sandbox.id, passed: blockers.length === 0, blockers: blockers.map((b) => b.gate) });
  return { passed: blockers.length === 0, results, blockers };
}
