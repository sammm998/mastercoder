import type { Sandbox } from "@forge/sandbox";

export const GATE_NAMES = [
  "typecheck",
  "lint",
  "unit",
  "integration",
  "e2e",
  "semgrep",
  "gitleaks",
  "osv",
  "rls",
  "auth",
  "validation",
  "client-secrets",
  "lighthouse",
  "visual-qa",
  "links",
] as const;
export type GateName = (typeof GATE_NAMES)[number];

/** Gates that only read files (no project commands, no preview). */
export const STATIC_GATES: GateName[] = ["semgrep", "gitleaks", "osv", "rls", "auth", "validation", "client-secrets"];

export interface Finding {
  file?: string;
  line?: number;
  rule: string;
  message: string;
  severity: "error" | "warning";
}

export interface GateResult {
  gate: GateName;
  passed: boolean;
  skipped?: boolean;
  details: string;
  findings: Finding[];
  /** Concrete proposed fix for a failing gate. */
  fix?: string;
  durationMs: number;
}

export interface GateReport {
  passed: boolean;
  results: GateResult[];
  blockers: GateResult[];
}

export interface LighthouseScores {
  performance: number;
  accessibility: number;
}

export interface RunGatesOptions {
  gates?: GateName[];
  previewUrl?: string;
  lighthouse?: (url: string) => Promise<LighthouseScores>;
  /** Browser crawl of the preview: every internal page/anchor with the problems found (links gate). */
  crawl?: (url: string) => Promise<Array<{ url: string; ok: boolean; problems: string[] }>>;
  visualScore?: number;
  /** Extensions (not in the base contract). */
  /** Use semgrep/gitleaks/osv-scanner binaries when found in the sandbox or host PATH (default true). */
  externalTools?: boolean;
  /** Extra env for every command run in the sandbox. */
  env?: Record<string, string>;
  /** Per-command timeout (default 10 min). */
  commandTimeoutMs?: number;
  /** fetch used for the OSV API fallback (default global fetch). */
  fetch?: typeof fetch;
  /** Thresholds (defaults: performance 85, accessibility 90, visual 8). */
  thresholds?: { performance?: number; accessibility?: number; visual?: number };
}

export type { Sandbox };
