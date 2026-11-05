import type { EntityModel, FieldModel } from "./model.js";
import { entityModels, invalidFor, sampleFor, zodFor } from "./model.js";
import { TS_HEADER, q } from "./names.js";
import { emptyProject, type GenerateContext, type GeneratedProject } from "./types.js";

/**
 * Hono API generator: one zod-validated CRUD router per entity on an in-memory repository (clearly
 * named; swap for a database adapter), an OpenAPI 3.1 document built from the zod schemas, and tests
 * that cover validation rejection. Routes are marked `forge:public` only when the spec has no auth;
 * with auth they require a bearer token (API_TOKEN).
 */

const uniqueFields = (m: EntityModel): FieldModel[] => m.fields.filter((f) => /^(sku|slug|email|code)$/i.test(f.name));

function domainTs(m: EntityModel, models: EntityModel[]): string {
  const refLabel = (f: FieldModel) => models.find((x) => x.name === f.references)?.label;
  return `${TS_HEADER}
import { z } from "zod";

/** Request body for creating (and fully replacing) a ${m.label.toLowerCase()}. Unknown keys are rejected. */
export const ${m.camel}CreateSchema = z
  .object({
${m.fields.map((f) => `    ${f.name}: ${zodFor(f, "json", refLabel(f))},`).join("\n")}
  })
  .strict();

/** Partial update (PATCH): any subset of the fields, at least one. */
export const ${m.camel}UpdateSchema = ${m.camel}CreateSchema.partial().refine((v) => Object.keys(v).length > 0, "Provide at least one field");

export type ${m.name}Create = z.infer<typeof ${m.camel}CreateSchema>;
export type ${m.name}Update = z.infer<typeof ${m.camel}UpdateSchema>;
`;
}

function repositoryTs(): string {
  return `${TS_HEADER}
import { randomUUID } from "node:crypto";

export type Stored<T> = T & { id: string; createdAt: string; updatedAt: string };
export type WriteResult<T> = { ok: true; value: Stored<T> } | { ok: false; reason: "not_found" } | { ok: false; reason: "conflict"; field: string };

/**
 * In-memory repository: data lives in this process and is lost on restart. It keeps the API
 * runnable without a database; replace it with a persistent adapter with the same methods.
 */
export class InMemoryRepository<T extends Record<string, unknown>> {
  private readonly rows = new Map<string, Stored<T>>();

  constructor(private readonly uniqueKeys: ReadonlyArray<keyof T & string> = []) {}

  list(opts: { limit?: number; offset?: number } = {}): { data: Stored<T>[]; total: number } {
    const all = [...this.rows.values()];
    const offset = opts.offset ?? 0;
    return { data: all.slice(offset, offset + (opts.limit ?? 100)), total: all.length };
  }

  get(id: string): Stored<T> | undefined {
    return this.rows.get(id);
  }

  create(input: T): WriteResult<T> {
    const clash = this.clash(input);
    if (clash) return { ok: false, reason: "conflict", field: clash };
    const now = new Date().toISOString();
    const value: Stored<T> = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.rows.set(value.id, value);
    return { ok: true, value };
  }

  replace(id: string, input: T): WriteResult<T> {
    return this.write(id, () => input);
  }

  patch(id: string, input: Partial<T>): WriteResult<T> {
    return this.write(id, (current) => ({ ...current, ...input }));
  }

  remove(id: string): boolean {
    return this.rows.delete(id);
  }

  private write(id: string, next: (current: T) => T): WriteResult<T> {
    const existing = this.rows.get(id);
    if (!existing) return { ok: false, reason: "not_found" };
    const { id: _id, createdAt, updatedAt: _u, ...current } = existing;
    const merged = next(current as unknown as T);
    const clash = this.clash(merged, id);
    if (clash) return { ok: false, reason: "conflict", field: clash };
    const value: Stored<T> = { ...merged, id, createdAt, updatedAt: new Date().toISOString() };
    this.rows.set(id, value);
    return { ok: true, value };
  }

  private clash(input: Partial<T>, exceptId?: string): string | null {
    for (const key of this.uniqueKeys) {
      const v = input[key];
      if (v === undefined) continue;
      for (const row of this.rows.values()) if (row.id !== exceptId && row[key] === v) return key;
    }
    return null;
  }
}
`;
}

function routesTs(m: EntityModel, auth: boolean): string {
  const hook = `(res, c) => {\n      if (!res.success) return c.json({ error: "invalid_request", issues: issuesOf(res.error) }, 400);\n    }`;
  const conflict = `function failure(c: Context, r: { reason: "not_found" } | { reason: "conflict"; field: string }) {
  return r.reason === "conflict" ? c.json({ error: "conflict", field: r.field }, 409) : c.json({ error: "not_found" }, 404);
}`;
  const header = auth
    ? `${TS_HEADER}\n// Every route requires a bearer token (API_TOKEN), checked by requireAuthToken().`
    : `// forge:public — the spec defines an API without user accounts (spec.auth = false), so these routes are intentionally public.\n${TS_HEADER}`;
  return `${header}
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { ${m.camel}CreateSchema, ${m.camel}UpdateSchema, type ${m.name}Create } from "../domain/${m.kebab}.js";
${auth ? `import { requireAuthToken } from "../auth.js";\n` : ""}import type { InMemoryRepository } from "../repositories/in-memory.js";
import { issuesOf } from "../validation.js";

const IdParam = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).optional() });

${conflict}

/** CRUD routes for ${m.labelPlural.toLowerCase()}, mounted at /v1/${m.pluralKebab}. */
export function ${m.pluralCamel}Routes(repo: InMemoryRepository<${m.name}Create>${auth ? ", apiToken: string" : ""}): Hono {
  const r = new Hono();
${auth ? `  r.use("*", requireAuthToken(apiToken));\n` : ""}
  r.get(
    "/",
    zValidator("query", ListQuery, ${hook}),
    (c) => c.json(repo.list(c.req.valid("query"))),
  );

  r.get(
    "/:id",
    zValidator("param", IdParam, ${hook}),
    (c) => {
      const item = repo.get(c.req.valid("param").id);
      return item ? c.json(item) : c.json({ error: "not_found" }, 404);
    },
  );

  r.post(
    "/",
    zValidator("json", ${m.camel}CreateSchema, ${hook}),
    (c) => {
      const result = repo.create(c.req.valid("json"));
      return result.ok ? c.json(result.value, 201) : failure(c, result);
    },
  );

  r.put(
    "/:id",
    zValidator("param", IdParam, ${hook}),
    zValidator("json", ${m.camel}CreateSchema, ${hook}),
    (c) => {
      const result = repo.replace(c.req.valid("param").id, c.req.valid("json"));
      return result.ok ? c.json(result.value) : failure(c, result);
    },
  );

  r.patch(
    "/:id",
    zValidator("param", IdParam, ${hook}),
    zValidator("json", ${m.camel}UpdateSchema, ${hook}),
    (c) => {
      const result = repo.patch(c.req.valid("param").id, c.req.valid("json"));
      return result.ok ? c.json(result.value) : failure(c, result);
    },
  );

  r.delete(
    "/:id",
    zValidator("param", IdParam, ${hook}),
    (c) => (repo.remove(c.req.valid("param").id) ? c.body(null, 204) : c.json({ error: "not_found" }, 404)),
  );

  return r;
}
`;
}

function validationTs(): string {
  return `${TS_HEADER}
/** zod issues → a compact, stable error payload ({ path, message }). */
export function issuesOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}
`;
}

function authTs(): string {
  return `${TS_HEADER}
import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Bearer-token check for every /v1 route (constant-time comparison; 401 without a valid token). */
export function requireAuthToken(expected: string): MiddlewareHandler {
  const want = Buffer.from(expected);
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const got = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (!expected || got.length !== want.length || !timingSafeEqual(got, want)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}
`;
}

function openapiTs(ctx: GenerateContext, models: EntityModel[], auth: boolean): string {
  const imports = models.map((m) => `import { ${m.camel}CreateSchema, ${m.camel}UpdateSchema } from "./domain/${m.kebab}.js";`).join("\n");
  const schemas = models.flatMap((m) => [`    ${m.name}Create: jsonSchema(${m.camel}CreateSchema),`, `    ${m.name}Update: jsonSchema(${m.camel}UpdateSchema),`, `    ${m.name}: { allOf: [{ $ref: "#/components/schemas/${m.name}Create" }, { type: "object", properties: { id: { type: "string", format: "uuid" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } }, required: ["id", "createdAt", "updatedAt"] }] },`]);
  const paths = models.map((m) => {
    const ref = (n: string) => `{ $ref: "#/components/schemas/${n}" }`;
    const body = (n: string) => `{ required: true, content: { "application/json": { schema: ${ref(n)} } } }`;
    const ok = (n: string, code = "200") => `"${code}": { description: "OK", content: { "application/json": { schema: ${ref(n)} } } }`;
    const tag = `tags: [${q(m.labelPlural)}]`;
    return `    "/v1/${m.pluralKebab}": {
      get: { ${tag}, summary: ${q(`List ${m.labelPlural.toLowerCase()}`)}, parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } }], responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: ${ref(m.name)} }, total: { type: "integer" } } } } } } } },
      post: { ${tag}, summary: ${q(`Create a ${m.label.toLowerCase()}`)}, requestBody: ${body(`${m.name}Create`)}, responses: { ${ok(m.name, "201")}, "400": invalid, "409": conflict } },
    },
    "/v1/${m.pluralKebab}/{id}": {
      parameters: [idParam],
      get: { ${tag}, summary: ${q(`Get a ${m.label.toLowerCase()}`)}, responses: { ${ok(m.name)}, "404": notFound } },
      put: { ${tag}, summary: ${q(`Replace a ${m.label.toLowerCase()}`)}, requestBody: ${body(`${m.name}Create`)}, responses: { ${ok(m.name)}, "400": invalid, "404": notFound, "409": conflict } },
      patch: { ${tag}, summary: ${q(`Update a ${m.label.toLowerCase()}`)}, requestBody: ${body(`${m.name}Update`)}, responses: { ${ok(m.name)}, "400": invalid, "404": notFound, "409": conflict } },
      delete: { ${tag}, summary: ${q(`Delete a ${m.label.toLowerCase()}`)}, responses: { "204": { description: "Deleted" }, "404": notFound } },
    },`;
  });
  return `${TS_HEADER}
import { z } from "zod";
${imports}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
  return rest;
}

const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const invalid = { description: "Validation failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const notFound = { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const conflict = { description: "A unique field is already used", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };

/** OpenAPI 3.1 description of this API, derived from the same zod schemas that validate requests. */
export function openApiDocument(serviceName: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: serviceName, version: "0.1.0", description: ${q(ctx.spec.summary.slice(0, 300))} },
${auth ? `    security: [{ bearerAuth: [] }],\n` : ""}    paths: {
${paths.join("\n")}
    },
    components: {
${auth ? `      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },\n` : ""}      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, issues: { type: "array", items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } } } }, required: ["error"] },
${schemas.map((s) => `  ${s}`).join("\n")}
      },
    },
  };
}
`;
}

function appTs(models: EntityModel[], auth: boolean): string {
  return `${TS_HEADER}
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./env.js";
import { mountKit } from "./kit/index.js";
import { openApiDocument } from "./openapi.js";
${models.map((m) => `import type { ${m.name}Create } from "./domain/${m.kebab}.js";`).join("\n")}
import { InMemoryRepository } from "./repositories/in-memory.js";
${models.map((m) => `import { ${m.pluralCamel}Routes } from "./routes/${m.pluralKebab}.js";`).join("\n")}

export const SERVICE_NAME = "{{projectSlug}}";

export interface Repositories {
${models.map((m) => `  ${m.pluralCamel}: InMemoryRepository<${m.name}Create>;`).join("\n")}
}

/** Fresh in-memory repositories (one set per app instance; data is not persisted). */
export function createRepositories(): Repositories {
  return {
${models.map((m) => `    ${m.pluralCamel}: new InMemoryRepository<${m.name}Create>([${uniqueFields(m).map((f) => q(f.name)).join(", ")}]),`).join("\n")}
  };
}

export function createApp(env: Pick<Env, "CORS_ORIGINS" | "BODY_LIMIT_BYTES" | "NODE_ENV"${auth ? ` | "API_TOKEN"` : ""}>, repos: Repositories = createRepositories()): Hono {
  const app = new Hono();
  const origins = env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

  if (env.NODE_ENV !== "test") app.use(logger());
  app.use(secureHeaders());
  app.use(bodyLimit({ maxSize: env.BODY_LIMIT_BYTES }));
  if (origins.length > 0) app.use("/v1/*", cors({ origin: origins, credentials: true }));

  // App-kit features (auth, payments, cron, observability middleware ...) mount before app routes.
  mountKit(app);

  app.get("/health", (c) => c.json({ status: "ok", service: SERVICE_NAME, uptimeSec: Math.round(process.uptime()) }));

  // forge:public — machine-readable API documentation (no data).
  app.get("/openapi.json", (c) => c.json(openApiDocument(SERVICE_NAME)));

${models.map((m) => `  app.route("/v1/${m.pluralKebab}", ${m.pluralCamel}Routes(repos.${m.pluralCamel}${auth ? ", env.API_TOKEN" : ""}));`).join("\n")}

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
`;
}

function envTs(): string {
  return `${TS_HEADER}
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Comma-separated list of allowed browser origins. Empty = same-origin only. */
  CORS_ORIGINS: z.string().default(""),
  /** Maximum request body size in bytes. */
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_000_000),
  /** Bearer token API clients must send (Authorization: Bearer <token>). At least 32 characters. */
  API_TOKEN: z.string().min(32, "API_TOKEN must be at least 32 characters"),
});

export type Env = z.infer<typeof EnvSchema>;

/** Validated process environment. Throws with a readable message on bad config. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(\`Invalid environment: \${parsed.error.issues.map((i) => \`\${i.path.join(".")}: \${i.message}\`).join("; ")}\`);
  }
  return parsed.data;
}
`;
}

function appTest(models: EntityModel[], auth: boolean): string {
  const env = auth ? `{ NODE_ENV: "test", API_TOKEN: TOKEN }` : `{ NODE_ENV: "test" }`;
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

${auth ? `const TOKEN = "t".repeat(40);\n` : ""}const app = createApp(loadEnv(${env}));

describe("api", () => {
  it("reports health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves an OpenAPI document for every resource", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
${models.map((m) => `    expect(Object.keys(doc.paths)).toContain("/v1/${m.pluralKebab}/{id}");`).join("\n")}
  });

  it("returns JSON 404s", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });

  it("rejects invalid configuration", () => {
    expect(() => loadEnv({ PORT: "not-a-port" })).toThrow(/PORT/);
  });
${
  auth
    ? `
  it("requires the API token", async () => {
${models.map((m) => `    expect((await app.request("/v1/${m.pluralKebab}")).status).toBe(401);`).join("\n")}
  });
`
    : ""
}});
`;
}

function entityTest(m: EntityModel, auth: boolean): string {
  const valid = `{ ${m.fields.map((f) => `${f.name}: ${sampleFor(f, "json")}`).join(", ")} }`;
  const other = `{ ${m.fields.map((f) => `${f.name}: ${sampleFor(f, "json", 2)}`).join(", ")} }`;
  const invalids = m.fields
    .map((f) => ({ f, v: invalidFor(f) }))
    .filter((x) => x.v !== null)
    .slice(0, 4)
    .map(({ f, v }) => `    expect((await send("POST", base, { ...valid, ${f.name}: ${v} })).status).toBe(400);`)
    .join("\n");
  const firstField = m.fields[0];
  const missing = m.fields.find((f) => f.required && f.type !== "boolean");
  const uniq = uniqueFields(m)[0];
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

${auth ? `const TOKEN = "t".repeat(40);\n` : ""}const base = "/v1/${m.pluralKebab}";
const valid = ${valid};

function setup() {
  const app = createApp(loadEnv(${auth ? `{ NODE_ENV: "test", API_TOKEN: TOKEN }` : `{ NODE_ENV: "test" }`}));
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json"${auth ? ", authorization: `Bearer ${TOKEN}`" : ""} }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, send };
}

describe("${m.labelPlural.toLowerCase()} API", () => {
  it("creates, reads, updates and deletes a ${m.label.toLowerCase()}", async () => {
    const { send } = setup();
    const created = await send("POST", base, valid);
    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string };
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);

    expect((await send("GET", \`\${base}/\${item.id}\`)).status).toBe(200);
    const list = (await (await send("GET", base)).json()) as { data: unknown[]; total: number };
    expect(list.total).toBe(1);

    expect((await send("PUT", \`\${base}/\${item.id}\`, ${other})).status).toBe(200);
${firstField ? `    const patched = await send("PATCH", \`\${base}/\${item.id}\`, { ${firstField.name}: ${sampleFor(firstField, "json", 3)} });\n    expect(patched.status).toBe(200);\n    expect(((await patched.json()) as Record<string, unknown>).${firstField.name}).toEqual(${sampleFor(firstField, "json", 3)});\n` : ""}
    expect((await send("DELETE", \`\${base}/\${item.id}\`)).status).toBe(204);
    expect((await send("GET", \`\${base}/\${item.id}\`)).status).toBe(404);
  });

  it("rejects invalid bodies with 400 and field issues", async () => {
    const { send } = setup();
${invalids}
${missing ? `    const res = await send("POST", base, { ...valid, ${missing.name}: undefined });\n    expect(res.status).toBe(400);\n    const body = (await res.json()) as { error: string; issues: Array<{ path: string }> };\n    expect(body.error).toBe("invalid_request");\n    expect(body.issues.map((i) => i.path)).toContain(${q(missing.name)});\n` : ""}    expect((await send("POST", base, { ...valid, unexpected: true })).status).toBe(400);
    expect((await send("PATCH", \`\${base}/00000000-0000-4000-8000-000000000000\`, {})).status).toBe(400);
    expect((await send("GET", \`\${base}/not-a-uuid\`)).status).toBe(400);
    expect((await send("GET", \`\${base}?limit=0\`)).status).toBe(400);
  });

  it("returns 404 for unknown ids", async () => {
    const { send } = setup();
    expect((await send("PUT", \`\${base}/00000000-0000-4000-8000-000000000000\`, valid)).status).toBe(404);
    expect((await send("DELETE", \`\${base}/00000000-0000-4000-8000-000000000000\`)).status).toBe(404);
  });
${
  uniq
    ? `
  it("keeps ${uniq.label.toLowerCase()} unique (409)", async () => {
    const { send } = setup();
    expect((await send("POST", base, valid)).status).toBe(201);
    const dup = await send("POST", base, valid);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "conflict", field: ${q(uniq.name)} });
  });
`
    : ""
}});
`;
}

export function generateHono(ctx: GenerateContext): GeneratedProject {
  const out = emptyProject("hono-api");
  const models = entityModels(ctx.spec);
  const auth = ctx.spec.auth;
  const f = out.files;
  f["src/validation.ts"] = validationTs();
  f["src/repositories/in-memory.ts"] = repositoryTs();
  for (const m of models) {
    f[`src/domain/${m.kebab}.ts`] = domainTs(m, models);
    f[`src/routes/${m.pluralKebab}.ts`] = routesTs(m, auth);
    f[`test/${m.pluralKebab}.test.ts`] = entityTest(m, auth);
  }
  f["src/openapi.ts"] = openapiTs(ctx, models, auth);
  f["src/app.ts"] = appTs(models, auth).replace("{{projectSlug}}", ctx.spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "api");
  f["test/app.test.ts"] = appTest(models, auth);
  if (auth) {
    f["src/auth.ts"] = authTs();
    f["src/env.ts"] = envTs();
  }
  out.verify.push("npm run typecheck", "npm run lint");
  out.autofix = "npx eslint . --fix";
  out.notes.push(
    "Data is kept by InMemoryRepository (src/repositories/in-memory.ts): it lives in the server process and is lost on restart; swap in a database adapter with the same methods for production.",
    "OpenAPI 3.1 is served at /openapi.json, generated from the same zod schemas that validate requests.",
    auth ? "All /v1 routes require `Authorization: Bearer $API_TOKEN`." : "The spec has no user accounts, so the /v1 routes are marked `forge:public` (intentionally unauthenticated).",
  );
  return out;
}
