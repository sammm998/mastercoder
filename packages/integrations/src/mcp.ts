import { z } from "zod";
import { ForgeError } from "@forge/shared";
import { defineTool, type ForgeTool } from "@forge/llm";
import { connections, and, eq, type Db } from "@forge/db";
import { connectMcp, type McpConnectConfig, type McpSession, type McpToolInfo } from "./adapters/mcp-client.js";
import { isIrreversibleActionName } from "./catalog.js";
import { toolName } from "./connectors.js";
import { jsonSchemaToZod } from "./json-schema.js";
import { assertPublicUrl, type UrlPolicy } from "./ssrf.js";
import type { SecretLender } from "./openapi/call.js";

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$|token|secret|key|password/i;

export const McpServerConfigSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/, "name: letters, digits, _ and -, max 48"),
    transport: z.enum(["stdio", "http"]),
    description: z.string().max(500).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    /** Non-secret headers only. */
    headers: z.record(z.string()).default({}),
    /** Header name -> vault secret name, resolved per call (e.g. { Authorization: "LINEAR_MCP_TOKEN" } with value "Bearer ..."). */
    headerSecrets: z.record(z.string()).default({}),
  })
  .superRefine((c, ctx) => {
    if (c.transport === "stdio" && !c.command) ctx.addIssue({ code: "custom", message: "stdio transport requires command", path: ["command"] });
    if (c.transport === "http" && !c.url) ctx.addIssue({ code: "custom", message: "http transport requires url", path: ["url"] });
    if (c.url && !/^https?:\/\//i.test(c.url)) ctx.addIssue({ code: "custom", message: "url must be http(s)", path: ["url"] });
    for (const h of Object.keys(c.headers))
      if (SENSITIVE_HEADER.test(h)) ctx.addIssue({ code: "custom", message: `header "${h}" looks secret: store it in the vault and use headerSecrets`, path: ["headers", h] });
  });
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerInput = z.input<typeof McpServerConfigSchema>;

export interface McpServerStore {
  put(workspaceId: string, cfg: McpServerConfig, meta: { userId: string }): Promise<void>;
  get(workspaceId: string, name: string): Promise<McpServerConfig | null>;
  list(workspaceId: string): Promise<McpServerConfig[]>;
  delete(workspaceId: string, name: string): Promise<boolean>;
}

export class MemoryMcpServerStore implements McpServerStore {
  private readonly rows = new Map<string, Map<string, McpServerConfig>>();
  async put(workspaceId: string, cfg: McpServerConfig): Promise<void> {
    let ws = this.rows.get(workspaceId);
    if (!ws) this.rows.set(workspaceId, (ws = new Map()));
    ws.set(cfg.name, structuredClone(cfg));
  }
  async get(workspaceId: string, name: string): Promise<McpServerConfig | null> {
    const c = this.rows.get(workspaceId)?.get(name);
    return c ? structuredClone(c) : null;
  }
  async list(workspaceId: string): Promise<McpServerConfig[]> {
    return [...(this.rows.get(workspaceId)?.values() ?? [])].map((c) => structuredClone(c)).sort((a, b) => a.name.localeCompare(b.name));
  }
  async delete(workspaceId: string, name: string): Promise<boolean> {
    return this.rows.get(workspaceId)?.delete(name) ?? false;
  }
}

/** Persists MCP servers in the `connections` table (provider = "mcp", app = server name, config = JSON). */
export class DrizzleMcpServerStore implements McpServerStore {
  constructor(private readonly db: Db) {}
  private where(workspaceId: string, name?: string) {
    const base = and(eq(connections.workspaceId, workspaceId), eq(connections.provider, "mcp"), eq(connections.status, "active"));
    return name ? and(base, eq(connections.app, name)) : base;
  }
  async put(workspaceId: string, cfg: McpServerConfig, meta: { userId: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(connections).set({ status: "revoked", revokedAt: new Date() }).where(this.where(workspaceId, cfg.name));
      await tx.insert(connections).values({ id: `mcp_${workspaceId}_${cfg.name}_${Date.now().toString(36)}`, workspaceId, userId: meta.userId, provider: "mcp", app: cfg.name, scopes: [], config: cfg, status: "active" });
    });
  }
  async get(workspaceId: string, name: string): Promise<McpServerConfig | null> {
    const [row] = await this.db.select().from(connections).where(this.where(workspaceId, name)).limit(1);
    return row ? McpServerConfigSchema.parse(row.config) : null;
  }
  async list(workspaceId: string): Promise<McpServerConfig[]> {
    const rows = await this.db.select().from(connections).where(this.where(workspaceId));
    return rows.map((r) => McpServerConfigSchema.parse(r.config)).sort((a, b) => a.name.localeCompare(b.name));
  }
  async delete(workspaceId: string, name: string): Promise<boolean> {
    const r = await this.db.update(connections).set({ status: "revoked", revokedAt: new Date() }).where(this.where(workspaceId, name)).returning({ id: connections.id });
    return r.length > 0;
  }
}

export interface McpPolicy extends UrlPolicy {
  /** stdio servers spawn local processes: allow them at all (default true; run the worker inside the sandbox). */
  allowStdio?: boolean;
  /** When set, stdio commands must be one of these (e.g. ["npx", "uvx", "node"]). */
  allowedCommands?: string[];
}

export interface McpToolOptions {
  /** Vault + scope used to resolve `headerSecrets` for each call. */
  vault?: SecretLender;
  scope?: { workspaceId: string; projectId?: string | null };
  policy?: McpPolicy;
  timeoutMs?: number;
}

function checkPolicy(cfg: McpServerConfig, policy: McpPolicy): void {
  if (cfg.transport === "stdio") {
    if (policy.allowStdio === false) throw new ForgeError("FORBIDDEN", "stdio MCP servers are disabled on this deployment");
    if (policy.allowedCommands && !policy.allowedCommands.includes(cfg.command!)) throw new ForgeError("FORBIDDEN", `MCP command "${cfg.command}" is not allowed`);
  }
}

/** SSRF-checked fetch for long-lived MCP HTTP streams: every request URL is re-validated, redirects refused. */
function guardedStreamFetch(policy: UrlPolicy): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    await assertPublicUrl(url, policy);
    return fetch(input, { ...init, redirect: "error" });
  }) as typeof fetch;
}

async function withHeaders<T>(cfg: McpServerConfig, opts: McpToolOptions, fn: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const entries = Object.entries(cfg.headerSecrets);
  if (entries.length && (!opts.vault || !opts.scope)) throw new ForgeError("BAD_INPUT", `MCP server ${cfg.name} needs a vault + scope for headerSecrets`);
  const step = async (i: number, acc: Record<string, string>): Promise<T> => {
    if (i >= entries.length) return fn(acc);
    const [header, secret] = entries[i]!;
    return opts.vault!.use(opts.scope!, secret, (value) => step(i + 1, { ...acc, [header]: value }));
  };
  return step(0, { ...cfg.headers });
}

/** Run `fn` with a short-lived MCP session (credentials exist only for the duration of the call). */
export async function withMcpSession<T>(input: McpServerInput, opts: McpToolOptions, fn: (s: McpSession) => Promise<T>): Promise<T> {
  const cfg = McpServerConfigSchema.parse(input);
  const policy = opts.policy ?? {};
  checkPolicy(cfg, policy);
  if (cfg.transport === "http") await assertPublicUrl(cfg.url!, policy);
  return withHeaders(cfg, opts, async (headers) => {
    const connectCfg: McpConnectConfig = { ...cfg, headers };
    const session = await connectMcp(connectCfg, { fetch: cfg.transport === "http" ? guardedStreamFetch(policy) : undefined, timeoutMs: opts.timeoutMs });
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  });
}

/** MCP tools are irreversible when annotated destructive, or (unless read-only) named send/post/delete/pay-like. */
export function mcpToolIrreversible(t: McpToolInfo): boolean {
  if (t.annotations?.destructiveHint === true) return true;
  if (t.annotations?.readOnlyHint === true) return false;
  return isIrreversibleActionName(t.name);
}

function wrapTools(cfg: McpServerConfig, infos: McpToolInfo[], call: (name: string, args: Record<string, unknown>) => Promise<string | Record<string, unknown>>): ForgeTool[] {
  return infos.map((t) =>
    defineTool({
      name: toolName("mcp", cfg.name, t.name),
      description: `${t.description ?? t.annotations?.title ?? t.name} (MCP server ${cfg.name})`,
      input: jsonSchemaToZod(t.inputSchema),
      irreversible: mcpToolIrreversible(t),
      run: async (input) => call(t.name, (input ?? {}) as Record<string, unknown>),
    }),
  ) as ForgeTool[];
}

function resultOf(cfgName: string, toolNameStr: string, r: { isError: boolean; text: string; structured?: Record<string, unknown> }): string | Record<string, unknown> {
  if (r.isError) throw new Error(`MCP ${cfgName}.${toolNameStr} error: ${r.text.slice(0, 2000)}`);
  return r.structured ?? r.text;
}

/** ForgeTools wrapping the server's listTools/callTool. Stateless: each call opens and closes its own session. */
export async function mcpTools(input: McpServerInput, opts: McpToolOptions = {}): Promise<ForgeTool[]> {
  const cfg = McpServerConfigSchema.parse(input);
  const infos = await withMcpSession(cfg, opts, (s) => s.listTools());
  return wrapTools(cfg, infos, (name, args) => withMcpSession(cfg, opts, async (s) => resultOf(cfg.name, name, await s.callTool(name, args))));
}

/** Persistent variant (one session reused across calls; cheaper for stdio servers). Call `close()` when done. */
export async function openMcpTools(input: McpServerInput, opts: McpToolOptions = {}): Promise<{ tools: ForgeTool[]; close(): Promise<void> }> {
  const cfg = McpServerConfigSchema.parse(input);
  if (Object.keys(cfg.headerSecrets).length) throw new ForgeError("BAD_INPUT", "openMcpTools does not support headerSecrets; use mcpTools (per-call credential lending)");
  const policy = opts.policy ?? {};
  checkPolicy(cfg, policy);
  if (cfg.transport === "http") await assertPublicUrl(cfg.url!, policy);
  const session = await connectMcp({ ...cfg }, { fetch: cfg.transport === "http" ? guardedStreamFetch(policy) : undefined, timeoutMs: opts.timeoutMs });
  const infos = await session.listTools();
  return { tools: wrapTools(cfg, infos, async (name, args) => resultOf(cfg.name, name, await session.callTool(name, args))), close: () => session.close() };
}

/** Per-workspace registry of MCP servers. */
export class McpRegistry {
  constructor(
    private readonly store: McpServerStore = new MemoryMcpServerStore(),
    private readonly policy: McpPolicy = {},
  ) {}

  async add(workspaceId: string, input: McpServerInput, meta: { userId: string } = { userId: "system" }): Promise<McpServerConfig> {
    const parsed = McpServerConfigSchema.safeParse(input);
    if (!parsed.success) throw new ForgeError("BAD_INPUT", `Invalid MCP server config: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    checkPolicy(parsed.data, this.policy);
    if (parsed.data.transport === "http") await assertPublicUrl(parsed.data.url!, this.policy);
    await this.store.put(workspaceId, parsed.data, meta);
    return parsed.data;
  }

  async remove(workspaceId: string, name: string): Promise<boolean> {
    return this.store.delete(workspaceId, name);
  }

  list(workspaceId: string): Promise<McpServerConfig[]> {
    return this.store.list(workspaceId);
  }

  async get(workspaceId: string, name: string): Promise<McpServerConfig> {
    const c = await this.store.get(workspaceId, name);
    if (!c) throw new ForgeError("NOT_FOUND", `MCP server "${name}" not registered in this workspace`);
    return c;
  }

  /** Tools of one registered server (credentials resolved from the vault in the workspace/project scope). */
  async tools(workspaceId: string, name: string, opts: Omit<McpToolOptions, "policy"> = {}): Promise<ForgeTool[]> {
    const cfg = await this.get(workspaceId, name);
    return mcpTools(cfg, { ...opts, scope: opts.scope ?? { workspaceId }, policy: this.policy });
  }
}
