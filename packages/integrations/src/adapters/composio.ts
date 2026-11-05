import { z } from "zod";
import { ForgeError } from "@forge/shared";
import { CatalogBackedProvider } from "../connector-base.js";
import { actionIrreversible, findCatalogApp } from "../catalog.js";
import type { ActionDef, ActionResult, ConnectionInfo, ConnectorProvider, ExecuteActionInput, InitiateConnectionInput, InitiatedConnection } from "../types.js";
import { vendorJson } from "./http.js";

export interface ComposioOptions {
  apiKey: string;
  /** Composio REST API v3 base URL. */
  baseUrl?: string;
  /** Pre-created auth config ids per catalog app (otherwise looked up / created with Composio-managed auth). */
  authConfigIds?: Record<string, string>;
}

const AuthConfigList = z.object({ items: z.array(z.object({ id: z.string() }).passthrough()).default([]) }).passthrough();
const AuthConfigCreated = z.object({ auth_config: z.object({ id: z.string() }).passthrough() }).passthrough();
const ConnectedAccountCreated = z
  .object({ id: z.string(), redirect_url: z.string().nullish(), redirect_uri: z.string().nullish(), status: z.string().optional() })
  .passthrough();
const ConnectedAccount = z
  .object({
    id: z.string(),
    status: z.string(),
    toolkit: z.object({ slug: z.string() }).passthrough().optional(),
    params: z.record(z.unknown()).nullish(),
    state: z.object({ val: z.record(z.unknown()).nullish() }).passthrough().nullish(),
  })
  .passthrough();
const ToolList = z
  .object({
    items: z
      .array(z.object({ slug: z.string(), name: z.string().optional(), description: z.string().nullish(), input_parameters: z.record(z.unknown()).nullish() }).passthrough())
      .default([]),
  })
  .passthrough();
const ExecuteResult = z.object({ data: z.unknown(), successful: z.boolean(), error: z.string().nullish() }).passthrough();

const STATUS: Record<string, ConnectionInfo["status"]> = {
  ACTIVE: "active",
  INITIATED: "pending",
  INITIALIZING: "pending",
  FAILED: "failed",
  EXPIRED: "expired",
  INACTIVE: "revoked",
};

function scopesFrom(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** Composio REST API v3 (auth configs, connected accounts, tools/execute). Auth: `x-api-key`. */
export class ComposioConnectorProvider extends CatalogBackedProvider implements ConnectorProvider {
  readonly name = "composio";
  readonly isMock = false;
  private readonly base: string;
  private readonly toolkitByConnection = new Map<string, string>();

  constructor(private readonly opts: ComposioOptions) {
    super();
    if (!opts.apiKey) throw new ForgeError("BAD_INPUT", "COMPOSIO_API_KEY is required");
    this.base = (opts.baseUrl ?? "https://backend.composio.dev/api/v3").replace(/\/$/, "");
  }

  private call<T>(path: string, req: Parameters<typeof vendorJson>[2], schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    return vendorJson("composio", `${this.base}${path}`, { ...req, headers: { "x-api-key": this.opts.apiKey } }, schema);
  }

  private toolkit(app: string): string {
    return findCatalogApp(app)?.vendor.composio ?? app.toLowerCase();
  }

  private async authConfigId(app: string, scopes: string[]): Promise<string> {
    const pre = this.opts.authConfigIds?.[app];
    if (pre) return pre;
    const toolkit = this.toolkit(app);
    const list = await this.call("/auth_configs", { query: { toolkit_slug: toolkit, limit: 1 } }, AuthConfigList);
    if (list.items[0]) return list.items[0].id;
    const created = await this.call(
      "/auth_configs",
      {
        method: "POST",
        body: { toolkit: { slug: toolkit }, auth_config: { type: "use_composio_managed_auth", ...(scopes.length ? { credentials: { scopes: scopes.join(",") } } : {}) } },
      },
      AuthConfigCreated,
    );
    return created.auth_config.id;
  }

  async initiateConnection(input: InitiateConnectionInput): Promise<InitiatedConnection> {
    const app = this.app(input.app);
    const authConfig = await this.authConfigId(app.slug, input.scopes);
    const r = await this.call(
      "/connected_accounts",
      { method: "POST", body: { auth_config: { id: authConfig }, connection: { user_id: `${input.workspaceId}:${input.userId}`, callback_url: input.redirectUrl } } },
      ConnectedAccountCreated,
    );
    const redirectUrl = r.redirect_url ?? r.redirect_uri;
    if (!redirectUrl) throw new ForgeError("PROVIDER_ERROR", "Composio did not return a redirect URL");
    this.toolkitByConnection.set(r.id, app.vendor.composio);
    return { connectionId: r.id, redirectUrl };
  }

  async getConnection(connectionId: string): Promise<ConnectionInfo> {
    const r = await this.call(`/connected_accounts/${encodeURIComponent(connectionId)}`, {}, ConnectedAccount);
    if (r.toolkit?.slug) this.toolkitByConnection.set(r.id, r.toolkit.slug);
    const scopes = scopesFrom(r.params?.scope ?? r.state?.val?.scope);
    return { status: STATUS[r.status.toUpperCase()] ?? "pending", scopes, externalId: r.id, app: r.toolkit ? this.catalogSlug("composio", r.toolkit.slug) : undefined };
  }

  async listActions(app: string): Promise<ActionDef[]> {
    const toolkit = this.toolkit(app);
    const r = await this.call("/tools", { query: { toolkit_slug: toolkit, limit: 200 } }, ToolList);
    const prefix = `${toolkit.toUpperCase()}_`;
    return r.items.map((t) => {
      const name = (t.slug.startsWith(prefix) ? t.slug.slice(prefix.length) : t.slug).toLowerCase();
      return {
        name,
        description: t.description ?? t.name ?? name,
        inputSchema: (t.input_parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
        irreversible: actionIrreversible(app, name),
      };
    });
  }

  async executeAction(input: ExecuteActionInput): Promise<ActionResult> {
    let toolkit = this.toolkitByConnection.get(input.connectionId);
    if (!toolkit) {
      await this.getConnection(input.connectionId);
      toolkit = this.toolkitByConnection.get(input.connectionId);
    }
    const slug = /^[A-Z0-9_]+$/.test(input.action) ? input.action : `${(toolkit ?? "").toUpperCase()}_${input.action.toUpperCase()}`;
    const r = await this.call(
      `/tools/execute/${encodeURIComponent(slug)}`,
      { method: "POST", body: { connected_account_id: input.connectionId, arguments: input.input } },
      ExecuteResult,
    );
    return { ok: r.successful, data: r.data, ...(r.error ? { error: r.error } : {}) };
  }

  async revoke(connectionId: string): Promise<void> {
    await this.call(`/connected_accounts/${encodeURIComponent(connectionId)}`, { method: "DELETE" }, z.unknown());
    this.toolkitByConnection.delete(connectionId);
  }
}
