import type { ApiOperation, ImportedApi } from "./model.js";
import { isObj } from "./refs.js";

type Obj = Record<string, unknown>;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(["break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "implements", "interface", "package", "private", "protected", "public", "await", "any", "unknown", "never", "string", "number", "boolean", "object", "symbol", "bigint", "undefined"]);

export function pascal(s: string): string {
  const out = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  const safe = /^[0-9]/.test(out) ? `T${out}` : out || "Type";
  return RESERVED.has(safe.toLowerCase()) ? `${safe}Type` : safe;
}

function key(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

function access(obj: string, k: string): string {
  return IDENT.test(k) ? `${obj}.${k}` : `${obj}[${JSON.stringify(k)}]`;
}

function lit(v: unknown): string {
  return v === null ? "null" : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? JSON.stringify(v) : "unknown";
}

function docComment(text: unknown, indent: string): string {
  if (typeof text !== "string" || !text.trim()) return "";
  return `${indent}/** ${text.replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim().slice(0, 300)} */\n`;
}

class TypeWriter {
  constructor(private readonly names: Map<string, string>) {}

  ts(schema: unknown, indent = "", depth = 0): string {
    if (!isObj(schema) || depth > 20) return "unknown";
    const s = schema as Obj;
    let t: string;
    if (typeof s.$ref === "string") {
      const m = /^#\/components\/schemas\/(.+)$/.exec(s.$ref);
      t = (m && this.names.get(decodeURIComponent(m[1]!).replace(/~1/g, "/").replace(/~0/g, "~"))) ?? "unknown";
    } else if ("const" in s) t = lit(s.const);
    else if (Array.isArray(s.enum)) t = s.enum.length ? s.enum.map(lit).join(" | ") : "never";
    else if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) t = ((s.oneOf ?? s.anyOf) as unknown[]).map((x) => this.wrap(this.ts(x, indent, depth + 1))).join(" | ") || "unknown";
    else if (Array.isArray(s.allOf)) t = s.allOf.map((x) => this.wrap(this.ts(x, indent, depth + 1))).join(" & ") || "unknown";
    else {
      const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === "string" ? [s.type] : isObj(s.properties) ? ["object"] : isObj(s.items) ? ["array"] : [];
      t = types.length ? types.map((ty) => this.one(ty, s, indent, depth)).join(" | ") : "unknown";
    }
    if (s.nullable === true && t !== "unknown") t = `${this.wrap(t)} | null`;
    return t;
  }

  private wrap(t: string): string {
    return /[|&]/.test(t) && !/^\{[\s\S]*\}$/.test(t) ? `(${t})` : t;
  }

  private one(ty: string, s: Obj, indent: string, depth: number): string {
    switch (ty) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return `Array<${this.ts(s.items, indent, depth + 1)}>`;
      case "object":
        return this.object(s, indent, depth);
      default:
        return "unknown";
    }
  }

  private object(s: Obj, indent: string, depth: number): string {
    const props = isObj(s.properties) ? s.properties : {};
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const entries = Object.entries(props);
    const extra = s.additionalProperties;
    if (!entries.length) return isObj(extra) ? `Record<string, ${this.ts(extra, indent, depth + 1)}>` : "Record<string, unknown>";
    const inner = `${indent}  `;
    const lines = entries.map(([k, v]) => `${docComment(isObj(v) ? v.description : undefined, inner)}${inner}${key(k)}${req.has(k) ? "" : "?"}: ${this.ts(v, inner, depth + 1)};`);
    if (extra === true || isObj(extra)) lines.push(`${inner}[key: string]: unknown;`);
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
}

function inputTypeFor(op: ApiOperation, w: TypeWriter): { decl: string; optional: boolean } {
  const lines: string[] = [];
  for (const p of op.parameters) lines.push(`${docComment(p.description, "  ")}  ${key(p.name)}${p.required ? "" : "?"}: ${w.ts(p.schema, "  ")};`);
  if (op.requestBody) lines.push(`  body${op.requestBody.required ? "" : "?"}: ${w.ts(op.requestBody.schema, "  ")};`);
  const optional = !op.parameters.some((p) => p.required) && !op.requestBody?.required;
  return { decl: lines.length ? `{\n${lines.join("\n")}\n}` : "Record<string, never>", optional };
}

/**
 * Generate a dependency-free, strictly typed fetch client (TypeScript source) for generated apps.
 * Interfaces for components/schemas, one Input type and one method per operation. Credentials are passed
 * at construction time and must stay server-side (env/vault), never in browser bundles.
 */
export function generateTypedClient(api: ImportedApi, opts: { className?: string } = {}): string {
  const names = new Map<string, string>();
  const taken = new Set<string>(["ApiError", "ClientAuth", "ClientOptions", "RequestOptions"]);
  for (const n of Object.keys(api.schemas)) {
    let name = pascal(n);
    for (let i = 2; taken.has(name); i++) name = `${pascal(n)}${i}`;
    taken.add(name);
    names.set(n, name);
  }
  const w = new TypeWriter(names);
  const out: string[] = [];
  out.push(`/* eslint-disable */`);
  out.push(`// Generated by Forge from OpenAPI "${api.title.replace(/[\r\n]/g, " ")}" ${api.version} (${api.source}). Do not edit by hand.`);
  out.push(`// Keep credentials server-side: construct this client in server code with secrets from env/vault.`);
  out.push("");
  out.push(`export type ClientAuth =
  | { type: "none" }
  | { type: "apiKey"; in: "header" | "query"; name: string; value: string }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "oauth2"; accessToken: string };

export interface ClientOptions {
  baseUrl?: string;
  auth?: ClientAuth;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? \`HTTP \${status}\`);
    this.name = "ApiError";
  }
}
`);
  for (const [raw, name] of names) {
    const schema = api.schemas[raw];
    out.push(`${docComment(isObj(schema) ? schema.description : undefined, "")}export type ${name} = ${w.ts(schema)};\n`);
  }
  const methods: string[] = [];
  const usedMethods = new Set<string>();
  for (const op of api.operations) {
    let m = op.id;
    if (RESERVED.has(m) || !IDENT.test(m)) m = `${m.replace(/[^A-Za-z0-9_$]/g, "_")}Op`;
    for (let i = 2; usedMethods.has(m); i++) m = `${op.id}${i}`;
    usedMethods.add(m);
    const inName = `${pascal(op.id)}Input`;
    const outName = `${pascal(op.id)}Output`;
    const input = inputTypeFor(op, w);
    out.push(`export type ${inName} = ${input.decl};`);
    out.push(`export type ${outName} = ${op.responseSchema ? w.ts(op.responseSchema) : "unknown"};\n`);
    const path = op.path.replace(/\{([^}]+)\}/g, (_m, p: string) => `\${encodeURIComponent(String(${access("input", p)}))}`);
    const q = op.parameters.filter((p) => p.in === "query").map((p) => `${JSON.stringify(p.name)}: ${access("input", p.name)}`);
    const h = op.parameters.filter((p) => p.in === "header").map((p) => `${JSON.stringify(p.name.toLowerCase())}: ${access("input", p.name)} === undefined ? undefined : String(${access("input", p.name)})`);
    const body = op.requestBody ? "input.body" : "undefined";
    const ct = op.requestBody ? JSON.stringify(op.requestBody.contentType) : "undefined";
    const usesInput = op.parameters.length > 0 || !!op.requestBody;
    const param = `${usesInput ? "input" : "_input"}: ${inName}${input.optional ? ` = {} as ${inName}` : ""}`;
    methods.push(
      `${docComment(`${op.method.toUpperCase()} ${op.path}${op.summary ? ` - ${op.summary}` : ""}`, "    ")}    ${m}(${param}, init?: RequestOptions): Promise<${outName}> {
      return request<${outName}>(${JSON.stringify(op.method.toUpperCase())}, \`${path}\`, { ${q.join(", ")} }, { ${h.join(", ")} }, ${body}, ${ct}, init);
    },`,
    );
  }
  out.push(`export function ${opts.className ? `create${pascal(opts.className)}` : "createClient"}(options: ClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? ${JSON.stringify(api.baseUrl)}).replace(/\\/$/, "");
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(
    method: string,
    path: string,
    query: Record<string, unknown>,
    headers: Record<string, string | undefined>,
    body: unknown,
    contentType: string | undefined,
    init?: RequestOptions,
  ): Promise<T> {
    if (!baseUrl) throw new Error("baseUrl is required (the spec has no server URL)");
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
      else url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const h: Record<string, string> = { accept: "application/json", ...(options.headers ?? {}), ...(init?.headers ?? {}) };
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const auth = options.auth ?? { type: "none" };
    if (auth.type === "apiKey") {
      if (auth.in === "query") url.searchParams.set(auth.name, auth.value);
      else h[auth.name.toLowerCase()] = auth.value;
    } else if (auth.type === "bearer") h.authorization = \`Bearer \${auth.token}\`;
    else if (auth.type === "oauth2") h.authorization = \`Bearer \${auth.accessToken}\`;
    else if (auth.type === "basic") h.authorization = \`Basic \${btoa(\`\${auth.username}:\${auth.password}\`)}\`;
    let payload: string | URLSearchParams | undefined;
    if (body !== undefined) {
      if (contentType === "application/x-www-form-urlencoded") {
        payload = new URLSearchParams(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      } else {
        h["content-type"] = contentType ?? "application/json";
        payload = contentType === undefined || contentType.includes("json") ? JSON.stringify(body) : String(body);
      }
    }
    const reqInit: RequestInit = { method, headers: h };
    if (payload !== undefined) reqInit.body = payload;
    if (init?.signal) reqInit.signal = init.signal;
    const res = await fetchImpl(url, reqInit);
    const text = await res.text();
    let data: unknown = text;
    if (text && (res.headers.get("content-type") ?? "").includes("json")) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  }

  return {
${methods.join("\n")}
  };
}

export type ${opts.className ? pascal(opts.className) : "Client"} = ReturnType<typeof ${opts.className ? `create${pascal(opts.className)}` : "createClient"}>;
`);
  return out.join("\n");
}
