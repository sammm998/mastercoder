import { ForgeError, newId } from "@forge/shared";
import { CATALOG, catalogActions, catalogAppInfo, getCatalogApp } from "./catalog.js";
import { jsonSchemaToZod } from "./json-schema.js";
import type {
  ActionDef,
  ActionResult,
  AppInfo,
  ConnectionInfo,
  ConnectorProvider,
  ExecuteActionInput,
  InitiateConnectionInput,
  InitiatedConnection,
} from "./types.js";

export interface MockConnectorOptions {
  /**
   * Simulate the user completing the OAuth consent screen the first time the connection is polled.
   * Set false to drive consent explicitly with `completeAuthorization()` / `failAuthorization()`.
   */
  autoApprove?: boolean;
  /** Clock used for seeded timestamps (deterministic tests). */
  now?: () => Date;
}

interface MockConnection {
  id: string;
  workspaceId: string;
  userId: string;
  app: string;
  scopes: string[];
  status: ConnectionInfo["status"];
  externalId: string | null;
  state: string;
}

type Row = Record<string, unknown> & { id: string };
type AppStore = Map<string, Row[]>;
type Handler = (input: Record<string, unknown>, store: AppStore, ctx: { now: Date; conn: MockConnection }) => unknown;

const DAY = 86_400_000;
const FIRST = ["Anna", "Erik", "Maja", "Johan", "Sara", "Lars", "Elin", "Oskar", "Ida", "Nils", "Klara", "Viktor"];
const LAST = ["Lindqvist", "Berg", "Holm", "Sjoberg", "Ek", "Nystrom", "Wallin", "Forsberg", "Lund", "Dahl", "Strand", "Bjork"];
const COMPANIES = ["Fjallbacka Design (mock)", "Norrsken Logistik (mock)", "Granit Bygg (mock)", "Alvkraft Energi (mock)"];

function coll(store: AppStore, name: string): Row[] {
  let c = store.get(name);
  if (!c) {
    c = [];
    store.set(name, c);
  }
  return c;
}

function lim(input: Record<string, unknown>, d = 20): number {
  const n = typeof input.limit === "number" ? input.limit : d;
  return Math.max(1, Math.min(100, n));
}

function must(rows: Row[], id: unknown, what: string): Row {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new ForgeError("NOT_FOUND", `${what} "${String(id)}" not found`);
  return r;
}

function remove(rows: Row[], id: unknown, what: string): Row {
  const i = rows.findIndex((x) => x.id === id);
  if (i < 0) throw new ForgeError("NOT_FOUND", `${what} "${String(id)}" not found`);
  return rows.splice(i, 1)[0]!;
}

const counters = new WeakMap<Row[], number>();
/** Deterministic, never-reused id within a collection. */
function seq(rows: Row[], prefix: string): string {
  const n = Math.max(counters.get(rows) ?? 0, rows.length) + 1;
  counters.set(rows, n);
  return `${prefix}_${n.toString().padStart(4, "0")}`;
}

/** Deterministic seed data per app. Every seeded record is clearly labelled as mock data. */
function seed(app: string, now: Date): AppStore {
  const s: AppStore = new Map();
  const t = now.getTime();
  if (app === "hubspot") {
    const contacts = coll(s, "contacts");
    for (let i = 0; i < 12; i++) {
      const first = FIRST[i]!;
      const last = LAST[(i * 5) % LAST.length]!;
      contacts.push({
        id: `mock_contact_${(i + 1).toString().padStart(3, "0")}`,
        firstName: first,
        lastName: last,
        email: `${first}.${last}@example.com`.toLowerCase(),
        company: COMPANIES[i % COMPANIES.length]!,
        lifecycleStage: i % 3 === 0 ? "customer" : i % 3 === 1 ? "lead" : "opportunity",
        createdAt: new Date(t - Math.round(i * 1.5 * DAY)).toISOString(),
      });
    }
    coll(s, "deals").push(
      { id: "mock_deal_001", name: "Annual licence (mock)", amount: 120000, stage: "proposal", contactId: "mock_contact_001" },
      { id: "mock_deal_002", name: "Pilot project (mock)", amount: 25000, stage: "qualified", contactId: "mock_contact_004" },
    );
  } else if (app === "slack" || app === "teams") {
    for (const name of ["general", "help", "sales", "random"]) coll(s, "channels").push({ id: `C_MOCK_${name.toUpperCase()}`, name, teamId: "T_MOCK_1" });
    if (app === "teams") coll(s, "teams").push({ id: "T_MOCK_1", name: "Forge mock team" });
    if (app === "slack") coll(s, "users").push({ id: "U_MOCK_1", name: "mock.user" }, { id: "U_MOCK_2", name: "mock.admin" });
  } else if (app === "gmail" || app === "outlook") {
    const inbox = coll(s, "inbox");
    for (let i = 0; i < 3; i++) {
      inbox.push({ id: `mock_msg_${i + 1}`, from: `${FIRST[i]!.toLowerCase()}@example.com`, subject: `Mock message ${i + 1}`, body: `This is seeded mock message ${i + 1}.`, receivedAt: new Date(t - i * DAY).toISOString() });
    }
  } else if (app === "github") {
    coll(s, "repos").push({ id: "example-org/website", fullName: "example-org/website", private: false }, { id: "example-org/api", fullName: "example-org/api", private: true });
    coll(s, "issues").push({ id: "example-org/website#1", repo: "example-org/website", number: 1, title: "Mock pull request", state: "open", isPullRequest: true, merged: false, comments: [] });
  } else if (app === "stripe") {
    coll(s, "customers").push({ id: "cus_mock_001", email: "anna.lindqvist@example.com", name: "Anna Lindqvist (mock)" });
    const charges = coll(s, "charges");
    for (let i = 0; i < 3; i++) charges.push({ id: `ch_mock_00${i + 1}`, customerId: "cus_mock_001", amount: (i + 1) * 9900, currency: "sek", refunded: 0, created: new Date(t - i * DAY).toISOString() });
  } else if (app === "salesforce") {
    for (let i = 0; i < 3; i++) coll(s, "Lead").push({ id: `00Q_MOCK_${i + 1}`, FirstName: FIRST[i + 3]!, LastName: LAST[i + 3]!, Company: COMPANIES[i]!, Status: "Open - Not Contacted" });
  }
  return s;
}

function parseA1(range: string): { sheet: string; r0: number; c0: number; r1: number; c1: number } {
  const [sheetPart, cells] = range.includes("!") ? (range.split("!") as [string, string]) : ["Sheet1", range];
  const col = (letters: string) => letters.toUpperCase().split("").reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const m = /^([A-Za-z]+)(\d+)?(?::([A-Za-z]+)(\d+)?)?$/.exec(cells.trim());
  if (!m) throw new ForgeError("BAD_INPUT", `Invalid A1 range "${range}"`);
  const c0 = col(m[1]!);
  const r0 = m[2] ? Number(m[2]) - 1 : 0;
  const c1 = m[3] ? col(m[3]) : c0;
  const r1 = m[4] ? Number(m[4]) - 1 : m[3] ? Number.MAX_SAFE_INTEGER : r0;
  return { sheet: sheetPart.replace(/^'|'$/g, ""), r0, c0, r1, c1 };
}

function sheetRows(store: AppStore, spreadsheetId: unknown, sheet: string): unknown[][] {
  const ss = must(coll(store, "spreadsheets"), spreadsheetId, "Spreadsheet");
  const sheets = ss.sheets as Record<string, unknown[][]>;
  sheets[sheet] ??= [];
  return sheets[sheet];
}

const send = (box: string, idPrefix: string): Handler => (i, s, { now }) => {
  const sent = coll(s, box);
  const row = { id: seq(sent, idPrefix), to: i.to, cc: i.cc, subject: i.subject, body: i.body, html: i.html, sentAt: now.toISOString() };
  sent.push(row);
  return { id: row.id, status: "sent", recipients: i.to };
};

const HANDLERS: Record<string, Handler> = {
  // HubSpot
  "hubspot.list_contacts": (i, s) => {
    const q = typeof i.query === "string" ? i.query.toLowerCase() : "";
    const rows = coll(s, "contacts").filter((c) => !q || JSON.stringify(c).toLowerCase().includes(q));
    return { contacts: [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, lim(i)) };
  },
  "hubspot.get_contact": (i, s) => must(coll(s, "contacts"), i.contactId, "Contact"),
  "hubspot.create_contact": (i, s, { now }) => {
    const c = coll(s, "contacts");
    if (c.some((x) => x.email === i.email)) throw new ForgeError("BAD_INPUT", `Contact with email ${String(i.email)} already exists`);
    const row = { id: seq(c, "mock_contact"), lifecycleStage: "lead", ...i, createdAt: now.toISOString() };
    c.push(row);
    return row;
  },
  "hubspot.update_contact": (i, s) => Object.assign(must(coll(s, "contacts"), i.contactId, "Contact"), i.properties as object),
  "hubspot.delete_contact": (i, s) => ({ archived: remove(coll(s, "contacts"), i.contactId, "Contact").id }),
  "hubspot.list_leads": (i, s, { now }) => {
    const since = now.getTime() - (typeof i.sinceDays === "number" ? i.sinceDays : 7) * DAY;
    const leads = coll(s, "contacts").filter((c) => c.lifecycleStage === "lead" && Date.parse(String(c.createdAt)) >= since);
    return { leads: leads.slice(0, lim(i)), sinceDays: i.sinceDays ?? 7 };
  },
  "hubspot.create_note": (i, s, { now }) => {
    must(coll(s, "contacts"), i.contactId, "Contact");
    const notes = coll(s, "notes");
    const row = { id: seq(notes, "mock_note"), contactId: i.contactId, body: i.body, createdAt: now.toISOString() };
    notes.push(row);
    return row;
  },
  "hubspot.list_notes": (i, s) => ({ notes: coll(s, "notes").filter((n) => n.contactId === i.contactId) }),
  "hubspot.list_deals": (i, s) => ({ deals: coll(s, "deals").filter((d) => !i.stage || d.stage === i.stage).slice(0, lim(i)) }),
  "hubspot.create_deal": (i, s) => {
    const d = coll(s, "deals");
    const row = { id: seq(d, "mock_deal"), stage: "qualified", ...i };
    d.push(row);
    return row;
  },
  // Slack
  "slack.list_channels": (i, s) => ({ channels: coll(s, "channels").slice(0, lim(i)) }),
  "slack.list_messages": (i, s) => ({ messages: coll(s, "messages").filter((m) => m.channel === channelId(s, i.channel)).slice(-lim(i)) }),
  "slack.post_message": (i, s, { now }) => {
    const ch = channelId(s, i.channel);
    const msgs = coll(s, "messages");
    const ts = `${Math.floor(now.getTime() / 1000)}.${(msgs.length + 1).toString().padStart(6, "0")}`;
    msgs.push({ id: ts, ts, channel: ch, text: i.text, threadTs: i.threadTs });
    return { channel: ch, ts };
  },
  "slack.delete_message": (i, s) => ({ deleted: remove(coll(s, "messages"), i.ts, "Message").id }),
  "slack.add_reaction": (i, s) => {
    const m = must(coll(s, "messages"), i.ts, "Message");
    m.reactions = [...((m.reactions as string[]) ?? []), String(i.name)];
    return { ok: true };
  },
  "slack.list_users": (i, s) => ({ users: coll(s, "users").slice(0, lim(i)) }),
  // Gmail
  "gmail.list_messages": (i, s) => {
    const q = typeof i.query === "string" ? i.query.toLowerCase().replace(/\b\w+:\S+/g, "").trim() : "";
    return { messages: coll(s, "inbox").filter((m) => !q || JSON.stringify(m).toLowerCase().includes(q)).slice(0, lim(i)) };
  },
  "gmail.get_message": (i, s) => must([...coll(s, "inbox"), ...coll(s, "sent")], i.messageId, "Message"),
  "gmail.send_email": send("sent", "mock_sent"),
  "gmail.create_draft": (i, s) => {
    const d = coll(s, "drafts");
    const row = { id: seq(d, "mock_draft"), ...i };
    d.push(row);
    return row;
  },
  "gmail.delete_message": (i, s) => {
    const row = remove(coll(s, "inbox"), i.messageId, "Message");
    coll(s, "trash").push(row);
    return { trashed: row.id };
  },
  // Google Sheets
  "google_sheets.create_spreadsheet": (i, s) => {
    const c = coll(s, "spreadsheets");
    const row = { id: seq(c, "mock_sheet"), title: i.title, sheets: { Sheet1: [] as unknown[][] } };
    c.push(row);
    return { spreadsheetId: row.id, title: row.title };
  },
  "google_sheets.append_row": (i, s) => {
    const rows = sheetRows(s, i.spreadsheetId, typeof i.sheet === "string" ? i.sheet : "Sheet1");
    rows.push(i.values as unknown[]);
    return { updatedRange: `${typeof i.sheet === "string" ? i.sheet : "Sheet1"}!A${rows.length}`, rowCount: rows.length };
  },
  "google_sheets.get_values": (i, s) => {
    const r = parseA1(String(i.range));
    const rows = sheetRows(s, i.spreadsheetId, r.sheet);
    return { range: i.range, values: rows.slice(r.r0, Math.min(rows.length, r.r1 + 1)).map((row) => row.slice(r.c0, r.c1 + 1)) };
  },
  "google_sheets.update_values": (i, s) => {
    const r = parseA1(String(i.range));
    const rows = sheetRows(s, i.spreadsheetId, r.sheet);
    (i.values as unknown[][]).forEach((vals, di) => {
      const row = (rows[r.r0 + di] ??= []);
      vals.forEach((v, dj) => (row[r.c0 + dj] = v));
    });
    return { updatedRows: (i.values as unknown[][]).length };
  },
  "google_sheets.clear_range": (i, s) => {
    const r = parseA1(String(i.range));
    const rows = sheetRows(s, i.spreadsheetId, r.sheet);
    for (let ri = r.r0; ri <= Math.min(r.r1, rows.length - 1); ri++) for (let ci = r.c0; ci <= r.c1; ci++) if (rows[ri]) rows[ri]![ci] = "";
    return { cleared: i.range };
  },
  // Google Calendar
  "google_calendar.list_events": (i, s) => {
    const min = typeof i.timeMin === "string" ? Date.parse(i.timeMin) : -Infinity;
    const max = typeof i.timeMax === "string" ? Date.parse(i.timeMax) : Infinity;
    return { events: coll(s, "events").filter((e) => Date.parse(String(e.end)) > min && Date.parse(String(e.start)) < max).slice(0, lim(i)) };
  },
  "google_calendar.create_event": (i, s) => {
    const e = coll(s, "events");
    if (Date.parse(String(i.end)) <= Date.parse(String(i.start))) throw new ForgeError("BAD_INPUT", "end must be after start");
    const row = { id: seq(e, "mock_event"), calendarId: i.calendarId ?? "primary", ...i, invitationsSentTo: i.attendees ?? [] };
    e.push(row);
    return row;
  },
  "google_calendar.delete_event": (i, s) => ({ deleted: remove(coll(s, "events"), i.eventId, "Event").id }),
  "google_calendar.find_free_slots": (i, s) => {
    const dur = Number(i.durationMinutes) * 60_000;
    const end = Date.parse(String(i.timeMax));
    const busy = coll(s, "events").map((e) => [Date.parse(String(e.start)), Date.parse(String(e.end))] as const);
    const slots: Array<{ start: string; end: string }> = [];
    for (let t = Date.parse(String(i.timeMin)); t + dur <= end && slots.length < 20; t += dur) {
      if (!busy.some(([a, b]) => t < b && t + dur > a)) slots.push({ start: new Date(t).toISOString(), end: new Date(t + dur).toISOString() });
    }
    return { slots };
  },
  // Notion
  "notion.search": (i, s) => {
    const q = typeof i.query === "string" ? i.query.toLowerCase() : "";
    return { results: coll(s, "pages").filter((p) => !p.archived && String(p.title).toLowerCase().includes(q)).slice(0, lim(i)) };
  },
  "notion.get_page": (i, s) => must(coll(s, "pages"), i.pageId, "Page"),
  "notion.create_page": (i, s, { now }) => {
    const p = coll(s, "pages");
    const row = { id: seq(p, "mock_page"), parentId: i.parentId ?? null, title: i.title, content: i.content ?? "", archived: false, createdAt: now.toISOString() };
    p.push(row);
    return row;
  },
  "notion.append_block": (i, s) => {
    const p = must(coll(s, "pages"), i.pageId, "Page");
    p.content = `${String(p.content ?? "")}\n${String(i.text)}`.trim();
    return { pageId: p.id, length: String(p.content).length };
  },
  "notion.archive_page": (i, s) => {
    const p = must(coll(s, "pages"), i.pageId, "Page");
    p.archived = true;
    return { archived: p.id };
  },
  // GitHub
  "github.list_repos": (i, s) => ({ repos: coll(s, "repos").slice(0, lim(i)) }),
  "github.list_issues": (i, s) => ({
    issues: coll(s, "issues").filter((x) => x.repo === i.repo && (!i.state || i.state === "all" || x.state === i.state)).slice(0, lim(i)),
  }),
  "github.create_issue": (i, s) => {
    must(coll(s, "repos"), i.repo, "Repository");
    const issues = coll(s, "issues");
    const number = issues.filter((x) => x.repo === i.repo).length + 1;
    const row = { id: `${String(i.repo)}#${number}`, repo: i.repo, number, title: i.title, body: i.body ?? "", labels: i.labels ?? [], state: "open", isPullRequest: false, comments: [] };
    issues.push(row);
    return row;
  },
  "github.post_issue_comment": (i, s) => {
    const issue = must(coll(s, "issues"), `${String(i.repo)}#${String(i.number)}`, "Issue");
    (issue.comments as unknown[]).push({ body: i.body });
    return { issue: issue.id, comments: (issue.comments as unknown[]).length };
  },
  "github.merge_pull_request": (i, s) => {
    const pr = must(coll(s, "issues"), `${String(i.repo)}#${String(i.number)}`, "Pull request");
    if (!pr.isPullRequest) throw new ForgeError("BAD_INPUT", `#${String(i.number)} is not a pull request`);
    if (pr.merged) throw new ForgeError("BAD_INPUT", "Pull request already merged");
    Object.assign(pr, { merged: true, state: "closed", mergeMethod: i.method ?? "merge" });
    return { merged: true, number: pr.number };
  },
  // Stripe
  "stripe.list_customers": (i, s) => ({ customers: coll(s, "customers").filter((c) => !i.email || c.email === i.email).slice(0, lim(i)) }),
  "stripe.list_charges": (i, s) => ({ charges: coll(s, "charges").filter((c) => !i.customerId || c.customerId === i.customerId).slice(0, lim(i)) }),
  "stripe.create_customer": (i, s) => {
    const c = coll(s, "customers");
    const row = { id: seq(c, "cus_mock"), email: i.email, name: i.name ?? null };
    c.push(row);
    return row;
  },
  "stripe.create_invoice": (i, s) => {
    must(coll(s, "customers"), i.customerId, "Customer");
    const inv = coll(s, "invoices");
    const row = { id: seq(inv, "in_mock"), customerId: i.customerId, amount: i.amount, currency: i.currency, description: i.description ?? "", status: "draft" };
    inv.push(row);
    return row;
  },
  "stripe.send_invoice": (i, s) => {
    const inv = must(coll(s, "invoices"), i.invoiceId, "Invoice");
    if (inv.status !== "draft") throw new ForgeError("BAD_INPUT", `Invoice is ${String(inv.status)}`);
    inv.status = "open";
    return { id: inv.id, status: "open", emailed: true };
  },
  "stripe.create_refund": (i, s) => {
    const ch = must(coll(s, "charges"), i.chargeId, "Charge");
    const amount = typeof i.amount === "number" ? i.amount : Number(ch.amount) - Number(ch.refunded);
    if (amount > Number(ch.amount) - Number(ch.refunded)) throw new ForgeError("BAD_INPUT", "Refund exceeds remaining charge amount");
    ch.refunded = Number(ch.refunded) + amount;
    const r = coll(s, "refunds");
    const row = { id: seq(r, "re_mock"), chargeId: ch.id, amount, status: "succeeded" };
    r.push(row);
    return row;
  },
  // Airtable
  "airtable.list_records": (i, s) => ({ records: coll(s, `${String(i.baseId)}/${String(i.table)}`).slice(0, lim(i)) }),
  "airtable.create_record": (i, s) => {
    const t = coll(s, `${String(i.baseId)}/${String(i.table)}`);
    const row = { id: seq(t, "recMock"), fields: i.fields };
    t.push(row);
    return row;
  },
  "airtable.update_record": (i, s) => {
    const r = must(coll(s, `${String(i.baseId)}/${String(i.table)}`), i.recordId, "Record");
    r.fields = { ...(r.fields as object), ...(i.fields as object) };
    return r;
  },
  "airtable.delete_record": (i, s) => ({ deleted: remove(coll(s, `${String(i.baseId)}/${String(i.table)}`), i.recordId, "Record").id }),
  // Salesforce
  "salesforce.list_records": (i, s) => ({ records: coll(s, String(i.object)).slice(0, lim(i)) }),
  "salesforce.create_record": (i, s) => {
    const t = coll(s, String(i.object));
    const row = { id: seq(t, `SF_MOCK_${String(i.object).toUpperCase()}`), ...(i.fields as object) };
    t.push(row);
    return { id: row.id, success: true };
  },
  "salesforce.update_record": (i, s) => Object.assign(must(coll(s, String(i.object)), i.recordId, "Record"), i.fields as object),
  "salesforce.delete_record": (i, s) => ({ deleted: remove(coll(s, String(i.object)), i.recordId, "Record").id }),
  // Outlook
  "outlook.list_messages": (i, s) => ({ messages: coll(s, "inbox").slice(0, lim(i)) }),
  "outlook.send_mail": send("sent", "mock_outlook_sent"),
  "outlook.list_events": (i, s) => ({ events: coll(s, "events").slice(0, lim(i)) }),
  "outlook.create_event": (i, s) => {
    const e = coll(s, "events");
    const row = { id: seq(e, "mock_outlook_event"), ...i };
    e.push(row);
    return row;
  },
  // Teams
  "teams.list_teams": (i, s) => ({ teams: coll(s, "teams").slice(0, lim(i)) }),
  "teams.list_channels": (i, s) => ({ channels: coll(s, "channels").filter((c) => c.teamId === i.teamId) }),
  "teams.list_messages": (i, s) => ({ messages: coll(s, "messages").filter((m) => m.channelId === i.channelId).slice(-lim(i)) }),
  "teams.post_message": (i, s, { now }) => {
    must(coll(s, "channels"), i.channelId, "Channel");
    const m = coll(s, "messages");
    const row = { id: seq(m, "mock_teams_msg"), teamId: i.teamId, channelId: i.channelId, text: i.text, createdAt: now.toISOString() };
    m.push(row);
    return row;
  },
};

function channelId(store: AppStore, ref: unknown): string {
  const r = String(ref);
  const ch = coll(store, "channels").find((c) => c.id === r || `#${String(c.name)}` === r || c.name === r);
  if (!ch) throw new ForgeError("NOT_FOUND", `Channel "${r}" not found`);
  return ch.id;
}

// Every catalog action must have a mock implementation (checked at module load so drift is caught in tests).
for (const app of CATALOG) for (const a of app.actions) if (!HANDLERS[`${app.slug}.${a.name}`]) throw new Error(`MockConnectorProvider: missing handler ${app.slug}.${a.name}`);

/**
 * In-memory connector broker. Simulates the OAuth consent flow and executes catalog actions against a
 * deterministic per-(workspace, app) store. Every ActionResult carries `mock: true`; it never contacts a vendor.
 */
export class MockConnectorProvider implements ConnectorProvider {
  readonly name = "mock";
  readonly isMock = true;
  private readonly connections = new Map<string, MockConnection>();
  private readonly stores = new Map<string, AppStore>();
  private readonly autoApprove: boolean;
  private readonly now: () => Date;

  constructor(opts: MockConnectorOptions = {}) {
    this.autoApprove = opts.autoApprove ?? true;
    this.now = opts.now ?? (() => new Date());
  }

  async listApps(): Promise<AppInfo[]> {
    return CATALOG.map((a) => catalogAppInfo(a));
  }

  async getApp(app: string): Promise<AppInfo> {
    return catalogAppInfo(getCatalogApp(app));
  }

  async initiateConnection(input: InitiateConnectionInput): Promise<InitiatedConnection> {
    const app = getCatalogApp(input.app);
    const unknown = input.scopes.filter((s) => !app.scopes.some((x) => x.id === s));
    if (unknown.length) throw new ForgeError("BAD_INPUT", `Unknown scopes for ${app.slug}: ${unknown.join(", ")}`);
    const id = newId("mockconn");
    const state = newId("st", 16);
    this.connections.set(id, {
      id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      app: app.slug,
      scopes: input.scopes.length ? input.scopes : app.defaultScopes,
      status: "pending",
      externalId: null,
      state,
    });
    const url = new URL(input.redirectUrl);
    url.searchParams.set("mock_oauth", "1");
    url.searchParams.set("connection_id", id);
    url.searchParams.set("state", state);
    return { connectionId: id, redirectUrl: url.toString() };
  }

  /** Simulate the user approving the consent screen (when autoApprove is false). */
  completeAuthorization(connectionId: string): void {
    const c = this.conn(connectionId);
    if (c.status !== "pending") throw new ForgeError("BAD_INPUT", `Connection is ${c.status}`);
    c.status = "active";
    c.externalId = `mock_ext_${c.id.slice(-8)}`;
  }

  /** Simulate the user denying consent. */
  failAuthorization(connectionId: string): void {
    this.conn(connectionId).status = "failed";
  }

  async getConnection(connectionId: string): Promise<ConnectionInfo> {
    const c = this.conn(connectionId);
    if (c.status === "pending" && this.autoApprove) this.completeAuthorization(connectionId);
    return { status: c.status, scopes: [...c.scopes], externalId: c.externalId, app: c.app };
  }

  async listActions(app: string): Promise<ActionDef[]> {
    return catalogActions(app);
  }

  async executeAction(input: ExecuteActionInput): Promise<ActionResult> {
    const c = this.conn(input.connectionId);
    if (c.status === "pending" && this.autoApprove) this.completeAuthorization(c.id);
    if (c.status !== "active") return { ok: false, data: null, error: `Connection is ${c.status}`, mock: true };
    const app = getCatalogApp(c.app);
    const def = app.actions.find((a) => a.name === input.action);
    if (!def) return { ok: false, data: null, error: `Unknown action ${c.app}.${input.action}`, mock: true };
    const missing = def.requires.filter((s) => !c.scopes.includes(s));
    if (missing.length) return { ok: false, data: null, error: `Missing scope(s): ${missing.join(", ")}`, mock: true };
    const parsed = jsonSchemaToZod(def.inputSchema).safeParse(input.input);
    if (!parsed.success) return { ok: false, data: null, error: `Invalid input: ${parsed.error.message}`, mock: true };
    const key = `${c.workspaceId}:${c.app}`;
    let store = this.stores.get(key);
    if (!store) {
      store = seed(c.app, this.now());
      this.stores.set(key, store);
    }
    try {
      const data = HANDLERS[`${c.app}.${def.name}`]!(parsed.data as Record<string, unknown>, store, { now: this.now(), conn: c });
      return { ok: true, data, mock: true };
    } catch (e) {
      return { ok: false, data: null, error: (e as Error).message, mock: true };
    }
  }

  async revoke(connectionId: string): Promise<void> {
    this.conn(connectionId).status = "revoked";
  }

  /** Read-only view of a mock store collection (tests / UI previews of what an agent did). */
  inspect(workspaceId: string, app: string, collection: string): ReadonlyArray<Record<string, unknown>> {
    return this.stores.get(`${workspaceId}:${app}`)?.get(collection) ?? [];
  }

  private conn(id: string): MockConnection {
    const c = this.connections.get(id);
    if (!c) throw new ForgeError("NOT_FOUND", `Connection ${id} not found`);
    return c;
  }
}
