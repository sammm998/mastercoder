import type { CostEstimate, Intent, PromptSource } from "@forge/shared";
import type { DomainServices } from "./deps.js";
import { TRPCError } from "@trpc/server";

/**
 * Ports: what the API needs from domain packages. Adapters mapping each package's API onto these
 * ports live in src/wiring.ts. A missing service makes its endpoints fail with PRECONDITION_FAILED
 * ("not configured") rather than pretending to work.
 */

export interface IntentClassifier {
  classify(
    prompt: string,
    opts: { source: PromptSource; project?: { kind?: string; template?: string; previousPrompts?: string[] } },
  ): Promise<{ intents: Intent[]; needsClarification: boolean; question?: string; options?: string[]; estimate: CostEstimate; language: string }>;
}

export interface SpendChecker {
  check(scope: { userId?: string; workspaceId?: string; agentId?: string }, projectedUsd: number): Promise<void>;
}

export interface MediaEstimator {
  estimate(kind: "image" | "image-set" | "logo" | "video" | "remotion", prompt: string, options: Record<string, unknown>): Promise<CostEstimate>;
  moderate(prompt: string): Promise<{ allowed: boolean; category?: string; reason?: string }>;
}

export type ExportFormat = "pptx" | "pdf" | "docx" | "html";

export interface SlidesExporter {
  validateDeck(deck: unknown): { ok: true } | { ok: false; error: string };
  validateDocument(doc: unknown): { ok: true } | { ok: false; error: string };
  exportDeck(deck: unknown, format: Exclude<ExportFormat, "docx">): Promise<{ bytes: Uint8Array; mimeType: string; ext: string }>;
  exportDocument(doc: unknown, format: Exclude<ExportFormat, "pptx">): Promise<{ bytes: Uint8Array; mimeType: string; ext: string }>;
}

export interface AgentDefiner {
  /** Turn a prompt into an agent definition (instructions, tools, integrations, trigger, schedule, caps, approvals). */
  generate(prompt: string, ctx: { workspaceId: string }): Promise<{ name: string; definition: Record<string, unknown> }>;
  validate(definition: unknown): { ok: true; definition: Record<string, unknown> } | { ok: false; error: string };
}

export interface UploadService {
  init(opts: { meetingId: string; totalSize: number; mimeType: string; chunkSize: number }): Promise<{ uploadId: string }>;
  putChunk(uploadId: string, index: number, bytes: Uint8Array, sha256: string): Promise<{ received: number[] }>;
  status(uploadId: string): Promise<{ received: number[]; missing: number[]; totalChunks: number }>;
  complete(uploadId: string): Promise<{ storageKey: string; size: number }>;
}

export interface MeetingUrlParser {
  parse(url: string): { platform: string; nativeId: string } | null;
}

export interface ConnectorPort {
  listApps(locale: "en" | "sv"): Promise<Array<{ app: string; name: string; category: string; scopes: Array<{ id: string; description: string }> }>>;
  initiate(opts: { workspaceId: string; projectId?: string; userId: string; app: string; scopes: string[]; redirectUrl: string }): Promise<{ connectionId: string; redirectUrl: string; externalId?: string }>;
  status(externalId: string): Promise<{ status: string; scopes: string[] }>;
  revoke(externalId: string): Promise<void>;
  provider: string;
}

export interface OpenApiImporter {
  import(source: string | Record<string, unknown>): Promise<{ title: string; operations: Array<{ id: string; method: string; path: string; summary?: string }>; spec: Record<string, unknown> }>;
  generateClient(spec: Record<string, unknown>): Promise<string>;
}

export interface VaultPort {
  put(scope: { workspaceId: string; projectId?: string }, name: string, value: string): Promise<void>;
  listNames(scope: { workspaceId: string; projectId?: string }): Promise<string[]>;
  delete(scope: { workspaceId: string; projectId?: string }, name: string): Promise<void>;
}

export interface DomainPort {
  addDomain(projectId: string, hostname: string): Promise<{ records: Array<{ type: string; name: string; value: string }>; tlsStatus: string }>;
  checkDomain(projectId: string, hostname: string): Promise<{ verified: boolean; tlsStatus: string }>;
  removeDomain(projectId: string, hostname: string): Promise<void>;
}

export interface BillingPort {
  plans(): Array<{ id: string; name: string; monthlyUsd: number; includedUsd: number; limits: Record<string, number | null>; features: string[] }>;
  checkoutUrl(opts: { workspaceId: string; plan: string; customerId?: string | null; email: string; successUrl: string; cancelUrl: string }): Promise<{ url: string; customerId: string }>;
  portalUrl(opts: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  priceUsage(records: Array<{ kind: string; quantity: number; costUsd: number }>): number;
}

export function getService<T>(services: DomainServices, name: string): T | undefined {
  return services[name] as T | undefined;
}

export function requireService<T>(services: DomainServices, name: string): T {
  const s = services[name] as T | undefined;
  if (!s) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${name} is not configured on this server` });
  return s;
}
