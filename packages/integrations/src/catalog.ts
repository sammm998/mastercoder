import { ForgeError } from "@forge/shared";
import type { JsonSchema } from "@forge/llm";
import type { ActionDef, AppInfo, AuthType, Locale, ScopeInfo } from "./types.js";

export interface CatalogScope {
  id: string;
  en: string;
  sv: string;
}

export interface CatalogAction extends ActionDef {
  /** Scopes this action needs (subset of the app's scopes). */
  requires: string[];
}

export interface CatalogApp {
  slug: string;
  displayName: string;
  authType: AuthType;
  category: "crm" | "chat" | "email" | "productivity" | "dev" | "payments" | "database" | "calendar";
  scopes: CatalogScope[];
  /** Scopes requested when the caller does not narrow them. */
  defaultScopes: string[];
  actions: CatalogAction[];
  /** Vendor-specific identifiers (toolkit / provider-config / app slug). Defaults to `slug`. */
  vendor: { composio: string; nango: string; pipedream: string };
}

// --- tiny JSON-schema builders ---------------------------------------------------------------
const str = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "string", description, ...extra });
const int = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "integer", description, ...extra });
const num = (description: string): JsonSchema => ({ type: "number", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const strArr = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
const obj = (description: string): JsonSchema => ({ type: "object", description, additionalProperties: true });
const limit = int("Maximum number of items to return", { minimum: 1, maximum: 100, default: 20 });

function action(
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[],
  opts: { irreversible?: boolean; requires: string[] },
): CatalogAction {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    irreversible: opts.irreversible ?? false,
    requires: opts.requires,
  };
}

const G = "https://www.googleapis.com/auth/";

export const CATALOG: CatalogApp[] = [
  {
    slug: "hubspot",
    displayName: "HubSpot",
    authType: "oauth2",
    category: "crm",
    scopes: [
      { id: "crm.objects.contacts.read", en: "Read your HubSpot contacts and leads", sv: "Läsa dina kontakter och leads i HubSpot" },
      { id: "crm.objects.contacts.write", en: "Create and update contacts and notes", sv: "Skapa och uppdatera kontakter och anteckningar" },
      { id: "crm.objects.companies.read", en: "Read companies", sv: "Läsa företag" },
      { id: "crm.objects.deals.read", en: "Read deals", sv: "Läsa affärer" },
      { id: "crm.objects.deals.write", en: "Create and update deals", sv: "Skapa och uppdatera affärer" },
    ],
    defaultScopes: ["crm.objects.contacts.read", "crm.objects.contacts.write"],
    actions: [
      action("list_contacts", "List contacts, newest first", { limit, query: str("Free-text filter on name, email or company") }, [], { requires: ["crm.objects.contacts.read"] }),
      action("get_contact", "Get one contact by id", { contactId: str("Contact id") }, ["contactId"], { requires: ["crm.objects.contacts.read"] }),
      action("create_contact", "Create a contact", { email: str("Email", { format: "email" }), firstName: str("First name"), lastName: str("Last name"), company: str("Company name"), lifecycleStage: str("Lifecycle stage", { enum: ["subscriber", "lead", "opportunity", "customer"] }) }, ["email"], { requires: ["crm.objects.contacts.write"] }),
      action("update_contact", "Update contact properties", { contactId: str("Contact id"), properties: obj("Properties to set") }, ["contactId", "properties"], { requires: ["crm.objects.contacts.write"] }),
      action("delete_contact", "Archive (delete) a contact", { contactId: str("Contact id") }, ["contactId"], { irreversible: true, requires: ["crm.objects.contacts.write"] }),
      action("list_leads", "List contacts in lifecycle stage 'lead' created within the last N days", { sinceDays: int("Look-back window in days", { minimum: 1, maximum: 365, default: 7 }), limit }, [], { requires: ["crm.objects.contacts.read"] }),
      action("create_note", "Attach a note to a contact", { contactId: str("Contact id"), body: str("Note text", { minLength: 1, maxLength: 65536 }) }, ["contactId", "body"], { requires: ["crm.objects.contacts.write"] }),
      action("list_notes", "List notes on a contact", { contactId: str("Contact id") }, ["contactId"], { requires: ["crm.objects.contacts.read"] }),
      action("list_deals", "List deals", { limit, stage: str("Pipeline stage filter") }, [], { requires: ["crm.objects.deals.read"] }),
      action("create_deal", "Create a deal", { name: str("Deal name"), amount: num("Amount"), stage: str("Pipeline stage"), contactId: str("Associated contact id") }, ["name"], { requires: ["crm.objects.deals.write"] }),
    ],
    vendor: { composio: "hubspot", nango: "hubspot", pipedream: "hubspot" },
  },
  {
    slug: "slack",
    displayName: "Slack",
    authType: "oauth2",
    category: "chat",
    scopes: [
      { id: "channels:read", en: "See the list of public channels", sv: "Se listan över publika kanaler" },
      { id: "channels:history", en: "Read messages in public channels", sv: "Läsa meddelanden i publika kanaler" },
      { id: "chat:write", en: "Post messages as the Forge app", sv: "Skicka meddelanden som Forge-appen" },
      { id: "users:read", en: "See people in the workspace", sv: "Se personer i arbetsytan" },
      { id: "reactions:write", en: "Add emoji reactions", sv: "Lägga till emoji-reaktioner" },
    ],
    defaultScopes: ["channels:read", "chat:write"],
    actions: [
      action("list_channels", "List public channels", { limit, excludeArchived: bool("Skip archived channels (default true)") }, [], { requires: ["channels:read"] }),
      action("list_messages", "Read recent messages in a channel", { channel: str("Channel id or #name"), limit }, ["channel"], { requires: ["channels:history"] }),
      action("post_message", "Post a message to a channel", { channel: str("Channel id or #name"), text: str("Message text (mrkdwn)", { minLength: 1, maxLength: 40000 }), threadTs: str("Reply in this thread") }, ["channel", "text"], { irreversible: true, requires: ["chat:write"] }),
      action("delete_message", "Delete a message the app posted", { channel: str("Channel id or #name"), ts: str("Message timestamp") }, ["channel", "ts"], { irreversible: true, requires: ["chat:write"] }),
      action("add_reaction", "React to a message with an emoji", { channel: str("Channel id or #name"), ts: str("Message timestamp"), name: str("Emoji name without colons") }, ["channel", "ts", "name"], { requires: ["reactions:write"] }),
      action("list_users", "List workspace members", { limit }, [], { requires: ["users:read"] }),
    ],
    vendor: { composio: "slack", nango: "slack", pipedream: "slack" },
  },
  {
    slug: "gmail",
    displayName: "Gmail",
    authType: "oauth2",
    category: "email",
    scopes: [
      { id: `${G}gmail.readonly`, en: "Read your email messages and settings", sv: "Läsa dina e-postmeddelanden och inställningar" },
      { id: `${G}gmail.send`, en: "Send email on your behalf", sv: "Skicka e-post å dina vägnar" },
      { id: `${G}gmail.compose`, en: "Create drafts", sv: "Skapa utkast" },
      { id: `${G}gmail.modify`, en: "Change labels and delete messages", sv: "Ändra etiketter och radera meddelanden" },
    ],
    defaultScopes: [`${G}gmail.readonly`, `${G}gmail.send`],
    actions: [
      action("list_messages", "Search messages (Gmail search syntax)", { query: str("Gmail search query, e.g. 'from:anna newer_than:7d'"), limit }, [], { requires: [`${G}gmail.readonly`] }),
      action("get_message", "Get a message by id", { messageId: str("Message id") }, ["messageId"], { requires: [`${G}gmail.readonly`] }),
      action("send_email", "Send an email", { to: strArr("Recipient addresses"), subject: str("Subject"), body: str("Plain-text body"), html: str("Optional HTML body"), cc: strArr("CC addresses") }, ["to", "subject", "body"], { irreversible: true, requires: [`${G}gmail.send`] }),
      action("create_draft", "Create a draft without sending", { to: strArr("Recipient addresses"), subject: str("Subject"), body: str("Plain-text body") }, ["to", "subject", "body"], { requires: [`${G}gmail.compose`] }),
      action("delete_message", "Move a message to trash", { messageId: str("Message id") }, ["messageId"], { irreversible: true, requires: [`${G}gmail.modify`] }),
    ],
    vendor: { composio: "gmail", nango: "google-mail", pipedream: "gmail" },
  },
  {
    slug: "google_sheets",
    displayName: "Google Sheets",
    authType: "oauth2",
    category: "productivity",
    scopes: [
      { id: `${G}spreadsheets.readonly`, en: "Read your spreadsheets", sv: "Läsa dina kalkylark" },
      { id: `${G}spreadsheets`, en: "Create and edit spreadsheets", sv: "Skapa och redigera kalkylark" },
    ],
    defaultScopes: [`${G}spreadsheets`],
    actions: [
      action("get_values", "Read a range (A1 notation)", { spreadsheetId: str("Spreadsheet id"), range: str("A1 range, e.g. Sheet1!A1:D20") }, ["spreadsheetId", "range"], { requires: [`${G}spreadsheets.readonly`] }),
      action("append_row", "Append a row to a sheet", { spreadsheetId: str("Spreadsheet id"), sheet: str("Sheet name"), values: { type: "array", items: {}, description: "Cell values" } }, ["spreadsheetId", "values"], { requires: [`${G}spreadsheets`] }),
      action("update_values", "Overwrite a range", { spreadsheetId: str("Spreadsheet id"), range: str("A1 range"), values: { type: "array", items: { type: "array", items: {} }, description: "Rows of cell values" } }, ["spreadsheetId", "range", "values"], { requires: [`${G}spreadsheets`] }),
      action("create_spreadsheet", "Create a new spreadsheet", { title: str("Title") }, ["title"], { requires: [`${G}spreadsheets`] }),
      action("clear_range", "Clear all values in a range", { spreadsheetId: str("Spreadsheet id"), range: str("A1 range") }, ["spreadsheetId", "range"], { irreversible: true, requires: [`${G}spreadsheets`] }),
    ],
    vendor: { composio: "googlesheets", nango: "google-sheet", pipedream: "google_sheets" },
  },
  {
    slug: "google_calendar",
    displayName: "Google Calendar",
    authType: "oauth2",
    category: "calendar",
    scopes: [
      { id: `${G}calendar.readonly`, en: "See your calendars and events", sv: "Se dina kalendrar och händelser" },
      { id: `${G}calendar.events`, en: "Create, change and delete events", sv: "Skapa, ändra och ta bort händelser" },
    ],
    defaultScopes: [`${G}calendar.readonly`, `${G}calendar.events`],
    actions: [
      action("list_events", "List events in a time window", { calendarId: str("Calendar id, default 'primary'"), timeMin: str("ISO start", { format: "date-time" }), timeMax: str("ISO end", { format: "date-time" }), limit }, [], { requires: [`${G}calendar.readonly`] }),
      action("create_event", "Create an event (attendees are emailed an invitation)", { calendarId: str("Calendar id"), summary: str("Title"), start: str("ISO start", { format: "date-time" }), end: str("ISO end", { format: "date-time" }), attendees: strArr("Attendee emails"), description: str("Description") }, ["summary", "start", "end"], { irreversible: true, requires: [`${G}calendar.events`] }),
      action("delete_event", "Delete an event", { calendarId: str("Calendar id"), eventId: str("Event id") }, ["eventId"], { irreversible: true, requires: [`${G}calendar.events`] }),
      action("find_free_slots", "Find free slots of a given length", { durationMinutes: int("Slot length", { minimum: 5, maximum: 480 }), timeMin: str("ISO start", { format: "date-time" }), timeMax: str("ISO end", { format: "date-time" }) }, ["durationMinutes", "timeMin", "timeMax"], { requires: [`${G}calendar.readonly`] }),
    ],
    vendor: { composio: "googlecalendar", nango: "google-calendar", pipedream: "google_calendar" },
  },
  {
    slug: "notion",
    displayName: "Notion",
    authType: "oauth2",
    category: "productivity",
    scopes: [
      { id: "read_content", en: "Read pages and databases you share with Forge", sv: "Läsa sidor och databaser du delar med Forge" },
      { id: "update_content", en: "Edit pages you share with Forge", sv: "Redigera sidor du delar med Forge" },
      { id: "insert_content", en: "Create new pages", sv: "Skapa nya sidor" },
    ],
    defaultScopes: ["read_content", "insert_content"],
    actions: [
      action("search", "Search pages and databases", { query: str("Search text"), limit }, [], { requires: ["read_content"] }),
      action("get_page", "Get a page and its text content", { pageId: str("Page id") }, ["pageId"], { requires: ["read_content"] }),
      action("create_page", "Create a page under a parent page or database", { parentId: str("Parent page/database id"), title: str("Title"), content: str("Markdown content") }, ["title"], { requires: ["insert_content"] }),
      action("append_block", "Append text to a page", { pageId: str("Page id"), text: str("Text to append") }, ["pageId", "text"], { requires: ["update_content"] }),
      action("archive_page", "Archive (delete) a page", { pageId: str("Page id") }, ["pageId"], { irreversible: true, requires: ["update_content"] }),
    ],
    vendor: { composio: "notion", nango: "notion", pipedream: "notion" },
  },
  {
    slug: "github",
    displayName: "GitHub",
    authType: "oauth2",
    category: "dev",
    scopes: [
      { id: "read:user", en: "Read your profile", sv: "Läsa din profil" },
      { id: "repo", en: "Full access to your repositories (code, issues, pull requests)", sv: "Full åtkomst till dina repon (kod, ärenden, pull requests)" },
      { id: "read:org", en: "Read organisation membership", sv: "Läsa organisationsmedlemskap" },
    ],
    defaultScopes: ["read:user", "repo"],
    actions: [
      action("list_repos", "List repositories you can access", { limit }, [], { requires: ["repo"] }),
      action("list_issues", "List issues in a repository", { repo: str("owner/name"), state: str("Issue state", { enum: ["open", "closed", "all"] }), limit }, ["repo"], { requires: ["repo"] }),
      action("create_issue", "Open an issue", { repo: str("owner/name"), title: str("Title"), body: str("Markdown body"), labels: strArr("Labels") }, ["repo", "title"], { requires: ["repo"] }),
      action("post_issue_comment", "Post a comment on an issue or pull request", { repo: str("owner/name"), number: int("Issue/PR number"), body: str("Markdown body") }, ["repo", "number", "body"], { irreversible: true, requires: ["repo"] }),
      action("merge_pull_request", "Merge a pull request", { repo: str("owner/name"), number: int("PR number"), method: str("Merge method", { enum: ["merge", "squash", "rebase"] }) }, ["repo", "number"], { irreversible: true, requires: ["repo"] }),
    ],
    vendor: { composio: "github", nango: "github", pipedream: "github" },
  },
  {
    slug: "stripe",
    displayName: "Stripe",
    authType: "oauth2",
    category: "payments",
    scopes: [
      { id: "read_only", en: "Read customers, payments and invoices", sv: "Läsa kunder, betalningar och fakturor" },
      { id: "read_write", en: "Create customers and invoices, send invoices and refund payments", sv: "Skapa kunder och fakturor, skicka fakturor och återbetala betalningar" },
    ],
    defaultScopes: ["read_only"],
    actions: [
      action("list_customers", "List customers", { limit, email: str("Filter by email") }, [], { requires: ["read_only"] }),
      action("list_charges", "List recent charges", { limit, customerId: str("Filter by customer") }, [], { requires: ["read_only"] }),
      action("create_customer", "Create a customer", { email: str("Email", { format: "email" }), name: str("Name") }, ["email"], { requires: ["read_write"] }),
      action("create_invoice", "Create a draft invoice", { customerId: str("Customer id"), amount: int("Amount in minor units", { minimum: 1 }), currency: str("ISO currency, e.g. sek"), description: str("Line description") }, ["customerId", "amount", "currency"], { requires: ["read_write"] }),
      action("send_invoice", "Finalize and email an invoice to the customer", { invoiceId: str("Invoice id") }, ["invoiceId"], { irreversible: true, requires: ["read_write"] }),
      action("create_refund", "Refund a charge (pay money back)", { chargeId: str("Charge id"), amount: int("Amount in minor units; omit for full refund", { minimum: 1 }) }, ["chargeId"], { irreversible: true, requires: ["read_write"] }),
    ],
    vendor: { composio: "stripe", nango: "stripe", pipedream: "stripe" },
  },
  {
    slug: "airtable",
    displayName: "Airtable",
    authType: "oauth2",
    category: "database",
    scopes: [
      { id: "data.records:read", en: "Read records in your bases", sv: "Läsa poster i dina baser" },
      { id: "data.records:write", en: "Create, edit and delete records", sv: "Skapa, redigera och ta bort poster" },
      { id: "schema.bases:read", en: "See base and table structure", sv: "Se strukturen för baser och tabeller" },
    ],
    defaultScopes: ["data.records:read", "data.records:write", "schema.bases:read"],
    actions: [
      action("list_records", "List records in a table", { baseId: str("Base id"), table: str("Table name or id"), limit }, ["baseId", "table"], { requires: ["data.records:read"] }),
      action("create_record", "Create a record", { baseId: str("Base id"), table: str("Table name or id"), fields: obj("Field values") }, ["baseId", "table", "fields"], { requires: ["data.records:write"] }),
      action("update_record", "Update a record", { baseId: str("Base id"), table: str("Table name or id"), recordId: str("Record id"), fields: obj("Field values") }, ["baseId", "table", "recordId", "fields"], { requires: ["data.records:write"] }),
      action("delete_record", "Delete a record", { baseId: str("Base id"), table: str("Table name or id"), recordId: str("Record id") }, ["baseId", "table", "recordId"], { irreversible: true, requires: ["data.records:write"] }),
    ],
    vendor: { composio: "airtable", nango: "airtable", pipedream: "airtable_oauth" },
  },
  {
    slug: "salesforce",
    displayName: "Salesforce",
    authType: "oauth2",
    category: "crm",
    scopes: [
      { id: "api", en: "Access and manage your Salesforce data", sv: "Komma åt och hantera dina Salesforce-data" },
      { id: "refresh_token", en: "Stay connected when you are offline", sv: "Förbli ansluten när du är offline" },
    ],
    defaultScopes: ["api", "refresh_token"],
    actions: [
      action("list_records", "List records of an object type (Lead, Contact, Account, Opportunity)", { object: str("sObject type", { enum: ["Lead", "Contact", "Account", "Opportunity"] }), limit }, ["object"], { requires: ["api"] }),
      action("create_record", "Create a record", { object: str("sObject type", { enum: ["Lead", "Contact", "Account", "Opportunity"] }), fields: obj("Field values") }, ["object", "fields"], { requires: ["api"] }),
      action("update_record", "Update a record", { object: str("sObject type"), recordId: str("Record id"), fields: obj("Field values") }, ["object", "recordId", "fields"], { requires: ["api"] }),
      action("delete_record", "Delete a record", { object: str("sObject type"), recordId: str("Record id") }, ["object", "recordId"], { irreversible: true, requires: ["api"] }),
    ],
    vendor: { composio: "salesforce", nango: "salesforce", pipedream: "salesforce_rest_api" },
  },
  {
    slug: "outlook",
    displayName: "Microsoft Outlook",
    authType: "oauth2",
    category: "email",
    scopes: [
      { id: "User.Read", en: "Sign you in and read your profile", sv: "Logga in dig och läsa din profil" },
      { id: "Mail.Read", en: "Read your email", sv: "Läsa din e-post" },
      { id: "Mail.Send", en: "Send email as you", sv: "Skicka e-post som dig" },
      { id: "Calendars.ReadWrite", en: "Read and change your calendar", sv: "Läsa och ändra din kalender" },
      { id: "offline_access", en: "Keep access when you are not signed in", sv: "Behålla åtkomst när du inte är inloggad" },
    ],
    defaultScopes: ["User.Read", "Mail.Read", "Mail.Send", "offline_access"],
    actions: [
      action("list_messages", "List recent messages in the inbox", { limit, query: str("Search text") }, [], { requires: ["Mail.Read"] }),
      action("send_mail", "Send an email", { to: strArr("Recipient addresses"), subject: str("Subject"), body: str("Body (text)") }, ["to", "subject", "body"], { irreversible: true, requires: ["Mail.Send"] }),
      action("list_events", "List calendar events", { limit }, [], { requires: ["Calendars.ReadWrite"] }),
      action("create_event", "Create a calendar event (sends invitations)", { subject: str("Title"), start: str("ISO start", { format: "date-time" }), end: str("ISO end", { format: "date-time" }), attendees: strArr("Attendee emails") }, ["subject", "start", "end"], { irreversible: true, requires: ["Calendars.ReadWrite"] }),
    ],
    vendor: { composio: "outlook", nango: "outlook", pipedream: "microsoft_outlook" },
  },
  {
    slug: "teams",
    displayName: "Microsoft Teams",
    authType: "oauth2",
    category: "chat",
    scopes: [
      { id: "Team.ReadBasic.All", en: "See the teams you belong to", sv: "Se teamen du tillhör" },
      { id: "Channel.ReadBasic.All", en: "See channel names", sv: "Se kanalnamn" },
      { id: "ChannelMessage.Read.All", en: "Read channel messages", sv: "Läsa kanalmeddelanden" },
      { id: "ChannelMessage.Send", en: "Post messages to channels as you", sv: "Skicka meddelanden i kanaler som dig" },
    ],
    defaultScopes: ["Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Send"],
    actions: [
      action("list_teams", "List teams", { limit }, [], { requires: ["Team.ReadBasic.All"] }),
      action("list_channels", "List channels in a team", { teamId: str("Team id") }, ["teamId"], { requires: ["Channel.ReadBasic.All"] }),
      action("list_messages", "Read recent channel messages", { teamId: str("Team id"), channelId: str("Channel id"), limit }, ["teamId", "channelId"], { requires: ["ChannelMessage.Read.All"] }),
      action("post_message", "Post a message to a channel", { teamId: str("Team id"), channelId: str("Channel id"), text: str("Message (HTML allowed)") }, ["teamId", "channelId", "text"], { irreversible: true, requires: ["ChannelMessage.Send"] }),
    ],
    vendor: { composio: "microsoft_teams", nango: "microsoft-teams", pipedream: "microsoft_teams" },
  },
];

const BY_SLUG = new Map(CATALOG.map((a) => [a.slug, a]));
const ALIASES: Record<string, string> = {
  googlesheets: "google_sheets",
  "google-sheets": "google_sheets",
  sheets: "google_sheets",
  googlecalendar: "google_calendar",
  "google-calendar": "google_calendar",
  calendar: "google_calendar",
  microsoft_outlook: "outlook",
  "microsoft-outlook": "outlook",
  microsoft_teams: "teams",
  "microsoft-teams": "teams",
};

export function normalizeAppSlug(app: string): string {
  const k = app.trim().toLowerCase().replace(/\s+/g, "_");
  return ALIASES[k] ?? k;
}

export function findCatalogApp(app: string): CatalogApp | undefined {
  return BY_SLUG.get(normalizeAppSlug(app));
}

export function getCatalogApp(app: string): CatalogApp {
  const a = findCatalogApp(app);
  if (!a) throw new ForgeError("NOT_FOUND", `Unknown app "${app}". Known: ${CATALOG.map((c) => c.slug).join(", ")}`);
  return a;
}

export function catalogAppInfo(a: CatalogApp, locale: Locale = "en"): AppInfo {
  return { name: a.slug, displayName: a.displayName, authType: a.authType, scopes: a.scopes.map((s) => ({ id: s.id, description: s[locale] })) };
}

/** Catalog actions as plain ActionDefs (without the `requires` helper field). */
export function catalogActions(app: string): ActionDef[] {
  return getCatalogApp(app).actions.map(({ requires: _r, ...a }) => a);
}

/**
 * Human-readable descriptions of the scopes the user is about to grant, shown on the consent screen
 * before connecting. Unknown scope ids are still listed (never hidden) with a generic description.
 */
export function describeScopes(app: string, scopes: string[], locale: Locale = "en"): ScopeInfo[] {
  const a = getCatalogApp(app);
  const requested = scopes.length ? scopes : a.defaultScopes;
  return requested.map((id) => {
    const s = a.scopes.find((x) => x.id === id);
    if (s) return { id, description: s[locale] };
    return { id, description: locale === "sv" ? `Okänd behörighet "${id}" – granska innan du godkänner` : `Unrecognised permission "${id}" - review before approving` };
  });
}

/** Verb-based fallback for vendor actions not in the catalog: send/post/delete/pay-like actions are irreversible. */
export function isIrreversibleActionName(name: string): boolean {
  return /(^|[_\-.\s])(send|post|publish|delete|remove|destroy|archive|trash|pay|charge|refund|transfer|payout|merge|invite|cancel)(?=$|[_\-.\s])/i.test(
    name.replace(/([a-z])([A-Z])/g, "$1_$2"),
  );
}

/** Irreversible flag for an action: catalog value when known, else the verb heuristic. */
export function actionIrreversible(app: string, action: string): boolean {
  const a = findCatalogApp(app);
  const known = a?.actions.find((x) => x.name === action);
  return known ? known.irreversible : isIrreversibleActionName(action);
}
