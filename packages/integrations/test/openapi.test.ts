import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { MemoryUsageSink } from "@forge/shared";
import { MockLLMProvider, runTool, toToolDef } from "@forge/llm";
import {
  authFromScheme,
  callOperation,
  generateTypedClient,
  heuristicDocsSpec,
  importOpenApi,
  jsonSchemaToZod,
  normalizeDocs,
  openApiTools,
  operationInputSchema,
  parseOpenApiDocument,
  type ImportedApi,
} from "../src/index.js";
import { fakeDns, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const WEATHER = join(here, "../../../evals/fixtures/weather-openapi.json");
const run = promisify(execFile);

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
}
function recordingFetch(response: unknown = { ok: true }, status = 200): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: new URL(req.url), method: req.method, headers: req.headers, body: init?.body ? await req.text() : null });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, seen };
}

let weather: ImportedApi;
beforeAll(async () => {
  weather = await importOpenApi(JSON.parse(await readFile(WEATHER, "utf8")));
});

describe("importOpenApi", () => {
  it("parses the weather fixture (OpenAPI 3.1) with local $refs", async () => {
    expect(weather.source).toBe("openapi-3.1");
    expect(weather.title).toBe("Nordic Weather API");
    expect(weather.baseUrl).toBe("https://api.nordicweather.example");
    expect(weather.operations.map((o) => [o.id, o.method, o.path])).toEqual([
      ["getCurrentWeather", "get", "/v1/current"],
      ["getForecast", "get", "/v1/forecast"],
    ]);
    const cur = weather.operations[0]!;
    expect(cur.parameters.map((p) => [p.name, p.in, p.required])).toEqual([
      ["city", "query", true],
      ["units", "query", false],
      ["lang", "query", false],
    ]);
    expect(cur.security).toEqual([{ ApiKeyAuth: [] }]);
    expect(weather.securitySchemes.ApiKeyAuth).toMatchObject({ type: "apiKey", in: "header", name: "X-API-Key" });
    const input = operationInputSchema(weather, cur) as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(input.required).toEqual(["city"]);
    expect(input.properties.units!.enum).toEqual(["metric", "imperial"]);
    expect(JSON.stringify(input)).not.toContain("$ref");
  });

  it("loads from a local file only when allowed", async () => {
    await expect(importOpenApi(WEATHER)).rejects.toThrow();
    const api = await importOpenApi(WEATHER, { allowLocalFiles: true });
    expect(api.operations).toHaveLength(2);
  });

  it("parses YAML and names operations without operationId", async () => {
    const yaml = `openapi: 3.0.3
info: { title: Items, version: "1" }
servers: [{ url: "https://items.example/api" }]
paths:
  /items/{itemId}:
    parameters:
      - { name: itemId, in: path, required: true, schema: { type: string } }
    get:
      responses: { "200": { description: ok } }
    delete:
      responses: { "204": { description: gone } }
  /items:
    post:
      summary: Send an item to the warehouse
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, required: [name], properties: { name: { type: string, nullable: true } } }
      responses: { "201": { description: created } }
`;
    const api = await importOpenApi(yaml);
    expect(api.source).toBe("openapi-3.0");
    expect(api.operations.map((o) => [o.id, o.irreversible])).toEqual([
      ["getItemsByItemId", false],
      ["deleteItemsByItemId", true],
      ["postItems", true],
    ]);
    const post = api.operations[2]!;
    expect(post.requestBody).toMatchObject({ contentType: "application/json", required: true });
    const z = jsonSchemaToZod(operationInputSchema(api, post));
    expect(z.safeParse({ body: { name: null } }).success).toBe(true);
    expect(z.safeParse({}).success).toBe(false);
  });

  it("converts Swagger 2.0 (host/basePath, body + formData params, definitions, security)", () => {
    const api = parseOpenApiDocument({
      swagger: "2.0",
      info: { title: "Pets", version: "2" },
      host: "pets.example",
      basePath: "/v2",
      schemes: ["https"],
      consumes: ["application/json"],
      securityDefinitions: { key: { type: "apiKey", in: "header", name: "api_key" }, basicAuth: { type: "basic" }, oauth: { type: "oauth2", flow: "accessCode", authorizationUrl: "https://pets.example/oauth", tokenUrl: "https://pets.example/token", scopes: { "read:pets": "read" } } },
      security: [{ key: [] }],
      parameters: { petId: { name: "petId", in: "path", required: true, type: "integer" } },
      paths: {
        "/pets": {
          post: { operationId: "addPet", parameters: [{ name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Pet" } }], responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } } } },
          get: { operationId: "findPets", parameters: [{ name: "tags", in: "query", type: "array", items: { type: "string" } }], responses: { "200": { description: "ok", schema: { type: "array", items: { $ref: "#/definitions/Pet" } } } } },
        },
        "/pets/{petId}/photo": {
          post: { operationId: "uploadPhoto", consumes: ["multipart/form-data"], parameters: [{ $ref: "#/parameters/petId" }, { name: "file", in: "formData", type: "file", required: true }, { name: "caption", in: "formData", type: "string" }], responses: { "200": { description: "ok" } } },
        },
      },
      definitions: { Pet: { type: "object", required: ["name"], properties: { id: { type: "integer" }, name: { type: "string" }, owner: { $ref: "#/definitions/Owner" } } }, Owner: { type: "object", properties: { pets: { type: "array", items: { $ref: "#/definitions/Pet" } } } } },
    });
    expect(api.source).toBe("swagger-2.0");
    expect(api.baseUrl).toBe("https://pets.example/v2");
    const add = api.operations.find((o) => o.id === "addPet")!;
    expect(add.requestBody).toEqual({ contentType: "application/json", required: true, schema: { $ref: "#/components/schemas/Pet" } });
    expect(add.responseSchema).toEqual({ $ref: "#/components/schemas/Pet" });
    const upload = api.operations.find((o) => o.id === "uploadPhoto")!;
    expect(upload.parameters).toEqual([{ name: "petId", in: "path", required: true, schema: { type: "integer" } }]);
    expect(upload.requestBody!.contentType).toBe("multipart/form-data");
    expect(api.securitySchemes).toMatchObject({ key: { type: "apiKey", name: "api_key" }, basicAuth: { type: "http", scheme: "basic" }, oauth: { type: "oauth2", flows: { authorizationCode: { tokenUrl: "https://pets.example/token" } } } });
    // recursive Pet -> Owner -> Pet is cut, not infinite
    const schema = JSON.stringify(operationInputSchema(api, add));
    expect(schema).toContain("recursive");
    expect(() => jsonSchemaToZod(operationInputSchema(api, add))).not.toThrow();
    expect(generateTypedClient(api)).toContain("export type Owner");
  });

  it("rejects documents that are not specs and finds no endpoints in prose", async () => {
    expect(() => parseOpenApiDocument({ hello: "world" })).toThrow(/Not an OpenAPI/);
    await expect(importOpenApi("Just some text without any endpoints.")).rejects.toThrow(/No API endpoints/);
  });
});

describe("openApiTools / callOperation", () => {
  it("builds tools whose calls carry params and the API key", async () => {
    const { fetch, seen } = recordingFetch({ temperature: 4.5 });
    const tools = openApiTools(weather, authFromScheme(weather, "wk_live_123"), { fetch });
    expect(tools.map((t) => t.name)).toEqual(["nordic_weather_api_getCurrentWeather", "nordic_weather_api_getForecast"]);
    expect(toToolDef(tools[0]!).inputSchema).toMatchObject({ type: "object", required: ["city"] });
    const r = await runTool(tools, "nordic_weather_api_getCurrentWeather", { city: "Stockholm,SE", units: "metric" }, {});
    expect(r).toEqual({ ok: true, output: JSON.stringify({ status: 200, data: { temperature: 4.5 } }) });
    expect(seen[0]!.url.toString()).toBe("https://api.nordicweather.example/v1/current?city=Stockholm%2CSE&units=metric");
    expect(seen[0]!.headers.get("x-api-key")).toBe("wk_live_123");
    expect((await runTool(tools, "nordic_weather_api_getForecast", { city: "Oslo", days: 99 }, {})).ok).toBe(false); // max 10
    expect((await runTool(tools, "nordic_weather_api_getCurrentWeather", { units: "metric" }, {})).ok).toBe(false);
  });

  it("supports bearer, basic, oauth2 and apiKey-in-query auth, path params and bodies", async () => {
    const api = parseOpenApiDocument({
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://t.example/api/" }],
      paths: {
        "/users/{id}/notes": {
          post: {
            operationId: "addNote",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "X-Request-Id", in: "header", schema: { type: "string" } }],
            requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } } } } } },
            responses: { "201": { description: "ok" } },
          },
        },
        "/form": { post: { operationId: "form", requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } } }, responses: { "200": { description: "ok" } } } },
      },
    });
    const { fetch, seen } = recordingFetch();
    await callOperation(api, "addNote", { id: "a/b", "X-Request-Id": "r1", body: { text: "hej" } }, { type: "bearer", token: "tok" }, { fetch });
    expect(seen[0]!.url.toString()).toBe("https://t.example/api/users/a%2Fb/notes");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok");
    expect(seen[0]!.headers.get("x-request-id")).toBe("r1");
    expect(JSON.parse(seen[0]!.body!)).toEqual({ text: "hej" });
    await callOperation(api, "addNote", { id: "1", body: {} }, { type: "basic", username: "u", password: "p" }, { fetch });
    expect(seen[1]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    await callOperation(api, "addNote", { id: "1", body: {} }, { type: "oauth2", accessToken: "oa" }, { fetch });
    expect(seen[2]!.headers.get("authorization")).toBe("Bearer oa");
    await callOperation(api, "addNote", { id: "1", body: {} }, { type: "apiKey", in: "query", name: "key", value: "k1" }, { fetch });
    expect(seen[3]!.url.searchParams.get("key")).toBe("k1");
    await callOperation(api, "form", { body: { a: 1, b: "x y" } }, { type: "none" }, { fetch });
    expect(seen[4]!.body).toBe("a=1&b=x+y");
    expect(seen[4]!.headers.get("content-type")).toMatch(/x-www-form-urlencoded/);
    await expect(callOperation(api, "addNote", { body: {} }, { type: "none" }, { fetch })).rejects.toThrow(/Missing path parameter/);
    await expect(callOperation(api, "nope", {}, { type: "none" }, { fetch })).rejects.toThrow(/not found/);
    // lender-style auth (vaultAuth shape): credential only exists inside the callback
    let lent = 0;
    await callOperation(api, "addNote", { id: "1", body: {} }, async (fn) => {
      lent++;
      return fn({ type: "bearer", token: "lent" });
    }, { fetch });
    expect(lent).toBe(1);
    expect(seen[5]!.headers.get("authorization")).toBe("Bearer lent");
  });

  it("uses the SSRF guard by default for API calls", async () => {
    const api = parseOpenApiDocument({ openapi: "3.1.0", info: { title: "L", version: "1" }, servers: [{ url: "http://169.254.169.254" }], paths: { "/latest/meta-data": { get: { responses: { "200": { description: "x" } } } } } });
    await expect(callOperation(api, api.operations[0]!.id, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("importOpenApi from URLs and docs", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const DOCS = `<!doctype html><html><head><title>Acme Tasks API</title><style>.x{}</style></head><body>
<h1>Acme Tasks API</h1>
<p>Base URL: <code>https://api.acme-tasks.example/v2</code></p>
<h2>List tasks</h2>
<pre>GET /tasks?status=open</pre>
<table><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr>
<tr><td>status</td><td>string</td><td>no</td><td>Filter by status</td></tr>
<tr><td>limit</td><td>integer</td><td>no</td><td>Max results</td></tr></table>
<h2>Create task</h2>
<pre>POST /tasks</pre>
<table><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
<tbody><tr><td>title</td><td>string</td><td>yes</td><td>Task title</td></tr>
<tr><td>due</td><td>string</td><td>no</td><td>ISO date &amp; time</td></tr></tbody></table>
<h2>Get a task</h2><p><code>GET /tasks/:id</code> &mdash; returns one task</p>
<h2>Delete a task</h2><p><code>DELETE /tasks/{id}</code></p>
<script>var hidden = "GET /admin/secret";</script>
</body></html>`;
  const policy = () => ({ resolver: fakeDns({ "specs.test": ["127.0.0.1"] }), allowAddresses: ["127.0.0.1"] });

  beforeAll(async () => {
    srv = await startServer({
      "/openapi.json": (_q, r) => {
        r.setHeader("content-type", "application/json");
        r.end(JSON.stringify({ openapi: "3.0.0", info: { title: "Rel", version: "1" }, servers: [{ url: "/v1" }], paths: { "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } } } }));
      },
      "/docs": (_q, r) => {
        r.setHeader("content-type", "text/html");
        r.end(DOCS);
      },
    });
  });
  afterAll(() => srv.close());

  it("fetches specs through the SSRF guard and resolves relative servers", async () => {
    const api = await importOpenApi(`http://specs.test:${srv.port}/openapi.json`, policy());
    expect(api.baseUrl).toBe(`http://specs.test:${srv.port}/v1`);
    await expect(importOpenApi(`http://127.0.0.1:${srv.port}/openapi.json`)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(importOpenApi("http://169.254.169.254/latest/")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("extracts endpoints and parameter tables from HTML docs heuristically", async () => {
    const text = normalizeDocs(DOCS);
    expect(text).not.toContain("admin/secret");
    expect(text).toContain("| Parameter | Type | Required | Description |");
    const spec = heuristicDocsSpec(text);
    expect(spec.title).toBe("Acme Tasks API");
    expect(spec.baseUrl).toBe("https://api.acme-tasks.example/v2");
    expect(spec.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /tasks", "POST /tasks", "GET /tasks/{id}", "DELETE /tasks/{id}"]);
    expect(spec.endpoints[0]!.params.map((p) => [p.name, p.in, p.type])).toEqual([
      ["status", "query", "string"],
      ["limit", "query", "integer"],
    ]);
    expect(spec.endpoints[1]!.params).toEqual([
      { name: "title", in: "body", required: true, type: "string", description: "Task title" },
      { name: "due", in: "body", required: false, type: "string", description: "ISO date & time" },
    ]);
    expect(spec.endpoints[2]!.summary).toMatch(/returns one task/);

    const api = await importOpenApi(`http://specs.test:${srv.port}/docs`, policy());
    expect(api.source).toBe("docs-heuristic");
    expect(api.baseUrl).toBe("https://api.acme-tasks.example/v2");
    expect(api.operations.map((o) => [o.id, o.irreversible])).toEqual([
      ["getTasks", false],
      ["postTasks", false],
      ["getTasksById", false],
      ["deleteTasksById", true],
    ]);
    expect(api.operations[1]!.requestBody!.schema).toMatchObject({ required: ["title"] });
  });

  it("uses LLM purpose integrations.docs_to_openapi when an LLM is given (mock = heuristic), metered", async () => {
    const usage = new MemoryUsageSink();
    const llm = new MockLLMProvider();
    const api = await importOpenApi(DOCS, { llm, usage });
    expect(api.source).toBe("docs-llm");
    expect(llm.calls[0]!.purpose).toBe("integrations.docs_to_openapi");
    expect(api.operations).toHaveLength(4);
    expect(usage.records.length).toBeGreaterThan(0);
    expect(usage.totalUsd()).toBeGreaterThan(0);
  });
});

describe("generateTypedClient", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-client-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("emits a client that typechecks under strict settings and enforces input types", async () => {
    const src = generateTypedClient(weather);
    expect(src).toContain("export type CurrentWeather =");
    expect(src).toContain("getCurrentWeather(input: GetCurrentWeatherInput");
    await writeFile(join(dir, "client.ts"), src);
    await writeFile(
      join(dir, "usage.ts"),
      `import { createClient, ApiError, type CurrentWeather, type Forecast, type Condition } from "./client.js";
const client = createClient({ auth: { type: "apiKey", in: "header", name: "X-API-Key", value: "k" } });
export async function main(): Promise<string> {
  const w: CurrentWeather = await client.getCurrentWeather({ city: "Stockholm", units: "metric", lang: "sv" });
  const t: number = w.temperature;
  const c: Condition = w.condition;
  const dir: number | null | undefined = w.windDirection;
  const f: Forecast = await client.getForecast({ city: "Oslo", days: 3 });
  const first = f.days[0];
  const max: number = first ? first.max : 0;
  // @ts-expect-error city is required
  await client.getCurrentWeather({});
  // @ts-expect-error units must be metric | imperial
  await client.getCurrentWeather({ city: "x", units: "kelvin" });
  // @ts-expect-error unknown field on the response
  void w.notAField;
  try { await client.getForecast({ city: "?" }); } catch (e) { if (e instanceof ApiError) return String(e.status); }
  return [t, c, dir, max, w.location.name].join(",");
}
`,
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM"], strict: true, noUncheckedIndexedAccess: true, noUnusedLocals: true, noUnusedParameters: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ["*.ts"],
      }),
    );
    const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
    const res = await run(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")]).catch((e: { stdout: string; stderr: string }) => e);
    expect("stdout" in res ? res.stdout + res.stderr : "").toBe("");
  }, 60_000);

  it("generated client performs requests at runtime", async () => {
    const js = ts.transpileModule(generateTypedClient(weather), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const file = join(dir, "client.runtime.mjs");
    await writeFile(file, js);
    const mod = (await import(pathToFileURL(file).href)) as {
      createClient(o: unknown): { getCurrentWeather(i: unknown): Promise<unknown>; getForecast(i: unknown): Promise<unknown> };
      ApiError: new (...a: unknown[]) => Error;
    };
    const { fetch, seen } = recordingFetch({ temperature: -3 });
    const c = mod.createClient({ fetch, auth: { type: "apiKey", in: "header", name: "X-API-Key", value: "k9" } });
    expect(await c.getCurrentWeather({ city: "Kiruna", units: "metric" })).toEqual({ temperature: -3 });
    expect(seen[0]!.url.toString()).toBe("https://api.nordicweather.example/v1/current?city=Kiruna&units=metric");
    expect(seen[0]!.headers.get("x-api-key")).toBe("k9");
    const failing = mod.createClient({ fetch: recordingFetch({ code: "city_not_found", message: "?" }, 404).fetch });
    await expect(failing.getForecast({ city: "Atlantis" })).rejects.toBeInstanceOf(mod.ApiError);
  });
});
