import type { Sandbox } from "@forge/sandbox";
import type { ProjectInfo } from "../project.js";
import type { SourceFile } from "../files.js";
import type { Finding, GateResult, RunGatesOptions } from "../types.js";

export interface GateContext {
  sb: Sandbox;
  opts: RunGatesOptions;
  project: ProjectInfo;
  files: () => Promise<SourceFile[]>;
}

export type GateOutcome = Omit<GateResult, "gate" | "durationMs">;

export function skipped(details: string): GateOutcome {
  return { passed: true, skipped: true, details, findings: [] };
}

export function fromFindings(findings: Finding[], okDetails: string, failDetails: (n: number) => string, fix: () => string): GateOutcome {
  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length === 0) return { passed: true, details: findings.length ? `${okDetails} (${findings.length} warning(s))` : okDetails, findings };
  return { passed: false, details: failDetails(errors.length), findings, fix: fix() };
}

export const where = (f: Finding): string => (f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(project)");
