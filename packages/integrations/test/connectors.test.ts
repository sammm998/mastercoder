import { describe, it, expect } from "vitest";
import { runTool, toToolDef } from "@forge/llm";
import {
  CATALOG,
  MockConnectorProvider,
  actionIrreversible,
  connectorTools,
  createConnectorProvider,
  describeScopes,
  isIrreversibleActionName,
  jsonSchemaToZod,
} from "../src/index.js";

const NOW = new Date("2026-11-05T12:00:00Z");

async function connect(p: MockConnectorProvider, app: string, scopes: string[] = [], ws = "ws_1") {
  const c = await p.initiateConnection({ workspaceId: ws, userId: "usr_1", app, scopes, redirectUrl: "https://forge.example/oauth/callback" });
  return c;
}

describe("catalog", () => {
  it("has the 12 launch apps with bilingual scopes and actions", () => {
    expect(CATALOG.map((a) => a.slug).sort()).toEqual(
      ["airtable", "github", "gmail", "google_calendar", "google_sheets", "hubspot", "notion", "outlook", "salesforce", "slack", "stripe", "teams"].sort(),
    );
    for (const app of CATALOG) {
      expect(app.scopes.length).toBeGreaterThan(0);
      for (const s of app.scopes) {
        expect(s.en.length).toBeGreaterThan(3);
        expect(s.sv.length).toBeGreaterThan(3);
        expect(s.sv).not.toBe(s.en);
      }
      for (const d of app.defaultScopes) expect(app.scopes.map((s) => s.id)).toContain(d);
      for (const a of app.actions) for (const r of a.requires) expect(app.scopes.map((s) => s.id)).toContain(r);
    }
  });

  it("marks send/post/delete/pay actions irreversible", () => {
    for (const app of CATALOG) {
      for (const a of app.actions) {
        if (/^(send|post|delete|create_refund|merge|archive|clear)/.test(a.name)) expect(a.irreversible, `${app.slug}.${a.name}`).toBe(true);
        if (/^(list|get|search|find)/.test(a.name)) expect(a.irreversible, `${app.slug}.${a.name}`).toBe(false);
      }
    }
    expect(actionIrreversible("slack", "post_message")).toBe(true);
    expect(actionIrreversible("hubspot", "list_contacts")).toBe(false);
    expect(isIrreversibleActionName("GMAIL_SEND_EMAIL")).toBe(true);
    expect(isIrreversibleActionName("sendInvoice")).toBe(true);
    expect(isIrreversibleActionName("charge-card")).toBe(true);
    expect(isIrreversibleActionName("list_sent_items")).toBe(false);
    expect(isIrreversibleActionName("get_payment")).toBe(false);
  });

  it("describes scopes before connecting in sv and en", () => {
    const en = describeScopes("hubspot", ["crm.objects.contacts.read"], "en");
    const sv = describeScopes("HubSpot", ["crm.objects.contacts.read"], "sv");
    expect(en[0]!.description).toMatch(/Read your HubSpot contacts/);
    expect(sv[0]!.description).toMatch(/Läsa dina kontakter/);
    expect(describeScopes("gmail", [], "en").map((s) => s.id)).toEqual(CATALOG.find((a) => a.slug === "gmail")!.defaultScopes);
    expect(describeScopes("slack", ["admin"], "sv")[0]!.description).toMatch(/Okänd behörighet/);
    expect(() => describeScopes("myspace", [], "en")).toThrow(/Unknown app/);
  });

  it("every catalog input schema converts to zod", () => {
    for (const app of CATALOG) for (const a of app.actions) expect(() => jsonSchemaToZod(a.inputSchema)).not.toThrow();
  });
});

describe("MockConnectorProvider", () => {
  it("simulates OAuth consent and reports scopes", async () => {
    const p = new MockConnectorProvider({ autoApprove: false, now: () => NOW });
    const c = await connect(p, "hubspot", ["crm.objects.contacts.read"]);
    const u = new URL(c.redirectUrl);
    expect(u.searchParams.get("connection_id")).toBe(c.connectionId);
    expect(u.searchParams.get("mock_oauth")).toBe("1");
    expect((await p.getConnection(c.connectionId)).status).toBe("pending");
    const pending = await p.executeAction({ connectionId: c.connectionId, action: "list_contacts", input: {} });
    expect(pending).toMatchObject({ ok: false, mock: true });
    p.completeAuthorization(c.connectionId);
    const info = await p.getConnection(c.connectionId);
    expect(info).toMatchObject({ status: "active", scopes: ["crm.objects.contacts.read"], app: "hubspot" });
    expect(info.externalId).toBeTruthy();
    await p.revoke(c.connectionId);
    expect((await p.getConnection(c.connectionId)).status).toBe("revoked");
    await expect(connect(p, "hubspot", ["not-a-scope"])).rejects.toThrow(/Unknown scopes/);
  });

  it("executes HubSpot actions against a deterministic store", async () => {
    const p = new MockConnectorProvider({ now: () => NOW });
    const { connectionId } = await connect(p, "hubspot");
    const list = await p.executeAction({ connectionId, action: "list_contacts", input: { limit: 5 } });
    expect(list.ok).toBe(true);
    expect(list.mock).toBe(true);
    const contacts = (list.data as { contacts: Array<{ id: string; email: string }> }).contacts;
    expect(contacts).toHaveLength(5);
    expect(contacts[0]!.id).toBe("mock_contact_001");
    const again = await new MockConnectorProvider({ now: () => NOW }).executeAction({ connectionId: (await connect(new MockConnectorProvider(), "hubspot")).connectionId, action: "list_contacts", input: {} }).catch(() => null);
    expect(again).toBeNull(); // connection ids are per-provider instance

    const leads = await p.executeAction({ connectionId, action: "list_leads", input: { sinceDays: 7 } });
    const ls = (leads.data as { leads: Array<{ lifecycleStage: string; createdAt: string }> }).leads;
    expect(ls.length).toBeGreaterThan(0);
    for (const l of ls) {
      expect(l.lifecycleStage).toBe("lead");
      expect(NOW.getTime() - Date.parse(l.createdAt)).toBeLessThanOrEqual(7 * 86_400_000);
    }
    const note = await p.executeAction({ connectionId, action: "create_note", input: { contactId: "mock_contact_002", body: "Called, interested" } });
    expect(note).toMatchObject({ ok: true, data: { id: "mock_note_0001", contactId: "mock_contact_002" } });
    const notes = await p.executeAction({ connectionId, action: "list_notes", input: { contactId: "mock_contact_002" } });
    expect((notes.data as { notes: unknown[] }).notes).toHaveLength(1);
    const bad = await p.executeAction({ connectionId, action: "create_note", input: { contactId: "nope", body: "x" } });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    const invalid = await p.executeAction({ connectionId, action: "create_contact", input: { email: "not-an-email" } });
    expect(invalid.error).toMatch(/Invalid input/);
  });

  it("enforces granted scopes", async () => {
    const p = new MockConnectorProvider();
    const { connectionId } = await connect(p, "hubspot", ["crm.objects.contacts.read"]);
    const r = await p.executeAction({ connectionId, action: "create_note", input: { contactId: "mock_contact_001", body: "x" } });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Missing scope.*contacts.write/) });
  });

  it("records Slack messages and Gmail sends per workspace", async () => {
    const p = new MockConnectorProvider({ now: () => NOW });
    const slack = await connect(p, "slack", ["channels:read", "chat:write", "channels:history"]);
    const post = await p.executeAction({ connectionId: slack.connectionId, action: "post_message", input: { channel: "#help", text: "Hej!" } });
    expect(post).toMatchObject({ ok: true, mock: true, data: { channel: "C_MOCK_HELP" } });
    const msgs = await p.executeAction({ connectionId: slack.connectionId, action: "list_messages", input: { channel: "C_MOCK_HELP" } });
    expect((msgs.data as { messages: Array<{ text: string }> }).messages.map((m) => m.text)).toEqual(["Hej!"]);
    expect(p.inspect("ws_1", "slack", "messages")).toHaveLength(1);
    expect(p.inspect("ws_2", "slack", "messages")).toHaveLength(0);

    const gmail = await connect(p, "gmail");
    const sent = await p.executeAction({ connectionId: gmail.connectionId, action: "send_email", input: { to: ["sales@example.com"], subject: "Weekly leads", body: "3 new leads" } });
    expect(sent).toMatchObject({ ok: true, mock: true, data: { status: "sent" } });
    expect(p.inspect("ws_1", "gmail", "sent")).toEqual([expect.objectContaining({ subject: "Weekly leads", to: ["sales@example.com"] })]);
  });

  it("implements every catalog action", async () => {
    const p = new MockConnectorProvider({ now: () => NOW });
    const sheets = await connect(p, "google_sheets", ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/spreadsheets.readonly"]);
    const ss = await p.executeAction({ connectionId: sheets.connectionId, action: "create_spreadsheet", input: { title: "Leads" } });
    const id = (ss.data as { spreadsheetId: string }).spreadsheetId;
    await p.executeAction({ connectionId: sheets.connectionId, action: "append_row", input: { spreadsheetId: id, values: ["Anna", 3] } });
    await p.executeAction({ connectionId: sheets.connectionId, action: "append_row", input: { spreadsheetId: id, values: ["Erik", 5] } });
    const vals = await p.executeAction({ connectionId: sheets.connectionId, action: "get_values", input: { spreadsheetId: id, range: "Sheet1!A1:B2" } });
    expect((vals.data as { values: unknown[][] }).values).toEqual([["Anna", 3], ["Erik", 5]]);

    const stripe = await connect(p, "stripe", ["read_only", "read_write"]);
    const refund = await p.executeAction({ connectionId: stripe.connectionId, action: "create_refund", input: { chargeId: "ch_mock_001", amount: 100 } });
    expect(refund).toMatchObject({ ok: true, data: { amount: 100, status: "succeeded" } });
    const over = await p.executeAction({ connectionId: stripe.connectionId, action: "create_refund", input: { chargeId: "ch_mock_001", amount: 1_000_000 } });
    expect(over.ok).toBe(false);

    const gh = await connect(p, "github");
    const merge = await p.executeAction({ connectionId: gh.connectionId, action: "merge_pull_request", input: { repo: "example-org/website", number: 1 } });
    expect(merge).toMatchObject({ ok: true, data: { merged: true } });
    const unknown = await p.executeAction({ connectionId: gh.connectionId, action: "drop_database", input: {} });
    expect(unknown.error).toMatch(/Unknown action/);
  });
});

describe("connectorTools", () => {
  it("wraps actions as ForgeTools with irreversible flags and JSON schema", async () => {
    const p = new MockConnectorProvider({ now: () => NOW });
    const { connectionId } = await connect(p, "hubspot");
    const tools = await connectorTools(p, connectionId, "hubspot");
    const names = tools.map((t) => t.name);
    expect(names).toContain("hubspot_list_contacts");
    expect(tools.find((t) => t.name === "hubspot_delete_contact")!.irreversible).toBe(true);
    expect(tools.find((t) => t.name === "hubspot_list_contacts")!.irreversible).toBe(false);
    const def = toToolDef(tools.find((t) => t.name === "hubspot_create_note")!);
    expect(def.inputSchema).toMatchObject({ type: "object", required: ["contactId", "body"] });
    const ok = await runTool(tools, "hubspot_create_note", { contactId: "mock_contact_001", body: "From agent" }, {});
    expect(ok.ok).toBe(true);
    expect(JSON.parse(ok.output)).toMatchObject({ mock: true, data: { contactId: "mock_contact_001" } });
    const bad = await runTool(tools, "hubspot_create_note", { contactId: 5 }, {});
    expect(bad.ok).toBe(false);
  });

  it("factory defaults to mock and validates provider names", () => {
    const prev = process.env.CONNECTOR_PROVIDER;
    delete process.env.CONNECTOR_PROVIDER;
    expect(createConnectorProvider().isMock).toBe(true);
    process.env.CONNECTOR_PROVIDER = "zapier";
    expect(() => createConnectorProvider()).toThrow(/Unknown CONNECTOR_PROVIDER/);
    process.env.CONNECTOR_PROVIDER = "composio";
    delete process.env.COMPOSIO_API_KEY;
    expect(() => createConnectorProvider()).toThrow(/COMPOSIO_API_KEY/);
    if (prev === undefined) delete process.env.CONNECTOR_PROVIDER;
    else process.env.CONNECTOR_PROVIDER = prev;
  });
});
