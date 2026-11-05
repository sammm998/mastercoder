import { registerMockHandler, type CompletionRequest } from "@forge/llm";
import type { Entity, Spec } from "./spec.js";
import { mockBuildHandler } from "./mock-builder/index.js";

/**
 * Rule-based stand-ins for the planner / reviewer / summary model calls, used when LLM_PROVIDER=mock.
 * They are deterministic heuristics (domain lexicon → data model), not a language model, and every spec
 * they produce carries `designNotes` prefixed with "[mock planner]".
 */

function lastUserText(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  }
  return "";
}

type DomainEntity = Omit<Entity, "description" | "ownerScoped"> & { description?: string; ownerScoped?: boolean };

interface Domain {
  match: RegExp;
  title: string;
  entities: DomainEntity[];
  stories: string[];
  auth?: boolean;
}

const f = (name: string, type: Entity["fields"][number]["type"], extra: Partial<Entity["fields"][number]> = {}) => ({ name, type, required: true, ...extra });

const DOMAINS: Domain[] = [
  {
    match: /\b(okr|objectives?|key results?)\b/i,
    title: "OKR Tracker",
    auth: true,
    entities: [
      { name: "Objective", fields: [f("title", "string"), f("description", "text", { required: false }), f("quarter", "string"), f("progress", "integer")] },
      { name: "KeyResult", fields: [f("objectiveId", "reference", { references: "Objective" }), f("title", "string"), f("target", "number"), f("current", "number")] },
    ],
    stories: ["As a user I can sign up and log in", "As a user I can create objectives with key results", "As a user I only see my own objectives", "As a user I can update key result progress"],
  },
  {
    match: /\b(booking|bokning|bokningssystem|frisör|salon|salong|appointments?|tidsbokning)\b/i,
    title: "Salon Booking",
    auth: true,
    entities: [
      { name: "Service", ownerScoped: false, fields: [f("name", "string"), f("durationMinutes", "integer"), f("priceSek", "number")] },
      { name: "Stylist", ownerScoped: false, fields: [f("name", "string"), f("bio", "text", { required: false })] },
      { name: "Booking", fields: [f("serviceId", "reference", { references: "Service" }), f("stylistId", "reference", { references: "Stylist" }), f("startsAt", "datetime"), f("customerName", "string"), f("customerEmail", "email")] },
    ],
    stories: ["As a customer I can pick a service, a stylist and a free time slot", "As a customer I cannot book a slot that is already taken", "As staff I can see today's bookings", "As a customer I get a confirmation"],
  },
  {
    match: /\b(crm|deals?|pipeline|kanban)\b/i,
    title: "Mini CRM",
    auth: true,
    entities: [
      { name: "Company", fields: [f("name", "string"), f("website", "url", { required: false })] },
      { name: "Contact", fields: [f("companyId", "reference", { references: "Company" }), f("name", "string"), f("email", "email")] },
      { name: "Deal", fields: [f("companyId", "reference", { references: "Company" }), f("title", "string"), f("value", "number"), f("stage", "enum", { enumValues: ["lead", "qualified", "proposal", "won", "lost"] })] },
      { name: "Note", fields: [f("dealId", "reference", { references: "Deal" }), f("body", "text")] },
    ],
    stories: ["As a user I can manage companies and contacts", "As a user I can move deals between pipeline stages", "As a user I can add notes to a deal"],
  },
  {
    match: /\b(blog|blogg|cms|posts?|inlägg)\b/i,
    title: "Blog with CMS",
    auth: true,
    entities: [{ name: "Post", fields: [f("title", "string"), f("slug", "string"), f("excerpt", "text", { required: false }), f("body", "text"), f("published", "boolean")] }],
    stories: ["As an editor I can write, edit and publish posts", "As a reader I can read published posts", "As a search engine I get a sitemap and Open Graph metadata"],
  },
  {
    match: /\b(csv|sales|försäljning|revenue|intäkt)\b/i,
    title: "Sales Dashboard",
    entities: [{ name: "SalesRecord", ownerScoped: false, fields: [f("date", "date"), f("product", "string"), f("quantity", "integer"), f("revenue", "number")] }],
    stories: ["As a user I can upload a CSV of sales", "As a user I see revenue per month as a chart", "As a user I see top products as a chart"],
  },
  {
    match: /\b(habit|vana|vanor|streaks?)\b/i,
    title: "Habit Tracker",
    entities: [
      { name: "Habit", fields: [f("name", "string"), f("reminderTime", "string", { required: false })] },
      { name: "CheckIn", fields: [f("habitId", "reference", { references: "Habit" }), f("date", "date")] },
    ],
    stories: ["As a user I can add habits", "As a user I can check in daily and see my streak", "As a user I get a local reminder notification"],
  },
  {
    match: /\b(inventory|lager|stock|items?)\b/i,
    title: "Inventory Service",
    entities: [{ name: "Item", ownerScoped: false, fields: [f("name", "string"), f("sku", "string"), f("quantity", "integer"), f("priceSek", "number")] }],
    stories: ["As an API client I can create, read, update and delete inventory items", "As an API client I get validation errors for bad input", "As a developer I can read OpenAPI docs"],
  },
  {
    match: /\b(todo|to-do|att-göra|uppgift|uppgifter|tasks?)\b/i,
    title: "Todo App",
    entities: [{ name: "Todo", fields: [f("title", "string"), f("done", "boolean")] }],
    stories: ["As a user I can add a task", "As a user I can check off a task", "As a user my tasks are saved"],
  },
  {
    match: /\b(weather|väder)\b/i,
    title: "Weather App",
    entities: [{ name: "SavedCity", fields: [f("name", "string")] }],
    stories: ["As a user I can search a city and see the current weather", "As a user I can see the forecast", "As a user I see a friendly error when the API fails"],
  },
  {
    match: /\b(hubspot|contacts?|kontakter)\b/i,
    title: "Contacts Tool",
    auth: true,
    entities: [{ name: "ContactNote", fields: [f("contactId", "string"), f("body", "text")] }],
    stories: ["As a user I can list our HubSpot contacts", "As a user I can add a note to a contact", "As an admin I see which scopes the integration uses"],
  },
];

function websiteSpec(prompt: string): Pick<Spec, "title" | "userStories" | "screens"> {
  const name = prompt.match(/["“”']([^"“”']{2,40})["“”']/)?.[1] ?? (prompt.match(/\bfor (?:a |an )?([A-Z][\w-]+(?: [A-Z][\w-]+)?)/)?.[1] ?? "Studio");
  const portfolio = /portfolio|portfölj|architect|arkitekt|projects/i.test(prompt);
  return {
    title: portfolio ? `${name} Portfolio` : `${name} Landing Page`,
    userStories: portfolio
      ? ["As a visitor I scroll through featured projects told as a story", "As a visitor I can open a project for details", "As a visitor I can contact the studio"]
      : ["As a visitor I immediately understand the product from the hero", "As a visitor I experience smooth, accessible motion", "As a visitor I can sign up or contact the company"],
    screens: [
      { path: "/", name: "Home", purpose: portfolio ? "Scroll-storytelling portfolio" : "Award-style landing page", public: true },
      { path: "/privacy", name: "Privacy", purpose: "Privacy policy", public: true },
    ],
  };
}

export function mockPlan(prompt: string, kind: Spec["kind"], template?: string): Spec {
  const base = { kind, template, integrations: [] as string[], tasks: [] as Spec["tasks"], designNotes: "[mock planner] rule-based spec from the domain lexicon" };
  if (kind === "website") {
    const w = websiteSpec(prompt);
    return {
      ...base,
      ...w,
      summary: prompt.slice(0, 300),
      entities: [],
      auth: false,
      acceptanceTests: [
        { id: "AT1", title: "Hero renders", given: "a visitor on /", when: "the page loads", then: "the main heading and call to action are visible" },
        { id: "AT2", title: "Reduced motion", given: "prefers-reduced-motion is set", when: "the page loads", then: "no scroll-driven animation runs and content is visible" },
        { id: "AT3", title: "Mobile layout", given: "a 375px viewport", when: "the page loads", then: "there is no horizontal overflow" },
      ],
      tasks: [
        { id: "T1", title: "Compose sections from the pattern library", dependsOn: [] },
        { id: "T2", title: "Write copy and metadata", dependsOn: ["T1"] },
      ],
    };
  }
  const d = DOMAINS.find((x) => x.match.test(prompt));
  const entities: Entity[] = (d?.entities ?? [{ name: "Item", fields: [f("title", "string"), f("notes", "text", { required: false })] }]).map((e) => ({ description: "", ownerScoped: true, ...e }));
  const auth = kind === "backend" ? false : Boolean(d?.auth || /\b(login|log in|sign ?up|logga in|konto|users?|användare|only see|own)\b/i.test(prompt));
  const title = d?.title ?? (prompt.split(/[.!?\n]/)[0] ?? "App").slice(0, 60);
  const main = entities[entities.length - 1]!;
  const lower = main.name.charAt(0).toLowerCase() + main.name.slice(1);
  return {
    ...base,
    title,
    summary: prompt.slice(0, 300),
    userStories: d?.stories ?? [`As a user I can create, list, edit and delete ${lower}s`],
    entities,
    screens:
      kind === "backend"
        ? []
        : [
            { path: "/", name: "Home", purpose: `List of ${lower}s`, public: !auth },
            ...entities.map((e) => ({ path: `/${e.name.toLowerCase()}s`, name: `${e.name}s`, purpose: `Manage ${e.name.toLowerCase()}s`, public: false })),
            ...(auth ? [{ path: "/login", name: "Login", purpose: "Sign in / sign up", public: true }] : []),
          ],
    auth,
    acceptanceTests: [
      ...(auth ? [{ id: "AT0", title: "Sign up and sign in", given: "a new visitor", when: "they sign up with email and password", then: "they land on the dashboard signed in" }] : []),
      { id: "AT1", title: `Create ${lower}`, given: "the app is open", when: `the user creates a ${lower}`, then: `it appears in the list` },
      { id: "AT2", title: `Persist ${lower}`, given: `a created ${lower}`, when: "the page reloads", then: "it is still there" },
      { id: "AT3", title: "Validation", given: "the create form", when: "required fields are empty", then: "an error is shown and nothing is saved" },
    ],
    tasks: [
      { id: "T1", title: "Data model + migrations with row-level access rules", dependsOn: [] },
      { id: "T2", title: "Validated API routes", dependsOn: ["T1"] },
      { id: "T3", title: "Screens", dependsOn: ["T2"] },
      { id: "T4", title: "Tests for acceptance criteria", dependsOn: ["T3"] },
    ],
  };
}

registerMockHandler("agent.plan", (req) => {
  const text = lastUserText(req);
  const prompt = text.match(/Request:\n([\s\S]*?)\n\nDetected intents/)?.[1] ?? text;
  const kind = (text.match(/Primary kind: (\w+)/)?.[1] ?? "app") as Spec["kind"];
  const template = text.match(/template: ([\w-]+)/)?.[1];
  return JSON.stringify(mockPlan(prompt, kind, template));
});

/** Mock reviewer: real static checks on the changed files (not an LLM judgement). */
registerMockHandler("agent.review", (req) => {
  const text = lastUserText(req);
  const issues: Array<{ file?: string; problem: string; fix: string }> = [];
  for (const m of text.matchAll(/### (\S+)\n```\n([\s\S]*?)\n```/g)) {
    const [, file, body] = m;
    if (!file || !body) continue;
    if (/^(?!.*(test|spec)).*\.(tsx?|jsx?)$/.test(file) && /(\/\/|\/\*|#)\s*(TODO|FIXME)\b|\bnot implemented\b/.test(body)) issues.push({ file, problem: "Unfinished code (TODO/not implemented)", fix: "Implement the missing behaviour" });
    if (/\.(tsx|jsx)$/.test(file) && /"use client"/.test(body) && /process\.env\.(?!NEXT_PUBLIC_)[A-Z_]*(SECRET|KEY|TOKEN)/.test(body)) issues.push({ file, problem: "Server secret referenced in a client component", fix: "Move the call to a server route" });
  }
  return JSON.stringify({ approved: issues.length === 0, issues });
});

registerMockHandler("agent.summary", (req) => lastUserText(req).split("\n")[0] ?? "Build completed.");

/** Offline builder: rule-based, template-based code generation (see src/mock-builder). */
registerMockHandler("agent.build", mockBuildHandler);
