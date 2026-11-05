import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOpenApiDocument } from "@forge/integrations";
import { MockLLMProvider, type ChatMessage, type CompletionRequest, type ContentBlock } from "@forge/llm";
import {
  MOCK_BUILDER_HEADER,
  addPublicMarker,
  addSessionCheck,
  buildPrompt,
  contrast,
  fixPrompt,
  generateProject,
  improveContrast,
  mockBuildHandler,
  mockPlan,
  openApiPathOf,
  parseConversation,
  parseGateFailures,
  planAuthFix,
  rlsSqlFromFix,
  UnsupportedBuildError,
  type GenerateContext,
  type Spec,
} from "../src/index.js";

const KIT_FILES = ["src/lib/session.ts", "src/db/with-user.ts", "src/db/client.ts", "drizzle/0000_forge_rls.sql", "drizzle.config.ts"];
const weatherDoc = JSON.parse(readFileSync(new URL("../../../evals/fixtures/weather-openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;

function ctx(prompt: string, kind: Spec["kind"], templateId: string, extra: Partial<GenerateContext> = {}): GenerateContext {
  const spec = mockPlan(prompt, kind, templateId);
  return { spec, templateId, files: templateId === "nextjs" && spec.auth ? KIT_FILES : [], ...extra };
}

const labelled = (files: Record<string, string>) =>
  Object.entries(files)
    .filter(([p]) => /\.(tsx?|py|sql)$/.test(p) && !p.endsWith("__init__.py"))
    .every(([, c]) => c.includes(MOCK_BUILDER_HEADER));

describe("generators (representative mockPlan specs)", () => {
  it("OKR SaaS → Next.js + auth with RLS, validation and progress rules", () => {
    const g = generateProject(ctx("Build an OKR tool where teams track objectives and key results; users only see their own", "app", "nextjs"));
    expect(g.generator).toBe("nextjs-auth");
    const schema = g.files["src/db/app-schema.ts"]!;
    expect(schema.match(/pgPolicy\("(objectives|key_results)_owner_all"/g)).toHaveLength(2);
    expect(schema).toMatch(/\.link\(user\)/);
    expect(g.files["src/app/objectives/actions.ts"]).toMatch(/requireUser\(/);
    expect(g.files["src/app/objectives/actions.ts"]).toMatch(/objectiveSchema\.safeParse/);
    expect(g.files["src/lib/validation/objective.ts"]).toMatch(/progress: z\.number\(\)\.int\(\)\.min\(0\)\.max\(100\)/);
    expect(g.files["src/lib/domain/progress.ts"]).toBeDefined();
    expect(g.files["src/app/api/health/route.ts"]).toMatch(/^\/\/ forge:public/);
    expect(g.setup).toContain("npx drizzle-kit generate --name app");
    expect(labelled(g.files)).toBe(true);
  });

  it("salon booking → unique slot index, exclusion constraint migration and booking rules", () => {
    const g = generateProject(ctx("Build a booking system for a hair salon", "app", "nextjs"));
    expect(g.files["src/db/app-schema.ts"]).toMatch(/uniqueIndex\("bookings_stylist_id_slot_uq"\)\.on\(t\.stylistId, t\.startsAt\)/);
    expect(g.files["src/db/app-schema.ts"]).toMatch(/services_read_signed_in/);
    const sql = g.postFiles["drizzle/0002_booking_rules.sql"]!;
    expect(sql).toMatch(/EXCLUDE USING gist \("stylist_id" WITH =, tstzrange\("starts_at", "ends_at"\) WITH &&\)/);
    expect(g.files["src/app/bookings/actions.ts"]).toMatch(/isConflictError\(error\)/);
    expect(g.files["src/app/bookings/actions.ts"]).toMatch(/durationMinutes/);
    expect(g.files["test/booking-rules.test.ts"]).toMatch(/double booking/);
    expect(g.files["src/app/login/page.tsx"]).toMatch(/redirect\("\/sign-in"\)/);
  });

  it("CRM → deal stage enum with check constraint and a pipeline board", () => {
    const g = generateProject(ctx("Build a mini CRM with companies, contacts and a deal pipeline", "app", "nextjs"));
    expect(g.files["src/db/app-schema.ts"]).toMatch(/check\("deals_stage_check", sql`stage in \('lead', 'qualified', 'proposal', 'won', 'lost'\)`\)/);
    expect(g.files["src/lib/domain/deal-stage.ts"]).toMatch(/export const DEAL_STAGES = \["lead"/);
    expect(g.files["src/app/deals/actions.ts"]).toMatch(/export async function moveDealStage/);
    expect(g.files["src/app/deals/page.tsx"]).toMatch(/groupByStage\(rows\)/);
    expect(g.files["src/lib/validation/company.ts"]).toMatch(/https\?/);
  });

  it("blog → slug format validation", () => {
    const g = generateProject(ctx("Build a blog with a CMS", "app", "nextjs"));
    expect(g.files["src/lib/validation/post.ts"]).toMatch(/slug: z\.string\(\)\.trim\(\)\.min\(1, "Required"\)\.max\(120\)\.regex/);
  });

  it("refuses an auth spec when the app-kit auth files are missing", () => {
    expect(() => generateProject({ ...ctx("Build a blog with a CMS", "app", "nextjs"), files: [] })).toThrow(UnsupportedBuildError);
  });

  it("CSV dashboard → Vite app with parser, charts and a labelled sample file", () => {
    const g = generateProject(ctx("Build a dashboard where I upload a CSV of sales and see revenue per month and top products", "app", "vite-react-ts"));
    expect(g.generator).toBe("vite-local");
    expect(g.files["src/lib/csv.ts"]).toMatch(/export function parseCsv/);
    expect(g.files["src/lib/sales-record-csv.ts"]).toMatch(/export function revenueByMonth/);
    expect(g.files["src/lib/sales-record-csv.ts"]).toMatch(/export function topProducts/);
    expect(g.files["src/components/bar-chart.tsx"]).toMatch(/role="img"/);
    expect(g.files["public/sample-sales.csv"]!.split("\n")[0]).toBe("date,product,quantity,revenue");
    expect(g.files["src/components/sales-dashboard.tsx"]).toMatch(/Load sample data \(fictional\)/);
    expect(g.notes.join(" ")).toMatch(/fictional sample data/);
  });

  it("todo → Vite CRUD with zod + a named localStorage adapter and component tests", () => {
    const g = generateProject(ctx("Bygg en att-göra-app", "app", "vite-react-ts"));
    expect(g.files["src/lib/todo.ts"]).toMatch(/createRepository<TodoInput>\("forge\.todos", todoSchema\)/);
    expect(g.files["src/lib/storage.ts"]).toMatch(/export function localStorageStore/);
    expect(g.files["test/app.test.tsx"]).toMatch(/keeps it after a reload/);
    expect(labelled(g.files)).toBe(true);
  });

  it("inventory → Hono CRUD with zValidator, OpenAPI and public markers (spec.auth = false)", () => {
    const g = generateProject(ctx("Build a REST API for an inventory of items", "backend", "hono-api"));
    expect(g.generator).toBe("hono-api");
    const routes = g.files["src/routes/items.ts"]!;
    expect(routes.split("\n")[0]).toMatch(/^\/\/ forge:public/);
    expect(routes.match(/zValidator\("json"/g)).toHaveLength(3);
    expect(g.files["src/app.ts"]).toMatch(/new InMemoryRepository<ItemCreate>\(\["sku"\]\)/);
    expect(g.files["src/openapi.ts"]).toMatch(/z\.toJSONSchema/);
    expect(g.files["test/items.test.ts"]).toMatch(/toBe\(400\)/);
  });

  it("inventory with auth → bearer-token middleware instead of public markers", () => {
    const base = ctx("Build a REST API for an inventory of items", "backend", "hono-api");
    const g = generateProject({ ...base, spec: { ...base.spec, auth: true } });
    expect(g.files["src/routes/items.ts"]).not.toMatch(/forge:public/);
    expect(g.files["src/routes/items.ts"]).toMatch(/r\.use\("\*", requireAuthToken\(apiToken\)\)/);
    expect(g.files["src/env.ts"]).toMatch(/API_TOKEN/);
  });

  it("inventory → FastAPI with strict Pydantic models, routers and pytest validation tests", () => {
    const g = generateProject(ctx("Create a FastAPI service with CRUD endpoints for inventory items", "backend", "fastapi"));
    expect(g.generator).toBe("fastapi");
    expect(g.files["app/schemas.py"]).toMatch(/class ItemCreate\(BaseModel\)/);
    expect(g.files["app/schemas.py"]).toMatch(/quantity: int = Field\(strict=True, ge=0\)/);
    expect(g.files["app/routers/items.py"]!.split("\n")[0]).toMatch(/^# forge:public/);
    expect(g.files["tests/test_items.py"]).toMatch(/status_code == 422/);
    expect(g.setup[0]).toMatch(/ruff format/);
  });

  it("habits → Expo screen with streak logic and tests", () => {
    const g = generateProject(ctx("Build a habit tracker where I check in daily and see my streak", "mobile", "expo"));
    expect(g.generator).toBe("expo");
    expect(g.files["src/lib/domain/streak.ts"]).toMatch(/export function currentStreak/);
    expect(g.files["app/index.tsx"]).toMatch(/Check in today/);
    expect(g.files["test/streak.test.ts"]).toBeDefined();
    expect(g.notes.join(" ")).toMatch(/notifications are not implemented/);
  });

  it("weather app → typed OpenAPI client, server routes keeping the key secret, explorer", () => {
    const base = ctx("Build an app that shows current weather for a city using this API: evals/fixtures/weather-openapi.json", "app", "nextjs");
    expect(openApiPathOf(base.spec)).toBe("evals/fixtures/weather-openapi.json");
    const g = generateProject({ ...base, openapi: { api: parseOpenApiDocument(weatherDoc), name: "weather" } });
    expect(g.generator).toBe("nextjs-local");
    expect(g.files["src/lib/integrations/nordic-weather-client.ts"]).toMatch(/export function createNordicWeatherApi/);
    expect(g.files["src/lib/integrations/nordic-weather.ts"]).toMatch(/process\.env\.NORDIC_WEATHER_API_KEY/);
    const route = g.files["src/app/api/integrations/nordic-weather/get-current-weather/route.ts"]!;
    expect(route).toMatch(/^\/\/ forge:public/);
    expect(route).toMatch(/getCurrentWeatherQuery\.safeParse/);
    expect(g.files["src/components/nordic-weather-explorer.tsx"]).toMatch(/^"use client";/);
    expect(g.files["src/components/nordic-weather-explorer.tsx"]).not.toMatch(/process\.env/);
    expect(g.files["src/app/page.tsx"]).toMatch(/<NordicWeatherExplorer \/>/);
    expect(g.setup[0]).toMatch(/NORDIC_WEATHER_API_KEY/);
  });

  it("is deterministic", () => {
    const c = ctx("Build a booking system for a hair salon", "app", "nextjs");
    expect(JSON.stringify(generateProject(c))).toBe(JSON.stringify(generateProject(c)));
  });
});

// ------------------------------------------------------------------ state machine

type Result = { content: string; isError?: boolean };

/** Drive the handler like runToolLoop does, answering tool calls with `answer`. */
async function drive(messages: ChatMessage[], answer: (name: string, input: Record<string, unknown>) => Result, maxTurns = 12) {
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (let t = 0; t < maxTurns; t++) {
    const reply = await mockBuildHandler({ purpose: "agent.build", model: "m", messages } as CompletionRequest);
    const content: ContentBlock[] = typeof reply === "string" ? [{ type: "text", text: reply }] : reply;
    messages.push({ role: "assistant", content });
    const uses = content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (!uses.length) return { calls, text: content.map((b) => (b.type === "text" ? b.text : "")).join(""), turns: t + 1 };
    calls.push(...uses.map((u) => ({ id: u.id, name: u.name, input: u.input as Record<string, unknown> })));
    messages.push({ role: "user", content: uses.map((u) => ({ type: "tool_result" as const, toolUseId: u.id, ...answer(u.name, u.input as Record<string, unknown>) })) });
  }
  throw new Error("handler did not finish");
}

const manifest = { id: "hono-api", kind: "backend", install: "npm install", dev: "npm run dev", test: "npm test", typecheck: "npm run typecheck", lint: "npm run lint", port: 3000 };
const ok = (name: string, input: Record<string, unknown>): Result => (name === "list_files" ? { content: "package.json\nsrc/app.ts" } : { content: `$ ${String(input.command ?? "npm test")}\nexit 0\nok` });

describe("mock builder state machine", () => {
  it("builds: discover → write → verify → labelled summary", async () => {
    const spec = mockPlan("Build a REST API for an inventory of items", "backend", "hono-api");
    const r = await drive([{ role: "user", content: `${buildPrompt(spec, "hono-api", manifest, "")}\n\n## Repository map\npackage.json (20L)` }], ok);
    expect(r.calls[0]).toMatchObject({ name: "list_files" });
    expect(r.calls.filter((c) => c.name === "write_file").map((c) => c.input.path)).toContain("src/routes/items.ts");
    expect(r.calls.filter((c) => c.name === "run_command").map((c) => c.input.command)).toEqual(["npm run typecheck", "npm run lint"]);
    expect(r.calls.some((c) => c.name === "run_tests")).toBe(true);
    expect(r.text).toContain(MOCK_BUILDER_HEADER);
    expect(r.text).toMatch(/not a language model/);
    expect(r.text).toMatch(/Verification passed/);
  });

  it("runs the auto-fixer once when lint fails, then reports honestly", async () => {
    const spec = mockPlan("Build a REST API for an inventory of items", "backend", "hono-api");
    const r = await drive([{ role: "user", content: buildPrompt(spec, "hono-api", manifest, "") }], (name, input) =>
      name === "run_command" && input.command === "npm run lint" ? { content: "$ npm run lint\nexit 1\nsrc/a.ts\n  1:1  error  bad  no-bad" } : ok(name, input),
    );
    expect(r.calls.filter((c) => c.input.command === "npx eslint . --fix")).toHaveLength(1);
    expect(r.calls.filter((c) => c.input.command === "npm run lint")).toHaveLength(2);
    expect(r.text).toMatch(/did NOT fully pass/);
  });

  it("salon build writes the custom migration after drizzle-kit created it", async () => {
    const spec = mockPlan("Build a booking system for a hair salon", "app", "nextjs");
    const files = KIT_FILES.join("\n");
    const r = await drive([{ role: "user", content: buildPrompt(spec, "nextjs", { ...manifest, id: "nextjs", kind: "app" }, "") }], (name, input) =>
      name === "list_files" ? { content: files } : name === "run_command" && String(input.command).includes("drizzle-kit") ? { content: "$ x\nexit 0\n[✓] Your SQL migration file ➜ drizzle/0007_booking_rules.sql 🚀" } : ok(name, input),
    );
    expect(r.calls.find((c) => c.id.startsWith("mb-setup-"))?.input.command).toMatch(/zod@.* && npx drizzle-kit generate --name app && npx drizzle-kit generate --custom --name booking_rules/);
    expect(r.calls.find((c) => c.id.startsWith("mb-post-"))?.input.path).toBe("drizzle/0007_booking_rules.sql");
  });

  it("explains instead of building when the auth kit is missing", async () => {
    const spec = mockPlan("Build a blog with a CMS", "app", "nextjs");
    const r = await drive([{ role: "user", content: buildPrompt(spec, "nextjs", null, "") }], ok);
    expect(r.text).toMatch(/Not built: .*app-kit auth/);
  });

  it("only verifies websites", async () => {
    const spec = mockPlan('Landing page for "Nordlys"', "website", "astro-site");
    const r = await drive([{ role: "user", content: buildPrompt(spec, "astro-site", { ...manifest, id: "astro-site", kind: "website" }, "") }], ok);
    expect(r.calls.some((c) => c.name === "write_file")).toBe(false);
    expect(r.text).toMatch(/design engine composed this site/);
  });

  it("fix round: marks a public route (spec.auth = false) and re-verifies", async () => {
    const spec = mockPlan("Build a REST API for an inventory of items", "backend", "hono-api");
    const history: ChatMessage[] = [
      { role: "user", content: buildPrompt(spec, "hono-api", manifest, "") },
      { role: "assistant", content: [{ type: "text", text: "built" }] },
      { role: "user", content: fixPrompt("### auth FAILED\n1 of 3 handler(s) lack an auth check\n  - src/extra.ts:3 [auth/missing-check] POST /v1/extra has no authentication check and is not marked public\nProposed fix: ...") },
    ];
    const src = 'import { Hono } from "hono";\nconst app = new Hono();\napp.post("/v1/extra", (c) => c.json({}));\n';
    const r = await drive(history, (name, input) => (name === "read_file" ? { content: src.split("\n").map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n") } : ok(name, input)));
    const write = r.calls.find((c) => c.name === "write_file")!;
    expect(String(write.input.content).split("\n")[2]).toBe("// forge:public — the spec has no user accounts (spec.auth = false)");
    expect(r.text).toMatch(/Applied deterministic fixes/);

    // Same failure again in a later round: no repeat, honest reply.
    history.push({ role: "user", content: fixPrompt("### auth FAILED\n1 of 3 handler(s) lack an auth check\n  - src/extra.ts:3 [auth/missing-check] POST /v1/extra has no authentication check and is not marked public\nProposed fix: ...") });
    const again = await drive(history, ok);
    expect(again.calls.every((c) => c.name === "list_files")).toBe(true);
    expect(again.text).toMatch(/persist after the deterministic fixes/);
  });

  it("fix round: reports what it cannot fix without calling tools beyond discovery", async () => {
    const spec = mockPlan("Build a REST API for an inventory of items", "backend", "hono-api");
    const r = await drive(
      [
        { role: "user", content: buildPrompt(spec, "hono-api", manifest, "") },
        { role: "assistant", content: [{ type: "text", text: "built" }] },
        { role: "user", content: fixPrompt("### client-secrets FAILED\nx\n  - src/a.tsx:1 [client-secrets/server-env-in-client] server-only env var process.env.X referenced in client code") },
      ],
      ok,
    );
    expect(r.calls.map((c) => c.name)).toEqual(["list_files"]);
    expect(r.text).toMatch(/No deterministic fix applies[\s\S]*client-secrets/);
  });

  it("design round: raises low contrast in tokens.css", async () => {
    const css = ":root {\n  --color-bg: #ffffff;\n  --color-text: #999999;\n  --color-muted: #bbbbbb;\n  --color-accent: #3349c7;\n  --color-accent-contrast: #ffffff;\n}\n";
    const r = await drive(
      [{ role: "user", content: "The design critic scored the site 6/10 (needs 8). Revise per these notes, keeping performance and accessibility:\nBody text has low contrast.\n\n## Repository map\nsrc/styles/tokens.css (10L)" }],
      (name, input) => (name === "read_file" ? { content: css.split("\n").map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n") } : ok(name, input)),
    );
    const written = String(r.calls.find((c) => c.name === "write_file")?.input.content);
    const text = /--color-text: (#[0-9a-f]{6})/.exec(written)?.[1] ?? "";
    expect(contrast(text, "#ffffff")).toBeGreaterThanOrEqual(7);
    expect(r.text).toMatch(/Raised contrast/);
  });

  it("is registered for purpose agent.build", async () => {
    const llm = new MockLLMProvider();
    const r = await llm.complete({ purpose: "agent.build", model: "m", messages: [{ role: "user", content: "hello" }] });
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(r.content)).toContain(MOCK_BUILDER_HEADER);
  });
});

describe("fix helpers", () => {
  it("parses gate summaries", () => {
    const f = parseGateFailures("### rls FAILED\n1 of 2 table(s) missing row level security\n  - drizzle/0001.sql:3 [rls/no-policy] table \"notes\" is missing a CREATE POLICY\nProposed fix: Add a migration:\nALTER TABLE notes ENABLE ROW LEVEL SECURITY;\nCREATE POLICY notes_owner_all ON notes FOR ALL USING (owner_id = current_setting('app.user_id', true)::uuid) WITH CHECK (owner_id = current_setting('app.user_id', true)::uuid);");
    expect(f[0]).toMatchObject({ gate: "rls", findings: [{ file: "drizzle/0001.sql", line: 3, rule: "rls/no-policy" }] });
    expect(rlsSqlFromFix(f[0]!.fix, true)[1]).toBe("CREATE POLICY notes_owner_all ON notes FOR ALL USING (owner_id::text = forge_current_user_id()) WITH CHECK (owner_id::text = forge_current_user_id());");
  });

  it("only marks routes public when the spec allows it", () => {
    const auth = mockPlan("Build a blog with a CMS", "app", "nextjs");
    const files = new Set(["src/lib/session.ts"]);
    expect(planAuthFix({ file: "src/app/api/health/route.ts", line: 2, rule: "auth/missing-check", message: "GET /api/health has no authentication check" }, auth, files).kind).toBe("public");
    expect(planAuthFix({ file: "src/app/api/posts/route.ts", line: 2, rule: "auth/missing-check", message: "POST /api/posts has no authentication check" }, auth, files).kind).toBe("session");
    expect(planAuthFix({ file: "src/server.ts", line: 2, rule: "auth/missing-check", message: "POST /x has no authentication check" }, auth, new Set()).kind).toBe("none");
  });

  it("inserts markers and session checks", () => {
    expect(addPublicMarker("a\n  @app.get('/x')\n  def x(): ...", "main.py", 2, "why")).toBe("a\n  # forge:public — why\n  @app.get('/x')\n  def x(): ...");
    const next = addSessionCheck('import { db } from "@/db";\n\nexport function POST(req: Request) {\n  return Response.json({});\n}\n', 3, "next-app")!;
    expect(next).toMatch(/import \{ getSession \} from "@\/lib\/session";/);
    expect(next).toMatch(/export async function POST\(req: Request\) \{\n {2}const session = await getSession\(\);\n {2}if \(!session\) return Response\.json/);
  });

  it("improves contrast in every token block and leaves good tokens alone", () => {
    const good = ":root { --color-bg: #ffffff; --color-text: #111111; }";
    expect(improveContrast(good).changes).toEqual([]);
    const r = improveContrast(":root { --color-bg: #101014; --color-muted: #333333; }\n@media (prefers-color-scheme: light) { :root { --color-bg: #ffffff; --color-muted: #cccccc; } }");
    expect(r.changes).toHaveLength(2);
  });

  it("reads the round and spec from the conversation", () => {
    const spec = mockPlan("Build a REST API for an inventory of items", "backend", "hono-api");
    const c = parseConversation([{ role: "user", content: `${buildPrompt(spec, "hono-api", manifest, "")}\n\n## Repository map\nx (1L)` }]);
    expect(c.round.kind).toBe("build");
    expect(c.templateId).toBe("hono-api");
    expect(c.spec?.title).toBe("Inventory Service");
    expect(c.commands.test).toBe("npm test");
    expect(c.round.repoMap).toBe("x (1L)");
  });
});
