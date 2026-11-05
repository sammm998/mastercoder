import { generateTypedClient, type ApiOperation, type ImportedApi } from "@forge/integrations";
import { HEADER, TS_HEADER, camel, kebab, label, pascal, q, snake } from "./names.js";

/**
 * OpenAPI integration for Next.js apps: the typed client from @forge/integrations'
 * generateTypedClient, a server-side wrapper that reads the API key from the environment, one
 * validated GET route per read operation (the browser never sees the key), an explorer component and
 * tests with a stubbed fetch.
 */

type Obj = Record<string, unknown>;

export interface IntegrationOutput {
  files: Record<string, string>;
  setup: string[];
  notes: string[];
  /** Import line + JSX for embedding the explorer on a page. */
  explorer: { importLine: string; jsx: string };
  slug: string;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

let schemas: Record<string, unknown> = {};

function simpleSchema(s: unknown, depth = 0): Obj | null {
  if (!s || typeof s !== "object" || depth > 5) return null;
  const o = s as Obj;
  if (typeof o.$ref === "string") {
    const m = /^#\/components\/schemas\/(.+)$/.exec(o.$ref);
    return m ? simpleSchema(schemas[decodeURIComponent(m[1]!)], depth + 1) : null;
  }
  if (Array.isArray(o.enum) && o.enum.every((v) => typeof v === "string")) return o;
  return ["string", "integer", "number", "boolean"].includes(String(o.type)) ? o : null;
}

/** Read-only operations a page can call with simple query/path parameters (max 4). */
export function readOperations(api: ImportedApi): ApiOperation[] {
  schemas = api.schemas;
  return api.operations
    .filter((op) => op.method === "get" && !op.deprecated && op.parameters.every((p) => (p.in === "query" || p.in === "path") && IDENT.test(p.name) && simpleSchema(p.schema)))
    .slice(0, 4);
}

function zodForParam(schema: Obj, required: boolean): string {
  let e: string;
  if (Array.isArray(schema.enum)) e = `z.enum([${(schema.enum as string[]).map(q).join(", ")}])`;
  else if (schema.type === "integer" || schema.type === "number") {
    e = `z.coerce.number()${schema.type === "integer" ? ".int()" : ""}${typeof schema.minimum === "number" ? `.min(${schema.minimum})` : ""}${typeof schema.maximum === "number" ? `.max(${schema.maximum})` : ""}`;
  } else if (schema.type === "boolean") e = `z.enum(["true", "false"]).transform((v) => v === "true")`;
  else e = `z.string().trim()${typeof schema.minLength === "number" ? `.min(${schema.minLength})` : required ? ".min(1)" : ""}.max(${typeof schema.maxLength === "number" ? schema.maxLength : 500})`;
  return required ? e : `${e}.optional()`;
}

function sampleParam(schema: Obj): string {
  if (Array.isArray(schema.enum)) return String(schema.enum[0]);
  if (schema.type === "integer" || schema.type === "number") return String(typeof schema.minimum === "number" ? schema.minimum : 1);
  if (schema.type === "boolean") return "true";
  return "Stockholm";
}

export function apiSlug(api: ImportedApi): string {
  return kebab(api.title.replace(/\b(api|rest|service|openapi)\b/gi, " ").trim()) || "api";
}

function authExpr(api: ImportedApi, op: ApiOperation | undefined, envName: string): { code: string; kind: string } {
  const name = op?.security[0] ? Object.keys(op.security[0])[0] : Object.keys(api.securitySchemes)[0];
  const s = name ? api.securitySchemes[name] : undefined;
  if (s?.type === "apiKey" && (s.in === "header" || s.in === "query")) return { code: `{ type: "apiKey", in: ${q(s.in)}, name: ${q(s.name)}, value: key }`, kind: `API key in ${s.in} ${s.name}` };
  if (s?.type === "http" && s.scheme.toLowerCase() === "bearer") return { code: `{ type: "bearer", token: key }`, kind: "bearer token" };
  if (s?.type === "oauth2") return { code: `{ type: "oauth2", accessToken: key }`, kind: "OAuth2 access token" };
  return { code: `{ type: "none" }`, kind: `no credentials (${envName} unused)` };
}

export function generateIntegration(api: ImportedApi, opts: { auth: boolean }): IntegrationOutput {
  const slug = apiSlug(api);
  const S = pascal(slug);
  const s = camel(slug);
  const envKey = `${snake(slug).toUpperCase()}_API_KEY`;
  const envBase = `${snake(slug).toUpperCase()}_BASE_URL`;
  const ops = readOperations(api);
  const auth = authExpr(api, ops[0], envKey);
  const needsKey = !auth.code.includes(`"none"`);
  const files: Record<string, string> = {};
  const client = generateTypedClient(api, { className: `${S}Api` });
  files[`src/lib/integrations/${slug}-client.ts`] = `// ${HEADER}: typed client produced by @forge/integrations generateTypedClient.\n${client}`;

  const querySchemas = ops
    .map((op) => {
      const fields = op.parameters.map((p) => `  ${p.name}: ${zodForParam(simpleSchema(p.schema)!, p.required)},`).join("\n");
      return `/** Query of ${op.method.toUpperCase()} ${op.path}${op.summary ? ` (${op.summary})` : ""}. */\nexport const ${op.id}Query = z.object({\n${fields}\n});`;
    })
    .join("\n\n");
  files[`src/lib/integrations/${slug}.ts`] = `${TS_HEADER}
// Server-side only: reads ${envKey} from the environment. Never import this from a "use client" file.
import { z } from "zod";
import { ApiError, create${S}Api } from "./${slug}-client";

export { ApiError };

${querySchemas}

export class NotConfiguredError extends Error {
  constructor() {
    super(${q(`${envKey} is not set`)});
    this.name = "NotConfiguredError";
  }
}

/** ${api.title} client with credentials from the environment (${auth.kind}). */
export function ${s}Client(opts: { apiKey?: string; baseUrl?: string; fetch?: typeof fetch } = {}) {
${needsKey ? `  const key = opts.apiKey ?? process.env.${envKey};\n  if (!key) throw new NotConfiguredError();\n` : ""}  return create${S}Api({ baseUrl: opts.baseUrl ?? process.env.${envBase} ?? undefined, auth: ${auth.code}, fetch: opts.fetch });
}
`;

  for (const op of ops) {
    const route = `src/app/api/integrations/${slug}/${kebab(op.id)}/route.ts`;
    files[route] = `${opts.auth ? "" : `// forge:public — the app has no accounts (spec.auth = false); this read-only proxy keeps the API key server-side.\n`}${TS_HEADER}
import type { NextRequest } from "next/server";
${opts.auth ? `import { getSession } from "@/lib/session";\n` : ""}import { ApiError, NotConfiguredError, ${op.id}Query, ${s}Client } from "@/lib/integrations/${slug}";

export const dynamic = "force-dynamic";

/** ${op.method.toUpperCase()} ${op.path} via the server (validated query, key from the environment). */
export async function GET(request: NextRequest) {
${opts.auth ? `  const session = await getSession();\n  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });\n` : ""}  const parsed = ${op.id}Query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) }, { status: 400 });
  }
  try {
    const client = ${s}Client();
    return Response.json(await client.${op.id}(parsed.data as Parameters<typeof client.${op.id}>[0]));
  } catch (error) {
    if (error instanceof NotConfiguredError) return Response.json({ error: "not_configured", message: "The ${api.title.replace(/"/g, "")} integration is not configured yet." }, { status: 503 });
    if (error instanceof ApiError) {
      const notFound = error.status === 404;
      return Response.json({ error: notFound ? "not_found" : "upstream_error", message: notFound ? "Nothing found for that request." : "The service did not answer as expected. Try again later.", status: error.status }, { status: notFound ? 404 : 502 });
    }
    return Response.json({ error: "upstream_unreachable", message: "The service could not be reached. Try again later." }, { status: 502 });
  }
}
`;
  }

  const opDefs = ops
    .map(
      (op) => `  {
    id: ${q(op.id)},
    title: ${q(op.summary ?? label(op.id))},
    path: ${q(`/api/integrations/${slug}/${kebab(op.id)}`)},
    params: [
${op.parameters
  .map((p) => {
    const sc = simpleSchema(p.schema)!;
    return `      { name: ${q(p.name)}, label: ${q(label(p.name))}, required: ${p.required}${p.description ? `, hint: ${q(p.description.slice(0, 160))}` : ""}${Array.isArray(sc.enum) ? `, options: [${(sc.enum as string[]).map(q).join(", ")}]` : ""}${sc.type === "integer" || sc.type === "number" ? `, numeric: true` : ""} },`;
  })
  .join("\n")}
    ],
  },`,
    )
    .join("\n");
  files[`src/components/${slug}-explorer.tsx`] = `"use client";
${TS_HEADER}
import { useState, type FormEvent } from "react";

interface Param {
  name: string;
  label: string;
  required: boolean;
  hint?: string;
  options?: string[];
  numeric?: boolean;
}

const OPERATIONS: Array<{ id: string; title: string; path: string; params: Param[] }> = [
${opDefs}
];

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <>—</>;
  if (typeof value === "object") return <pre>{JSON.stringify(value, null, 2)}</pre>;
  return <>{String(value)}</>;
}

function Result({ data }: { data: unknown }) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return <Value value={data} />;
  return (
    <dl>
      {Object.entries(data as Record<string, unknown>).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            <Value value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Operation({ op }: { op: (typeof OPERATIONS)[number] }) {
  const [state, setState] = useState<{ kind: "idle" | "busy" | "error" | "done"; message?: string; data?: unknown }>({ kind: "idle" });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(e.currentTarget)) if (typeof v === "string" && v.trim()) params.set(k, v.trim());
    setState({ kind: "busy" });
    try {
      const res = await fetch(\`\${op.path}?\${params}\`);
      const body = (await res.json()) as { message?: string; error?: string; issues?: Array<{ path: string; message: string }> };
      if (!res.ok) {
        const detail = body.issues?.map((i) => \`\${i.path}: \${i.message}\`).join("; ");
        setState({ kind: "error", message: detail || body.message || "Something went wrong. Try again." });
      } else setState({ kind: "done", data: body });
    } catch {
      setState({ kind: "error", message: "Network error. Check your connection and try again." });
    }
  }

  return (
    <section className="card" aria-labelledby={\`\${op.id}-heading\`}>
      <h2 id={\`\${op.id}-heading\`}>{op.title}</h2>
      <form onSubmit={onSubmit} noValidate>
        {op.params.map((p) => (
          <div className="field" key={p.name}>
            <label htmlFor={\`\${op.id}-\${p.name}\`}>
              {p.label}
              {p.required ? <span aria-hidden="true"> *</span> : null}
            </label>
            {p.options ? (
              <select id={\`\${op.id}-\${p.name}\`} name={p.name} defaultValue="" aria-describedby={p.hint ? \`\${op.id}-\${p.name}-hint\` : undefined}>
                <option value="">Default</option>
                {p.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input id={\`\${op.id}-\${p.name}\`} name={p.name} inputMode={p.numeric ? "numeric" : undefined} required={p.required} aria-describedby={p.hint ? \`\${op.id}-\${p.name}-hint\` : undefined} />
            )}
            {p.hint ? (
              <p id={\`\${op.id}-\${p.name}-hint\`} className="field-hint">
                {p.hint}
              </p>
            ) : null}
          </div>
        ))}
        <button className="button" type="submit" disabled={state.kind === "busy"}>
          {state.kind === "busy" ? "Loading…" : "Show"}
        </button>
      </form>
      <div role="status" aria-live="polite">
        {state.kind === "error" ? <p className="form-status-error">{state.message}</p> : null}
        {state.kind === "done" ? <Result data={state.data} /> : null}
      </div>
    </section>
  );
}

/** Calls ${api.title.replace(/[*/]/g, "")} through this app's server routes (the API key never reaches the browser). */
export function ${S}Explorer() {
  return (
    <>
      {OPERATIONS.map((op) => (
        <Operation key={op.id} op={op} />
      ))}
    </>
  );
}
`;

  const first = ops[0];
  const reqParams = first?.parameters.filter((p) => p.required) ?? [];
  const sampleInput = first ? `{ ${first.parameters.filter((p) => p.required).map((p) => `${p.name}: ${q(sampleParam(simpleSchema(p.schema)!))}`).join(", ")} }` : "{}";
  files[`test/${slug}-integration.test.ts`] = `${TS_HEADER}
import { describe, expect, it, vi } from "vitest";
import { ${first ? `${first.id}Query, ` : ""}NotConfiguredError, ${s}Client } from "@/lib/integrations/${slug}";

describe("${api.title.replace(/"/g, "")} integration", () => {
${
  first
    ? `  it("validates the query before calling the API", () => {
    expect(${first.id}Query.safeParse(${sampleInput}).success).toBe(true);
${reqParams.length ? `    expect(${first.id}Query.safeParse({}).success).toBe(false);\n` : ""}  });

  it("calls the API server-side with the configured credentials", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
    const client = ${s}Client({ apiKey: "test-key", baseUrl: "https://api.example.test", fetch: fetchStub });
    expect(await client.${first.id}(${first.id}Query.parse(${sampleInput}) as Parameters<typeof client.${first.id}>[0])).toEqual({ ok: true });
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(String(url)).toContain(${q(`https://api.example.test${first.path.replace(/\{[^}]+\}/g, "")}`.replace(/\/$/, ""))});
${auth.code.includes("apiKey") && auth.code.includes('"header"') ? `    expect((init?.headers as Record<string, string>)[${q((auth.code.match(/name: "([^"]+)"/)?.[1] ?? "").toLowerCase())}]).toBe("test-key");\n` : auth.code.includes("bearer") ? `    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");\n` : ""}  });
`
    : ""
}${
  needsKey
    ? `
  it("refuses to run without a key", () => {
    vi.stubEnv(${q(envKey)}, "");
    expect(() => ${s}Client()).toThrow(NotConfiguredError);
    vi.unstubAllEnvs();
  });
`
    : ""
}});
`;

  const setup = needsKey ? [`grep -q '^${envKey}=' .env.example 2>/dev/null || printf '\\n# ${api.title.replace(/'/g, "")} (server-side only, secret)\\n${envKey}=\\n${envBase}=\\n' >> .env.example`] : [];
  return {
    files,
    setup,
    slug,
    notes: [
      `${api.title}: typed client generated from the OpenAPI document (${ops.length} read operation(s) exposed through server routes under /api/integrations/${slug}/). ${needsKey ? `Set ${envKey} (secret, server-side) to call the real API; without it the routes answer 503 "not configured".` : ""}`.trim(),
    ],
    explorer: { importLine: `import { ${S}Explorer } from "@/components/${slug}-explorer";`, jsx: `<${S}Explorer />` },
  };
}
