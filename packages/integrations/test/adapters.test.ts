import { describe, it, expect, vi, afterEach } from "vitest";
import { ComposioConnectorProvider, NangoConnectorProvider, PipedreamConnectorProvider } from "../src/index.js";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Route-table fetch stub: [method, path regex, response json]. */
function stubFetch(routes: Array<[string, RegExp, unknown, number?]>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      calls.push({ url, method, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = routes.find(([m, re]) => m === method && re.test(url.pathname));
      if (!r) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
      return new Response(JSON.stringify(r[2]), { status: r[3] ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const init = { workspaceId: "ws_1", userId: "usr_1", app: "hubspot", scopes: ["crm.objects.contacts.read"], redirectUrl: "https://forge.example/cb" };

describe("ComposioConnectorProvider (v3 REST)", () => {
  it("creates a connected account via auth config and executes tools", async () => {
    const calls = stubFetch([
      ["GET", /\/api\/v3\/auth_configs$/, { items: [] }],
      ["POST", /\/api\/v3\/auth_configs$/, { auth_config: { id: "ac_1" }, toolkit: { slug: "hubspot" } }],
      ["POST", /\/api\/v3\/connected_accounts$/, { id: "ca_1", redirect_url: "https://connect.composio.dev/link/abc", status: "INITIATED" }],
      ["GET", /\/api\/v3\/connected_accounts\/ca_1$/, { id: "ca_1", status: "ACTIVE", toolkit: { slug: "hubspot" }, params: { scope: "crm.objects.contacts.read oauth" } }],
      ["GET", /\/api\/v3\/tools$/, { items: [{ slug: "HUBSPOT_LIST_CONTACTS", name: "List contacts", description: "List", input_parameters: { type: "object", properties: {} } }, { slug: "HUBSPOT_DELETE_CONTACT", description: "Delete" }] }],
      ["POST", /\/api\/v3\/tools\/execute\/HUBSPOT_LIST_CONTACTS$/, { data: { results: [] }, successful: true, error: null }],
      ["DELETE", /\/api\/v3\/connected_accounts\/ca_1$/, {}],
    ]);
    const p = new ComposioConnectorProvider({ apiKey: "ck_test" });
    const c = await p.initiateConnection(init);
    expect(c).toEqual({ connectionId: "ca_1", redirectUrl: "https://connect.composio.dev/link/abc" });
    expect(calls[0]!.url.searchParams.get("toolkit_slug")).toBe("hubspot");
    expect(calls[1]!.body).toMatchObject({ toolkit: { slug: "hubspot" }, auth_config: { type: "use_composio_managed_auth" } });
    expect(calls[2]!.body).toEqual({ auth_config: { id: "ac_1" }, connection: { user_id: "ws_1:usr_1", callback_url: "https://forge.example/cb" } });
    expect(calls.every((x) => x.headers["x-api-key"] === "ck_test")).toBe(true);

    expect(await p.getConnection("ca_1")).toEqual({ status: "active", scopes: ["crm.objects.contacts.read", "oauth"], externalId: "ca_1", app: "hubspot" });
    const actions = await p.listActions("hubspot");
    expect(actions.map((a) => [a.name, a.irreversible])).toEqual([["list_contacts", false], ["delete_contact", true]]);
    const r = await p.executeAction({ connectionId: "ca_1", action: "list_contacts", input: { limit: 2 } });
    expect(r).toEqual({ ok: true, data: { results: [] } });
    expect(calls.at(-1)!.body).toEqual({ connected_account_id: "ca_1", arguments: { limit: 2 } });
    await p.revoke("ca_1");
    expect(calls.at(-1)!.method).toBe("DELETE");
  });

  it("maps vendor errors to PROVIDER_ERROR", async () => {
    stubFetch([["GET", /connected_accounts/, { error: "bad key" }, 401]]);
    const p = new ComposioConnectorProvider({ apiKey: "bad" });
    await expect(p.getConnection("ca_x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});

describe("NangoConnectorProvider", () => {
  it("creates a connect session, resolves the connection and triggers actions", async () => {
    const calls = stubFetch([
      ["POST", /^\/connect\/sessions$/, { data: { token: "nango_tok", connect_link: "https://connect.nango.dev?session_token=nango_tok", expires_at: "2026-11-05T13:00:00Z" } }],
      ["GET", /^\/connection$/, { connections: [{ connection_id: "conn-123", provider_config_key: "hubspot" }] }],
      ["GET", /^\/connection\/conn-123$/, { connection_id: "conn-123", provider_config_key: "hubspot", credentials: { access_token: "SECRET", raw: { scope: "crm.objects.contacts.read" } } }],
      ["POST", /^\/action\/trigger$/, { contacts: [{ id: "1" }] }],
      ["GET", /^\/proxy\/crm\/v3\/objects\/contacts$/, { results: [] }],
      ["GET", /^\/scripts\/config$/, [{ providerConfigKey: "hubspot", actions: [{ name: "create-note", description: "Create note", json_schema: { type: "object" } }] }]],
      ["DELETE", /^\/connection\/conn-123$/, {}],
    ]);
    const p = new NangoConnectorProvider({ secretKey: "nk_test" });
    const c = await p.initiateConnection(init);
    expect(c.connectionId).toMatch(/^nango_/);
    expect(new URL(c.redirectUrl).searchParams.get("session_token")).toBe("nango_tok");
    expect(calls[0]!.body).toMatchObject({ end_user: { id: "ws_1:usr_1" }, allowed_integrations: ["hubspot"] });
    expect(calls[0]!.headers.authorization).toBe("Bearer nk_test");

    const info = await p.getConnection(c.connectionId);
    expect(info).toEqual({ status: "active", scopes: ["crm.objects.contacts.read"], externalId: "conn-123", app: "hubspot" });
    expect(JSON.stringify(info)).not.toContain("SECRET");

    const r = await p.executeAction({ connectionId: c.connectionId, action: "list-contacts", input: { limit: 1 } });
    expect(r).toEqual({ ok: true, data: { contacts: [{ id: "1" }] } });
    const trig = calls.find((x) => x.url.pathname === "/action/trigger")!;
    expect(trig.headers["connection-id"]).toBe("conn-123");
    expect(trig.headers["provider-config-key"]).toBe("hubspot");
    expect(trig.body).toEqual({ action_name: "list-contacts", input: { limit: 1 } });

    await p.executeAction({ connectionId: c.connectionId, action: "proxy", input: { method: "GET", path: "/crm/v3/objects/contacts" } });
    await expect(p.executeAction({ connectionId: c.connectionId, action: "proxy", input: { method: "GET", path: "https://evil.example/x" } })).rejects.toThrow(/relative/);
    const actions = await p.listActions("hubspot");
    expect(actions.map((a) => a.name)).toEqual(["create-note", "proxy"]);
    await p.revoke(c.connectionId);
    expect(calls.at(-1)!.url.searchParams.get("provider_config_key")).toBe("hubspot");
  });

  it("reports pending until the user finishes the connect UI", async () => {
    stubFetch([
      ["POST", /^\/connect\/sessions$/, { data: { token: "t" } }],
      ["GET", /^\/connection$/, { connections: [] }],
    ]);
    const p = new NangoConnectorProvider({ secretKey: "k", baseUrl: "https://nango.eu.example" });
    const c = await p.initiateConnection(init);
    expect(c.redirectUrl).toMatch(/^https:\/\/connect\.nango\.dev\/?\?session_token=t/);
    expect(await p.getConnection(c.connectionId)).toMatchObject({ status: "pending", externalId: null, scopes: ["crm.objects.contacts.read"] });
    expect((await p.executeAction({ connectionId: c.connectionId, action: "x", input: {} })).ok).toBe(false);
    await expect(p.getConnection("nango_garbage!")).rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});

describe("PipedreamConnectorProvider", () => {
  it("uses client-credentials token, connect tokens, accounts and actions/run", async () => {
    const calls = stubFetch([
      ["POST", /^\/v1\/oauth\/token$/, { access_token: "pd_at", expires_in: 3600 }],
      ["POST", /^\/v1\/connect\/proj_1\/tokens$/, { token: "ctok", connect_link_url: "https://pipedream.com/_static/connect.html?token=ctok&connectLink=true", expires_at: "x" }],
      ["GET", /^\/v1\/connect\/proj_1\/accounts$/, { data: [{ id: "apn_1", healthy: true, dead: false, app: { name_slug: "slack" } }] }],
      ["GET", /^\/v1\/connect\/proj_1\/actions$/, { data: [{ key: "slack-send-message", name: "Send Message", description: "Send", configurable_props: [{ name: "slack", type: "app", app: "slack" }, { name: "channel", type: "string" }, { name: "text", type: "string" }, { name: "mrkdwn", type: "boolean", optional: true }] }] }],
      ["POST", /^\/v1\/connect\/proj_1\/actions\/run$/, { exports: {}, os: [], ret: { ok: true, ts: "1.2" } }],
      ["DELETE", /^\/v1\/connect\/proj_1\/accounts\/apn_1$/, {}],
    ]);
    const p = new PipedreamConnectorProvider({ clientId: "cid", clientSecret: "csec", projectId: "proj_1", environment: "development" });
    const c = await p.initiateConnection({ ...init, app: "slack", scopes: ["chat:write"] });
    expect(new URL(c.redirectUrl).searchParams.get("app")).toBe("slack");
    expect(calls[0]!.body).toEqual({ grant_type: "client_credentials", client_id: "cid", client_secret: "csec" });
    expect(calls[1]!.headers.authorization).toBe("Bearer pd_at");
    expect(calls[1]!.headers["x-pd-environment"]).toBe("development");
    expect(calls[1]!.body).toMatchObject({ external_user_id: "ws_1:usr_1", success_redirect_uri: "https://forge.example/cb" });

    expect(await p.getConnection(c.connectionId)).toEqual({ status: "active", scopes: ["chat:write"], externalId: "apn_1", app: "slack" });
    const actions = await p.listActions("slack");
    expect(actions[0]).toMatchObject({ name: "send_message", irreversible: true, inputSchema: { required: ["channel", "text"] } });
    expect(Object.keys((actions[0]!.inputSchema as { properties: object }).properties)).toEqual(["channel", "text", "mrkdwn"]);
    const r = await p.executeAction({ connectionId: c.connectionId, action: "send_message", input: { channel: "C1", text: "hi" } });
    expect(r).toEqual({ ok: true, data: { ok: true, ts: "1.2" } });
    expect(calls.find((x) => x.url.pathname.endsWith("/actions/run"))!.body).toEqual({
      id: "slack-send-message",
      external_user_id: "ws_1:usr_1",
      configured_props: { slack: { authProvisionId: "apn_1" }, channel: "C1", text: "hi" },
    });
    expect(calls.filter((x) => x.url.pathname === "/v1/oauth/token")).toHaveLength(1); // token cached
    await p.revoke(c.connectionId);
    expect(calls.at(-1)!.method).toBe("DELETE");
  });
});
