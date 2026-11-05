import type { ForgeEventInput } from "@forge/shared";
import type { GateReport, GateResult } from "./types.js";

const icon = (r: GateResult): string => (r.skipped ? "⏭️" : r.passed ? "✅" : "❌");
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Markdown summary of a gate report for the UI and events. */
export function formatGateReport(report: GateReport, opts: { maxFindings?: number } = {}): string {
  const max = opts.maxFindings ?? 10;
  const failed = report.blockers.length;
  const ran = report.results.filter((r) => !r.skipped).length;
  const out: string[] = [];
  out.push(`## Quality gates: ${report.passed ? "✅ passed" : `❌ blocked (${failed} failing)`}`);
  out.push("");
  out.push(`${ran} gate(s) ran, ${report.results.length - ran} skipped.`);
  out.push("");
  out.push("| Gate | Result | Details | Time |");
  out.push("|---|---|---|---|");
  for (const r of report.results) {
    out.push(`| ${r.gate} | ${icon(r)} ${r.skipped ? "skipped" : r.passed ? "pass" : "fail"} | ${cell(r.details)} | ${(r.durationMs / 1000).toFixed(1)}s |`);
  }
  for (const b of report.blockers) {
    out.push("");
    out.push(`### ❌ ${b.gate}`);
    out.push("");
    const errors = b.findings.filter((f) => f.severity === "error");
    for (const f of errors.slice(0, max)) {
      const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : "";
      out.push(`- ${loc}**${f.rule}** — ${f.message}`);
    }
    if (errors.length > max) out.push(`- …and ${errors.length - max} more`);
    if (b.fix) {
      out.push("");
      out.push("**Proposed fix**");
      out.push("");
      out.push("```text");
      out.push(b.fix);
      out.push("```");
    }
  }
  return out.join("\n");
}

/** One `gate.result` event per gate (for EventSink / the WebSocket gateway). */
export function gateEvents(report: GateReport, projectId: string, taskId?: string): ForgeEventInput[] {
  return report.results.map((r) => ({ type: "gate.result" as const, projectId, taskId, gate: r.gate, passed: r.passed, details: r.skipped ? `skipped — ${r.details}` : r.details, fix: r.fix }));
}
