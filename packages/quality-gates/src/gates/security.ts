import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { z } from "zod";
import type { Finding } from "../types.js";
import { findSecrets, secretFindings } from "../scanners/secrets.js";
import { owaspFindings, scanOwasp } from "../scanners/owasp.js";
import { collectDependencies, queryOsv, vulnFindings, vulnFix } from "../scanners/osv.js";
import { fromFindings, skipped, where, type GateContext, type GateOutcome } from "./context.js";

type Tool = "semgrep" | "gitleaks" | "osv-scanner";

interface ToolRun {
  where: "sandbox" | "host";
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function onHostPath(bin: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Run a real scanner in the sandbox if installed there, else on the host against a copy of the collected files. */
async function runTool(ctx: GateContext, tool: Tool, sandboxCmd: string, hostArgs: (dir: string) => string[]): Promise<ToolRun | null> {
  if (ctx.opts.externalTools === false) return null;
  const probe = await ctx.sb.exec(`command -v ${tool}`, { env: ctx.opts.env, timeoutMs: 15000 });
  if (probe.exitCode === 0 && probe.stdout.trim()) {
    const r = await ctx.sb.exec(sandboxCmd, { env: ctx.opts.env, timeoutMs: ctx.opts.commandTimeoutMs ?? 600000 });
    return { where: "sandbox", exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
  const bin = await onHostPath(tool);
  if (!bin) return null;
  const dir = await mkdtemp(join(tmpdir(), `forge-${tool}-`));
  try {
    for (const f of await ctx.files()) {
      const p = join(dir, f.path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, f.content);
    }
    return await new Promise<ToolRun>((resolve) => {
      execFile(bin, hostArgs(dir), { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout: ctx.opts.commandTimeoutMs ?? 600000 }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
        resolve({ where: "host", exitCode: code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SemgrepOut = z.object({
  results: z.array(
    z.object({
      check_id: z.string(),
      path: z.string(),
      start: z.object({ line: z.number() }).passthrough(),
      extra: z.object({ message: z.string().optional(), severity: z.string().optional() }).passthrough(),
    }).passthrough(),
  ),
}).passthrough();

const GitleaksOut = z.array(
  z.object({ RuleID: z.string(), File: z.string(), StartLine: z.number(), Description: z.string().optional(), Secret: z.string().optional() }).passthrough(),
);

const OsvScannerOut = z.object({
  results: z
    .array(
      z.object({
        source: z.object({ path: z.string() }).passthrough(),
        packages: z
          .array(
            z.object({
              package: z.object({ name: z.string(), version: z.string(), ecosystem: z.string().optional() }).passthrough(),
              vulnerabilities: z.array(z.object({ id: z.string(), summary: z.string().optional() }).passthrough()).optional(),
            }).passthrough(),
          )
          .optional(),
      }).passthrough(),
    )
    .optional(),
}).passthrough();

function relPath(p: string): string {
  return p.replace(/^\/workspace\//, "").replace(/^\.\//, "").replace(/^\/tmp\/forge-[\w-]+\//, "");
}

export async function semgrepGate(ctx: GateContext): Promise<GateOutcome> {
  const run = await runTool(ctx, "semgrep", "semgrep scan --config p/owasp-top-ten --json --quiet --metrics=off .", () => ["scan", "--config", "p/owasp-top-ten", "--json", "--quiet", "--metrics=off", "."]);
  if (run) {
    try {
      const out = SemgrepOut.parse(JSON.parse(run.stdout));
      const findings: Finding[] = out.results.map((r) => ({
        file: relPath(r.path),
        line: r.start.line,
        rule: `semgrep/${r.check_id}`,
        message: (r.extra.message ?? r.check_id).slice(0, 300),
        severity: /ERROR|HIGH|CRITICAL/i.test(r.extra.severity ?? "") ? "error" : "warning",
      }));
      return fromFindings(
        findings,
        `semgrep p/owasp-top-ten (${run.where}): no blocking findings`,
        (n) => `semgrep p/owasp-top-ten (${run.where}): ${n} blocking finding(s)`,
        () => `Fix the semgrep findings:\n${findings.filter((f) => f.severity === "error").slice(0, 15).map((f) => `- ${where(f)} ${f.rule}: ${f.message}`).join("\n")}`,
      );
    } catch {
      /* unparsable output: fall back to built-in rules */
    }
  }
  const hits = scanOwasp(await ctx.files());
  const findings = owaspFindings(hits);
  const note = "semgrep not installed — used Forge built-in OWASP rules";
  return fromFindings(
    findings,
    `${note}: no blocking findings`,
    (n) => `${note}: ${n} blocking finding(s)`,
    () => hits.filter((h) => h.severity === "error").slice(0, 15).map((h) => `- ${h.file}:${h.line} ${h.rule}: ${h.fix}`).join("\n"),
  );
}

export async function gitleaksGate(ctx: GateContext): Promise<GateOutcome> {
  const report = `/tmp/forge-gitleaks-${Date.now()}.json`;
  const run = await runTool(
    ctx,
    "gitleaks",
    `gitleaks detect --no-git --redact --source . --report-format json --report-path ${report} >/dev/null 2>&1; cat ${report}; rm -f ${report}`,
    (dir) => ["detect", "--no-git", "--redact", "--source", dir, "--report-format", "json", "--report-path", "/dev/stdout"],
  );
  if (run) {
    try {
      const leaks = GitleaksOut.parse(JSON.parse(run.stdout.slice(run.stdout.indexOf("["))));
      const findings: Finding[] = leaks.map((l) => ({ file: relPath(l.File), line: l.StartLine, rule: `gitleaks/${l.RuleID}`, message: `${l.Description ?? l.RuleID} (redacted)`, severity: "error" }));
      return fromFindings(findings, `gitleaks (${run.where}): no secrets found`, (n) => `gitleaks (${run.where}): ${n} secret(s) found`, () => secretFix(findings));
    } catch {
      /* fall back */
    }
  }
  const matches = findSecrets(await ctx.files());
  const findings = secretFindings(matches);
  const note = "gitleaks not installed — used Forge built-in secret rules";
  return fromFindings(findings, `${note}: no secrets found`, (n) => `${note}: ${n} secret(s) found`, () => secretFix(findings));
}

function secretFix(findings: Finding[]): string {
  const list = findings.slice(0, 15).map((f) => `- ${where(f)} ${f.message}`).join("\n");
  return (
    `Remove hardcoded secrets and load them from the environment instead (e.g. \`process.env.AWS_SECRET_ACCESS_KEY\` / ` +
    "`os.environ[...]`), add the names to .env.example without values, and ROTATE every leaked credential — it must be " +
    `considered compromised:\n${list}`
  );
}

export async function osvGate(ctx: GateContext): Promise<GateOutcome> {
  const run = await runTool(ctx, "osv-scanner", "osv-scanner --format json -r .", (dir) => ["--format", "json", "-r", dir]);
  if (run && run.stdout.trim().startsWith("{")) {
    try {
      const out = OsvScannerOut.parse(JSON.parse(run.stdout));
      const findings: Finding[] = [];
      for (const r of out.results ?? []) {
        for (const p of r.packages ?? []) {
          for (const v of p.vulnerabilities ?? []) {
            findings.push({ file: relPath(r.source.path), rule: `osv/${v.id}`, message: `${p.package.name}@${p.package.version}: ${v.summary ?? v.id}`, severity: "error" });
          }
        }
      }
      return fromFindings(findings, `osv-scanner (${run.where}): no known vulnerabilities`, (n) => `osv-scanner (${run.where}): ${n} vulnerable package version(s)`, () =>
        `Upgrade the vulnerable packages to a fixed version and regenerate the lockfile:\n${findings.slice(0, 20).map((f) => `- ${f.message} (${f.rule.slice(4)})`).join("\n")}`,
      );
    } catch {
      /* fall back */
    }
  }
  const deps = collectDependencies(await ctx.files());
  if (deps.length === 0) return skipped("skipped: no lockfile or dependency manifest found");
  let hits;
  try {
    hits = await queryOsv(deps, ctx.opts.fetch ?? fetch);
  } catch (e) {
    return skipped(`skipped: osv-scanner not installed and the OSV API (https://api.osv.dev/v1/querybatch) was unreachable: ${(e as Error).message}`);
  }
  const findings = vulnFindings(hits);
  const note = `osv-scanner not installed — checked ${deps.length} dependencies against the OSV API`;
  return fromFindings(findings, `${note}: no known vulnerabilities`, (n) => `${note}: ${n} vulnerable dependency finding(s)`, () => vulnFix(hits.filter((h) => h.severity.toUpperCase() !== "LOW")));
}
