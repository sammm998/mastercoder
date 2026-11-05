import { z } from "zod";
import { ForgeError } from "@forge/shared";
import { BranchNameSchema, type DbBranch, type DbBranchProvider } from "../db-branch/types.js";

/** Neon region for Forge projects: Frankfurt (EU data residency). */
export const NEON_EU_REGION = "aws-eu-central-1";

export interface NeonOptions {
  apiKey?: string;
  baseUrl?: string;
  databaseName?: string;
  roleName?: string;
  fetch?: typeof fetch;
  /** Max time to wait for Neon operations (restore, branch create) to finish. */
  operationTimeoutMs?: number;
  pollIntervalMs?: number;
}

const BranchSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string().nullish(),
  created_at: z.string(),
  default: z.boolean().optional(),
  primary: z.boolean().optional(),
});
const OperationSchema = z.object({ id: z.string(), status: z.string(), action: z.string().optional() });
const CreateBranchResponse = z.object({
  branch: BranchSchema,
  connection_uris: z.array(z.object({ connection_uri: z.string() })).optional(),
  operations: z.array(OperationSchema).optional(),
});
const ListBranchesResponse = z.object({ branches: z.array(BranchSchema) });
const ConnectionUriResponse = z.object({ uri: z.string() });
const OperationsResponse = z.object({ operations: z.array(OperationSchema).optional() });
const CreateProjectResponse = z.object({
  project: z.object({ id: z.string(), region_id: z.string() }),
  connection_uris: z.array(z.object({ connection_uri: z.string() })).optional(),
});

/**
 * Neon serverless Postgres branching via the Neon API v2 (https://api-docs.neon.tech/reference).
 * `projectRoot` is the Neon project id; the project's default branch is its main database.
 * Branches are copy-on-write, so creating one is instant regardless of database size.
 */
export class NeonBranchProvider implements DbBranchProvider {
  readonly name = "neon";
  readonly isMock = false;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly databaseName: string;
  private readonly roleName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly operationTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(opts: NeonOptions = {}) {
    const key = opts.apiKey ?? process.env.NEON_API_KEY;
    if (!key) throw new ForgeError("BAD_INPUT", "NEON_API_KEY is required for DB_BRANCH_PROVIDER=neon");
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? "https://console.neon.tech/api/v2").replace(/\/$/, "");
    this.databaseName = opts.databaseName ?? process.env.NEON_DATABASE_NAME ?? "neondb";
    this.roleName = opts.roleName ?? process.env.NEON_ROLE_NAME ?? "neondb_owner";
    this.fetchImpl = opts.fetch ?? fetch;
    this.operationTimeoutMs = opts.operationTimeoutMs ?? 120_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
  }

  private async api<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      const code = res.status === 404 ? "NOT_FOUND" : res.status === 401 || res.status === 403 ? "UNAUTHORIZED" : res.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR";
      throw new ForgeError(code, `Neon ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return schema.parse(text ? JSON.parse(text) : {});
  }

  /** Create a Neon project in the EU region; returns its id (the `projectRoot`) and main connection URL. */
  async createProject(name: string, pgVersion = 17): Promise<{ projectId: string; connectionUrl?: string }> {
    const r = await this.api("POST", "/projects", CreateProjectResponse, { project: { name, region_id: NEON_EU_REGION, pg_version: pgVersion } });
    return { projectId: r.project.id, connectionUrl: r.connection_uris?.[0]?.connection_uri };
  }

  private async defaultBranchId(projectId: string): Promise<string> {
    const { branches } = await this.api("GET", `/projects/${encodeURIComponent(projectId)}/branches`, ListBranchesResponse);
    const main = branches.find((b) => b.default ?? b.primary) ?? branches.find((b) => !b.parent_id);
    if (!main) throw new ForgeError("NOT_FOUND", `Neon project ${projectId} has no default branch`);
    return main.id;
  }

  private async waitForOperations(projectId: string, ops: Array<{ id: string; status: string }>): Promise<void> {
    const deadline = Date.now() + this.operationTimeoutMs;
    let pending = ops.filter((o) => !["finished", "skipped", "cancelled"].includes(o.status));
    while (pending.length > 0) {
      if (Date.now() > deadline) throw new ForgeError("PROVIDER_ERROR", `Neon operations did not finish in time: ${pending.map((o) => o.id).join(", ")}`);
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const next: typeof pending = [];
      for (const op of pending) {
        const cur = await this.api("GET", `/projects/${encodeURIComponent(projectId)}/operations/${op.id}`, z.object({ operation: OperationSchema }));
        if (cur.operation.status === "failed" || cur.operation.status === "error") throw new ForgeError("PROVIDER_ERROR", `Neon operation ${op.id} failed`);
        if (!["finished", "skipped", "cancelled"].includes(cur.operation.status)) next.push(cur.operation);
      }
      pending = next;
    }
  }

  private async connectionUri(projectId: string, branchId: string): Promise<string> {
    const q = new URLSearchParams({ branch_id: branchId, database_name: this.databaseName, role_name: this.roleName });
    const r = await this.api("GET", `/projects/${encodeURIComponent(projectId)}/connection_uri?${q}`, ConnectionUriResponse);
    return r.uri;
  }

  async createBranch(projectRoot: string, name: string, fromBranch?: string): Promise<{ branchId: string; connectionUrl: string }> {
    BranchNameSchema.parse(name);
    const r = await this.api("POST", `/projects/${encodeURIComponent(projectRoot)}/branches`, CreateBranchResponse, {
      branch: { name, ...(fromBranch ? { parent_id: fromBranch } : {}) },
      endpoints: [{ type: "read_write" }],
    });
    await this.waitForOperations(projectRoot, r.operations ?? []);
    const connectionUrl = r.connection_uris?.[0]?.connection_uri ?? (await this.connectionUri(projectRoot, r.branch.id));
    return { branchId: r.branch.id, connectionUrl };
  }

  async restoreBranch(projectRoot: string, branchId: string): Promise<void> {
    const main = await this.defaultBranchId(projectRoot);
    if (main === branchId) throw new ForgeError("BAD_INPUT", "Cannot restore the main branch from itself");
    const r = await this.api("POST", `/projects/${encodeURIComponent(projectRoot)}/branches/${main}/restore`, OperationsResponse, {
      source_branch_id: branchId,
      // Neon keeps the pre-restore state as a branch so the restore itself can be undone.
      preserve_under_name: `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    });
    await this.waitForOperations(projectRoot, r.operations ?? []);
  }

  async deleteBranch(projectRoot: string, branchId: string): Promise<void> {
    const r = await this.api("DELETE", `/projects/${encodeURIComponent(projectRoot)}/branches/${encodeURIComponent(branchId)}`, OperationsResponse);
    await this.waitForOperations(projectRoot, r.operations ?? []);
  }

  async listBranches(projectRoot: string): Promise<DbBranch[]> {
    const { branches } = await this.api("GET", `/projects/${encodeURIComponent(projectRoot)}/branches`, ListBranchesResponse);
    const out: DbBranch[] = [];
    for (const b of branches) {
      if (b.default ?? b.primary) continue;
      out.push({ branchId: b.id, name: b.name, parentId: b.parent_id ?? undefined, createdAt: b.created_at, connectionUrl: await this.connectionUri(projectRoot, b.id) });
    }
    return out;
  }
}
