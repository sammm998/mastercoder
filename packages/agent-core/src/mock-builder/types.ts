import type { Spec } from "../spec.js";

/** Minimal shape of @forge/integrations' ImportedApi used by the generators. */
export type { ImportedApi } from "@forge/integrations";

export interface GenerateContext {
  spec: Spec;
  templateId: string;
  /** Files already in the project (from list_files), relative paths. */
  files: string[];
  /** Parsed OpenAPI document when the spec/prompt references one. */
  openapi?: { api: import("@forge/integrations").ImportedApi; name: string };
}

export interface GeneratedProject {
  generator: string;
  /** Files to write (path → content). */
  files: Record<string, string>;
  /** Shell commands run once after writing, in order (dependencies, code generation, formatters). */
  setup: string[];
  /** Files written after setup (they depend on its output, e.g. custom migrations). */
  postFiles: Record<string, string>;
  /** Verification commands besides run_tests (typecheck, lint). */
  verify: string[];
  /** Command that auto-fixes lint/format issues (tried once when verification fails). */
  autofix?: string;
  /** Plain-language notes (assumptions, limitations) for the final summary. */
  notes: string[];
}

export function emptyProject(generator: string): GeneratedProject {
  return { generator, files: {}, setup: [], postFiles: {}, verify: [], notes: [] };
}
