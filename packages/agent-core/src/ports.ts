import type { CostEstimate, EventSink, Intent, UsageSink } from "@forge/shared";
import type { LLMProvider } from "@forge/llm";
import type { Spec } from "./spec.js";

/**
 * Ports the build agent depends on. They mirror the contracts in BUILD_PLAN.md and are satisfied
 * structurally by @forge/sandbox, @forge/quality-gates, @forge/design, @forge/templates, @forge/media,
 * @forge/slides and @forge/integrations (wired in apps/agent-worker). Keeping agent-core on ports makes
 * it testable in isolation.
 */

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface SandboxPort {
  readonly id: string;
  readonly projectId: string;
  readonly workdir: string;
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  listFiles(dir?: string, opts?: { recursive?: boolean }): Promise<string[]>;
  snapshot(label?: string): Promise<{ snapshotId: string }>;
  restore(snapshotId: string): Promise<void>;
  exposePort(port: number): Promise<{ url: string }>;
}

export interface GateFinding {
  file?: string;
  line?: number;
  rule: string;
  message: string;
  severity: "error" | "warning";
}

export interface GateResultLike {
  gate: string;
  passed: boolean;
  skipped?: boolean;
  details: string;
  findings: GateFinding[];
  fix?: string;
}

export interface GateReportLike {
  passed: boolean;
  results: GateResultLike[];
  blockers: GateResultLike[];
}

export interface GatesPort {
  run(sandbox: SandboxPort, opts: { previewUrl?: string; visualScore?: number; gates?: string[] }): Promise<GateReportLike>;
}

export interface TemplateManifestLike {
  id: string;
  kind: string;
  install: string;
  dev: string;
  build?: string;
  test?: string;
  typecheck?: string;
  lint?: string;
  e2e?: string;
  port: number;
  lighthouse?: boolean;
}

export interface TemplatesPort {
  select(intentKind: string, hint?: string): string;
  manifest(id: string): TemplateManifestLike;
  scaffold(id: string, writer: { writeFile(path: string, content: string): Promise<void> }, vars: Record<string, string>): Promise<string[]>;
}

export interface DesignResult {
  directionName: string;
  tokensCss: string;
  tokens: Record<string, unknown>;
  /** For websites the design engine may compose the full site (files to write). */
  files?: Record<string, string>;
  /** A bespoke layout concept for this brief (sections, hero, signature interaction) the builder implements. */
  concept?: string;
  /** Generated media (e.g. hero photography) to place in the project, with a short description each. */
  assets?: Array<{ path: string; bytes: Uint8Array; description: string }>;
}

export interface VisualQaResult {
  score: number;
  notes: string;
  critic: string;
  screenshots?: Array<{ viewport: number; url: string }>;
}

/** Project setup the platform owns (e.g. the visual-edit plugin). Returns true when package.json changed. */
export interface ProjectSetupPort {
  prepare(sandbox: SandboxPort, ctx: { projectId: string }): Promise<{ packageJsonChanged: boolean; notes: string[] }>;
}

export interface DesignPort {
  artDirection(input: { brief: string; spec: Spec; kind: string; brand?: unknown; direction?: unknown }): Promise<DesignResult>;
  /** Three distinct art directions to choose from before building (name, mood, palette, fonts …). */
  proposeDirections?(input: { brief: string; spec: Spec; kind: string; brand?: unknown }): Promise<unknown[]>;
  visualQa?(url: string, ctx: { brief: string }): Promise<VisualQaResult>;
  lighthouse?(url: string): Promise<{ performance: number; accessibility: number }>;
}

export interface CheckpointPort {
  /** git commit + sandbox snapshot + DB branch. */
  create(input: { sandbox: SandboxPort; projectId: string; taskId: string; label: string }): Promise<{ checkpointId: string; commit: string; snapshotId: string; dbBranchId?: string }>;
}

export interface MediaPort {
  generateImage(input: { projectId: string; prompt: string; n?: number }): Promise<Array<{ artifactId: string; url: string }>>;
  generateVideo(input: { projectId: string; prompt: string; durationSec: number }): Promise<{ artifactId: string; url: string }>;
  estimate?(kind: string, prompt: string): Promise<CostEstimate>;
}

export interface SlidesPort {
  createDeck(input: { projectId: string; prompt: string; slideCount?: number }): Promise<{ artifactId: string }>;
}

export interface IntegrationsPort {
  listTools(projectId: string): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>;
  call(projectId: string, tool: string, input: unknown): Promise<unknown>;
}

export interface DocsSearchPort {
  search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

export interface BrowserPort {
  screenshot(url: string, viewport: number): Promise<{ url: string }>;
  recordVideo?(url: string, seconds: number): Promise<{ url: string }>;
  /** Run Playwright acceptance scenarios against a URL. */
  runScenarios?(url: string, scenarios: Spec["acceptanceTests"]): Promise<Array<{ id: string; passed: boolean; error?: string }>>;
}

/** The generated app's own database (Neon branch / pg clone) for db_query. */
export interface ProjectDbPort {
  query(projectId: string, sql: string, opts: { readOnly: boolean }): Promise<{ rows: unknown[]; rowCount: number }>;
}

export interface AskUserPort {
  ask(question: string, options?: string[]): Promise<string | null>;
}

export interface AgentDeps {
  llm: LLMProvider;
  events: EventSink;
  usage: UsageSink;
  sandbox: SandboxPort;
  templates: TemplatesPort;
  gates: GatesPort;
  design?: DesignPort;
  checkpoints?: CheckpointPort;
  media?: MediaPort;
  slides?: SlidesPort;
  setup?: ProjectSetupPort;
  integrations?: IntegrationsPort;
  docs?: DocsSearchPort;
  browser?: BrowserPort;
  askUser?: AskUserPort;
  projectDb?: ProjectDbPort;
  /** Return true when the user cancelled the task. */
  isCancelled?: () => Promise<boolean>;
}

export interface BuildInput {
  taskId: string;
  projectId: string;
  workspaceId: string;
  prompt: string;
  intents: Intent[];
  planMode: boolean;
  approvedSpec?: unknown;
  brand?: unknown;
  /** True when the sandbox already holds a project (follow-up prompt). */
  existingProject?: boolean;
  /** Earlier requests in this project (oldest first), so follow-ups are understood in context. */
  history?: string;
  /** The workspace's company knowledge (profile + relevant facts) — context for everything built. */
  knowledge?: string;
  /** The user asked to see design proposals first: show 3 directions and wait for a choice. */
  wantsDesignOptions?: boolean;
  /** The direction the user picked from the proposals. */
  designDirection?: unknown;
}
