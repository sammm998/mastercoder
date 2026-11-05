import { z } from "zod";
import { ForgeError } from "@forge/shared";
import type { JsonSchema } from "@forge/llm";
import { CatalogBackedProvider } from "../connector-base.js";
import { actionIrreversible, findCatalogApp } from "../catalog.js";
import type { ActionDef, ActionResult, ConnectionInfo, ConnectorProvider, ExecuteActionInput, InitiateConnectionInput, InitiatedConnection } from "../types.js";
import { decodeConnectionId, encodeConnectionId, vendorJson } from "./http.js";

export interface PipedreamOptions {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment?: "production" | "development";
  baseUrl?: string;
}

/** a = Pipedream app slug, u = external user id, id = account id once connected, s = requested scopes. */
const Ref = z.object({ a: z.string(), u: z.string(), id: z.string().optional(), s: z.array(z.string()).default([]) });
type Ref = z.infer<typeof Ref>;

const Token = z.object({ access_token: z.string(), expires_in: z.number().default(3600) }).passthrough();
const ConnectToken = z.object({ token: z.string(), connect_link_url: z.string(), expires_at: z.string().optional() }).passthrough();
const Account = z.object({ id: z.string(), healthy: z.boolean().nullish(), dead: z.boolean().nullish(), app: z.object({ name_slug: z.string() }).passthrough().optional() }).passthrough();
const AccountList = z.object({ data: z.array(Account).default([]) }).passthrough();
const Prop = z.object({ name: z.string(), type: z.string(), optional: z.boolean().optional(), description: z.string().nullish(), label: z.string().nullish(), app: z.string().optional() }).passthrough();
const ActionList = z.object({
  data: z.array(z.object({ key: z.string(), name: z.string().optional(), description: z.string().nullish(), configurable_props: z.array(Prop).default([]) }).passthrough()).default([]),
});
const RunResult = z.object({ exports: z.unknown().optional(), os: z.array(z.unknown()).optional(), ret: z.unknown().optional() }).passthrough();

function propSchema(type: string, description?: string | null): JsonSchema {
  const d = description ? { description } : {};
  if (type.endsWith("[]")) return { type: "array", items: propSchema(type.slice(0, -2)), ...d };
  if (type === "integer") return { type: "integer", ...d };
  if (type === "boolean") return { type: "boolean", ...d };
  if (type === "object") return { type: "object", additionalProperties: true, ...d };
  if (type === "string") return { type: "string", ...d };
  return { ...d };
}

/** Pipedream Connect REST API (OAuth client credentials, connect tokens, accounts, actions/run). */
export class PipedreamConnectorProvider extends CatalogBackedProvider implements ConnectorProvider {
  readonly name = "pipedream";
  readonly isMock = false;
  private readonly base: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: PipedreamOptions) {
    super();
    if (!opts.clientId || !opts.clientSecret || !opts.projectId) throw new ForgeError("BAD_INPUT", "PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET and PIPEDREAM_PROJECT_ID are required");
    this.base = (opts.baseUrl ?? "https://api.pipedream.com/v1").replace(/\/$/, "");
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const t = await vendorJson(
      "pipedream",
      `${this.base}/oauth/token`,
      { method: "POST", body: { grant_type: "client_credentials", client_id: this.opts.clientId, client_secret: this.opts.clientSecret } },
      Token,
    );
    this.token = { value: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  private async call<T>(path: string, req: Parameters<typeof vendorJson>[2], schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const token = await this.accessToken();
    return vendorJson(
      "pipedream",
      `${this.base}/connect/${encodeURIComponent(this.opts.projectId)}${path}`,
      { ...req, headers: { authorization: `Bearer ${token}`, "x-pd-environment": this.opts.environment ?? "production" } },
      schema,
    );
  }

  private pdApp(app: string): string {
    return findCatalogApp(app)?.vendor.pipedream ?? app;
  }

  async initiateConnection(input: InitiateConnectionInput): Promise<InitiatedConnection> {
    const app = this.app(input.app);
    const externalUser = `${input.workspaceId}:${input.userId}`;
    const t = await this.call(
      "/tokens",
      { method: "POST", body: { external_user_id: externalUser, success_redirect_uri: input.redirectUrl, error_redirect_uri: input.redirectUrl } },
      ConnectToken,
    );
    const link = new URL(t.connect_link_url);
    link.searchParams.set("app", app.vendor.pipedream);
    return { connectionId: encodeConnectionId("pd", { a: app.vendor.pipedream, u: externalUser, s: input.scopes } satisfies Ref), redirectUrl: link.toString() };
  }

  private async account(ref: Ref): Promise<z.infer<typeof Account> | null> {
    if (ref.id) return this.call(`/accounts/${encodeURIComponent(ref.id)}`, {}, Account);
    const list = await this.call("/accounts", { query: { external_user_id: ref.u, app: ref.a } }, AccountList);
    return list.data[0] ?? null;
  }

  async getConnection(connectionId: string): Promise<ConnectionInfo> {
    const ref = decodeConnectionId("pd", connectionId, Ref);
    const app = this.catalogSlug("pipedream", ref.a);
    const acc = await this.account(ref);
    if (!acc) return { status: "pending", scopes: ref.s, externalId: null, app };
    const status: ConnectionInfo["status"] = acc.dead ? "expired" : acc.healthy === false ? "failed" : "active";
    // Pipedream-managed OAuth apps use the app's configured scopes; Forge reports what the user consented to.
    return { status, scopes: ref.s.length ? ref.s : (findCatalogApp(app)?.defaultScopes ?? []), externalId: acc.id, app };
  }

  async listActions(app: string): Promise<ActionDef[]> {
    const slug = this.pdApp(app);
    const r = await this.call("/actions", { query: { app: slug, limit: 100 } }, ActionList);
    return r.data.map((a) => {
      const name = a.key.replace(new RegExp(`^${slug.replace(/[_-]/g, "[_-]")}-`), "").replace(/-/g, "_");
      const props = a.configurable_props.filter((p) => p.type !== "app" && !p.type.startsWith("$."));
      return {
        name,
        description: a.description ?? a.name ?? name,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(props.map((p) => [p.name, propSchema(p.type, p.description ?? p.label)])),
          required: props.filter((p) => !p.optional).map((p) => p.name),
        },
        irreversible: actionIrreversible(app, name),
      };
    });
  }

  async executeAction(input: ExecuteActionInput): Promise<ActionResult> {
    const ref = decodeConnectionId("pd", input.connectionId, Ref);
    const acc = await this.account(ref);
    if (!acc) return { ok: false, data: null, error: "Connection is pending: the user has not completed authorization" };
    // Pipedream component keys are "<app_slug>-<kebab-action>", e.g. "slack-send-message".
    const componentKey = input.action.includes("-") ? input.action : `${ref.a}-${input.action.replace(/_/g, "-")}`;
    const r = await this.call(
      "/actions/run",
      { method: "POST", body: { id: componentKey, external_user_id: ref.u, configured_props: { [ref.a]: { authProvisionId: acc.id }, ...input.input } } },
      RunResult,
    );
    return { ok: true, data: r.ret ?? r.exports ?? null };
  }

  async revoke(connectionId: string): Promise<void> {
    const ref = decodeConnectionId("pd", connectionId, Ref);
    const acc = await this.account(ref);
    if (acc) await this.call(`/accounts/${encodeURIComponent(acc.id)}`, { method: "DELETE" }, z.unknown());
  }
}
