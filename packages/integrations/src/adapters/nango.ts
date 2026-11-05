import { z } from "zod";
import { ForgeError } from "@forge/shared";
import { CatalogBackedProvider } from "../connector-base.js";
import { actionIrreversible, findCatalogApp } from "../catalog.js";
import type { ActionDef, ActionResult, ConnectionInfo, ConnectorProvider, ExecuteActionInput, InitiateConnectionInput, InitiatedConnection } from "../types.js";
import { decodeConnectionId, encodeConnectionId, vendorJson } from "./http.js";

export interface NangoOptions {
  secretKey: string;
  /** Nango API base (cloud or a self-hosted EU instance). */
  baseUrl?: string;
  /** Hosted Connect UI base used when the session response has no connect_link. */
  connectUiUrl?: string;
  /** Integration unique keys (provider config keys) per catalog app; default = catalog vendor.nango. */
  integrationKeys?: Record<string, string>;
}

/** Forge connection id payload: k = provider config key, u = end user id, c = Nango connection id once known. */
const Ref = z.object({ k: z.string(), u: z.string(), c: z.string().optional(), s: z.array(z.string()).default([]) });
type Ref = z.infer<typeof Ref>;

const Session = z.object({ data: z.object({ token: z.string(), connect_link: z.string().optional(), expires_at: z.string().optional() }).passthrough() });
const ConnectionList = z.object({
  connections: z.array(z.object({ connection_id: z.string(), provider_config_key: z.string(), errors: z.array(z.unknown()).optional() }).passthrough()).default([]),
});
const ConnectionDetail = z
  .object({
    connection_id: z.string(),
    provider_config_key: z.string(),
    // Only the granted scope is read from credentials; tokens are never surfaced.
    credentials: z.object({ raw: z.object({ scope: z.union([z.string(), z.array(z.string())]).optional() }).passthrough().optional() }).passthrough().optional(),
    connection_config: z.record(z.unknown()).optional(),
  })
  .passthrough();
const ScriptsConfig = z.array(
  z
    .object({
      providerConfigKey: z.string(),
      actions: z
        .array(z.object({ name: z.string(), description: z.string().nullish(), input: z.unknown().optional(), json_schema: z.unknown().optional() }).passthrough())
        .default([]),
    })
    .passthrough(),
);

const PROXY_ACTION: ActionDef = {
  name: "proxy",
  description: "Call the app's REST API through the Nango proxy with the user's credentials",
  inputSchema: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      path: { type: "string", description: "API path relative to the provider base URL" },
      query: { type: "object", additionalProperties: { type: "string" } },
      body: {},
    },
    required: ["method", "path"],
  },
  irreversible: true,
};

/** Nango REST API: connect sessions, connections, action scripts and the authenticated proxy. Auth: Bearer secret key. */
export class NangoConnectorProvider extends CatalogBackedProvider implements ConnectorProvider {
  readonly name = "nango";
  readonly isMock = false;
  private readonly base: string;
  private readonly connectUi: string;

  constructor(private readonly opts: NangoOptions) {
    super();
    if (!opts.secretKey) throw new ForgeError("BAD_INPUT", "NANGO_SECRET_KEY is required");
    this.base = (opts.baseUrl ?? "https://api.nango.dev").replace(/\/$/, "");
    this.connectUi = opts.connectUiUrl ?? "https://connect.nango.dev";
  }

  private call<T>(path: string, req: Parameters<typeof vendorJson>[2], schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    return vendorJson("nango", `${this.base}${path}`, { ...req, headers: { authorization: `Bearer ${this.opts.secretKey}`, ...(req.headers ?? {}) } }, schema);
  }

  private key(app: string): string {
    return this.opts.integrationKeys?.[app] ?? findCatalogApp(app)?.vendor.nango ?? app;
  }

  async initiateConnection(input: InitiateConnectionInput): Promise<InitiatedConnection> {
    const app = this.app(input.app);
    const key = this.key(app.slug);
    const endUser = `${input.workspaceId}:${input.userId}`;
    const r = await this.call(
      "/connect/sessions",
      {
        method: "POST",
        body: {
          end_user: { id: endUser },
          organization: { id: input.workspaceId },
          allowed_integrations: [key],
          ...(input.scopes.length ? { integrations_config_defaults: { [key]: { connection_config: { oauth_scopes_override: input.scopes.join(",") } } } } : {}),
        },
      },
      Session,
    );
    const link = new URL(r.data.connect_link ?? this.connectUi);
    if (!r.data.connect_link) link.searchParams.set("session_token", r.data.token);
    link.searchParams.set("redirect_uri", input.redirectUrl);
    return { connectionId: encodeConnectionId("nango", { k: key, u: endUser, s: input.scopes } satisfies Ref), redirectUrl: link.toString() };
  }

  /** Resolve the Nango connection id (exists only after the user finished the Connect UI). */
  private async resolve(ref: Ref): Promise<string | null> {
    if (ref.c) return ref.c;
    const list = await this.call("/connection", { query: { endUserId: ref.u } }, ConnectionList);
    return list.connections.find((c) => c.provider_config_key === ref.k)?.connection_id ?? null;
  }

  async getConnection(connectionId: string): Promise<ConnectionInfo> {
    const ref = decodeConnectionId("nango", connectionId, Ref);
    const app = this.catalogSlug("nango", ref.k);
    const id = await this.resolve(ref);
    if (!id) return { status: "pending", scopes: ref.s, externalId: null, app };
    const d = await this.call(`/connection/${encodeURIComponent(id)}`, { query: { provider_config_key: ref.k } }, ConnectionDetail);
    const raw = d.credentials?.raw?.scope;
    const scopes = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/).filter(Boolean) : ref.s;
    return { status: "active", scopes, externalId: d.connection_id, app };
  }

  async listActions(app: string): Promise<ActionDef[]> {
    const key = this.key(this.app(app).slug);
    const cfg = await this.call("/scripts/config", {}, ScriptsConfig);
    const actions = cfg.filter((c) => c.providerConfigKey === key).flatMap((c) => c.actions);
    return [
      ...actions.map((a) => ({
        name: a.name,
        description: a.description ?? a.name,
        inputSchema: ((a.json_schema ?? a.input) as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
        irreversible: actionIrreversible(app, a.name),
      })),
      PROXY_ACTION,
    ];
  }

  async executeAction(input: ExecuteActionInput): Promise<ActionResult> {
    const ref = decodeConnectionId("nango", input.connectionId, Ref);
    const id = await this.resolve(ref);
    if (!id) return { ok: false, data: null, error: "Connection is pending: the user has not completed authorization" };
    const headers = { "Connection-Id": id, "Provider-Config-Key": ref.k };
    if (input.action === "proxy") {
      const p = z
        .object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().min(1), query: z.record(z.string()).optional(), body: z.unknown().optional() })
        .parse(input.input);
      if (/^[a-z]+:\/\//i.test(p.path) || p.path.includes("..")) throw new ForgeError("BAD_INPUT", "Proxy path must be a relative API path");
      const data = await this.call(`/proxy/${p.path.replace(/^\//, "")}`, { method: p.method, headers, query: p.query, body: p.body }, z.unknown());
      return { ok: true, data };
    }
    const data = await this.call("/action/trigger", { method: "POST", headers, body: { action_name: input.action, input: input.input } }, z.unknown());
    return { ok: true, data };
  }

  async revoke(connectionId: string): Promise<void> {
    const ref = decodeConnectionId("nango", connectionId, Ref);
    const id = await this.resolve(ref);
    if (!id) return;
    await this.call(`/connection/${encodeURIComponent(id)}`, { method: "DELETE", query: { provider_config_key: ref.k } }, z.unknown());
  }
}
