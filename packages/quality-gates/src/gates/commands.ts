import type { Finding } from "../types.js";
import type { CommandGate } from "../project.js";
import { skipped, where, type GateContext, type GateOutcome } from "./context.js";

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");

/** Parse common tool output formats (tsc, eslint stylish/unix, ruff/mypy/flake8, vitest/jest, pytest). */
export function parseToolOutput(output: string, gate: CommandGate): Finding[] {
  const text = output.replace(ANSI, "");
  const out: Finding[] = [];
  const push = (f: Finding): void => {
    if (out.length < 100 && !out.some((o) => o.file === f.file && o.line === f.line && o.message === f.message)) out.push(f);
  };
  let eslintFile: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m = /^(.+?\.[a-zA-Z]+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/.exec(line);
    if (m) {
      push({ file: m[1], line: Number(m[2]), rule: `${gate}/${m[5]}`, message: m[6] ?? "", severity: m[4] === "warning" ? "warning" : "error" });
      continue;
    }
    if (/^(\/|\.\/|[\w@.-]+\/)[^\s:]+\.[a-zA-Z]+$/.test(line.trim()) && !line.startsWith(" ")) {
      eslintFile = line.trim();
      continue;
    }
    m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/.exec(line);
    if (m && eslintFile) {
      push({ file: eslintFile, line: Number(m[1]), rule: `${gate}/${m[5] ?? "error"}`, message: m[4] ?? "", severity: m[3] === "warning" ? "warning" : "error" });
      continue;
    }
    m = /^(?:FAILED\s+)?([\w./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|vue|svelte)):(\d+)(?::(\d+))?:?\s*(?:-\s*)?(?:(error|warning|E\d+|W\d+|F\d+)[:\s]+)?(.*)$/.exec(line.trim());
    if (m && m[5] !== undefined && !/^\d+$/.test(m[5])) {
      push({ file: m[1]?.replace(/^\.\//, ""), line: Number(m[2]), rule: `${gate}/${m[4] ?? "failure"}`, message: (m[5] || "failure").trim().slice(0, 300), severity: m[4] === "warning" || /^W\d+/.test(m[4] ?? "") ? "warning" : "error" });
      continue;
    }
    m = /^\s*(?:FAIL|✗|×|❯)\s+([\w./@-]+\.(?:test|spec)\.[a-z]+)(?:\s+>\s+(.+))?/.exec(line);
    if (m) {
      push({ file: m[1], rule: `${gate}/test-failed`, message: m[2] ? `failed: ${m[2]}` : "test file failed", severity: "error" });
      continue;
    }
    m = /^FAILED\s+([\w./-]+\.py)::(\S+)(?:\s+-\s+(.+))?/.exec(line);
    if (m) push({ file: m[1], rule: `${gate}/test-failed`, message: `${m[2]} failed${m[3] ? `: ${m[3]}` : ""}`, severity: "error" });
  }
  return out;
}

const LABEL: Record<CommandGate, string> = { typecheck: "Type errors", lint: "Lint errors", unit: "Failing unit tests", integration: "Failing integration tests", e2e: "Failing e2e tests" };

export async function runCommandGate(ctx: GateContext, gate: CommandGate): Promise<GateOutcome> {
  const cmd = ctx.project.commands[gate];
  if (!cmd) return skipped(`skipped: ${ctx.project.reasons[gate] ?? "not applicable"}`);
  const timeoutMs = ctx.opts.commandTimeoutMs ?? 10 * 60 * 1000;
  const r = await ctx.sb.exec(cmd, { timeoutMs, env: { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", ...(ctx.opts.env ?? {}) } });
  const output = `${r.stdout}\n${r.stderr}`;
  const tail = output.trim().split("\n").slice(-25).join("\n");
  if (r.timedOut) {
    return {
      passed: false,
      details: `\`${cmd}\` timed out after ${Math.round(timeoutMs / 1000)}s`,
      findings: [{ rule: `${gate}/timeout`, message: `command timed out after ${Math.round(timeoutMs / 1000)}s`, severity: "error" }],
      fix: `\`${cmd}\` did not finish in time: look for hanging tests/watch mode (use \`vitest run\` / \`--watch=false\`), open handles, or raise commandTimeoutMs.`,
    };
  }
  if (r.exitCode === 0) {
    const warnings = parseToolOutput(output, gate).filter((f) => f.severity === "warning");
    return { passed: true, details: `\`${cmd}\` passed in ${(r.durationMs / 1000).toFixed(1)}s`, findings: warnings };
  }
  let findings = parseToolOutput(output, gate);
  if (!findings.some((f) => f.severity === "error")) {
    findings = [...findings, { rule: `${gate}/exit-${r.exitCode}`, message: `\`${cmd}\` exited with ${r.exitCode}: ${tail.slice(-500)}`, severity: "error" }];
  }
  const errors = findings.filter((f) => f.severity === "error");
  const notFound = r.exitCode === 127 || /command not found|not found: |Missing script/i.test(output);
  const list = errors.slice(0, 10).map((f) => `- ${where(f)} ${f.message}`).join("\n");
  const fix = notFound
    ? `\`${cmd}\` could not run (exit ${r.exitCode}). Install dependencies first (\`${ctx.project.packageManager ?? "npm"} install\`) or fix the command in package.json / forge.json.\n${tail.slice(-400)}`
    : `${LABEL[gate]} reported by \`${cmd}\` (exit ${r.exitCode}). Fix these ${errors.length} issue(s), then re-run \`${cmd}\`:\n${list}`;
  return { passed: false, details: `\`${cmd}\` failed (exit ${r.exitCode}, ${errors.length} error(s))`, findings, fix };
}
