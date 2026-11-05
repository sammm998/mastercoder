import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ForgeError, type UsageSink } from "@forge/shared";
import type { JsonSchema, LLMProvider } from "@forge/llm";
import { safeFetch, type UrlPolicy } from "../ssrf.js";
import { HTTP_METHODS, type ApiOperation, type ApiParameter, type ApiSource, type ImportedApi, type SecurityScheme } from "./model.js";
import { deref, follow, isObj } from "./refs.js";
import { swagger2ToOpenApi3 } from "./swagger2.js";
import { docsToOpenApi, looksLikeHtml } from "./docs.js";

type Obj = Record<string, unknown>;

export interface ImportOptions extends UrlPolicy {
  /** When given, HTML/text API docs are converted via LLM purpose "integrations.docs_to_openapi"; otherwise the heuristic is used. */
  llm?: LLMProvider;
  usage?: UsageSink;
  /** Allow `source` to be a local file path (CLI/benchmarks only; never for user input on the server). */
  allowLocalFiles?: boolean;
  /** Override / supply the base URL (e.g. spec without servers). */
  baseUrl?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

const IRREVERSIBLE_VERBS = /(^|[^a-z])(send|pay|charge|refund|transfer|payout|delete|remove|destroy|purge|cancel|publish|post_message|notify|email|sms)([^a-z]|$)/i;

function camel(s: string): string {
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const out = parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join("");
  return /^[0-9]/.test(out) ? `op${out}` : out || "operation";
}

function opIdFor(method: string, path: string, operationId: unknown): string {
  if (typeof operationId === "string" && operationId.trim()) return camel(operationId);
  const segs = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (/^\{.+\}$/.test(seg) ? `by ${seg.slice(1, -1)}` : seg));
  return camel(`${method} ${segs.join(" ")}`);
}

function pickContent(content: unknown): { contentType: string; schema: JsonSchema } | undefined {
  if (!isObj(content)) return undefined;
  const types = Object.keys(content);
  const ct = types.find((t) => /json/i.test(t)) ?? types.find((t) => t === "application/x-www-form-urlencoded") ?? types.find((t) => t === "multipart/form-data") ?? types[0];
  if (!ct) return undefined;
  const media = content[ct];
  return { contentType: ct, schema: (isObj(media) && isObj(media.schema) ? media.schema : {}) as JsonSchema };
}

function buildApi(document: Obj, source: ApiSource, baseOverride?: string): ImportedApi {
  const info = isObj(document.info) ? document.info : {};
  const servers = (Array.isArray(document.servers) ? document.servers : [])
    .filter(isObj)
    .map((s) => {
      let url = String(s.url ?? "");
      if (isObj(s.variables)) for (const [k, v] of Object.entries(s.variables)) url = url.replace(`{${k}}`, String(isObj(v) ? (v.default ?? "") : ""));
      return url;
    })
    .filter(Boolean);
  const globalSecurity = Array.isArray(document.security) ? (document.security as Array<Record<string, string[]>>) : [];
  const ops: ApiOperation[] = [];
  const used = new Set<string>();
  for (const [path, rawItem] of Object.entries(isObj(document.paths) ? document.paths : {})) {
    const item = follow(document, rawItem);
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const byKey = new Map<string, ApiParameter>();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = follow(document, raw);
        if (!isObj(p) || typeof p.name !== "string" || !["path", "query", "header", "cookie"].includes(String(p.in))) continue;
        let schema = (isObj(p.schema) ? p.schema : isObj(p.content) ? (pickContent(p.content)?.schema ?? {}) : {}) as JsonSchema;
        if (!isObj(p.schema) && typeof p.type === "string") schema = { type: p.type };
        byKey.set(`${String(p.in)}:${p.name}`, {
          name: p.name,
          in: p.in as ApiParameter["in"],
          required: p.in === "path" ? true : p.required === true,
          ...(typeof p.description === "string" ? { description: p.description } : {}),
          schema,
        });
      }
      const rb = follow(document, op.requestBody);
      const body = isObj(rb) ? pickContent(rb.content) : undefined;
      const responses = isObj(op.responses) ? op.responses : {};
      const okCode = Object.keys(responses).find((c) => /^2\d\d$/.test(c)) ?? (responses.default ? "default" : undefined);
      const okRes = okCode ? follow(document, responses[okCode]) : undefined;
      const resBody = isObj(okRes) ? pickContent(okRes.content) : undefined;
      let id = opIdFor(method, path, op.operationId);
      for (let n = 2; used.has(id); n++) id = `${opIdFor(method, path, op.operationId)}${n}`;
      used.add(id);
      const words = `${String(op.operationId ?? "")} ${String(op.summary ?? "")}`;
      ops.push({
        id,
        method,
        path,
        ...(typeof op.summary === "string" ? { summary: op.summary } : {}),
        ...(typeof op.description === "string" ? { description: op.description } : {}),
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        parameters: [...byKey.values()],
        ...(body ? { requestBody: { contentType: body.contentType, required: isObj(rb) && rb.required === true, schema: body.schema } } : {}),
        ...(resBody ? { responseSchema: resBody.schema, responseContentType: resBody.contentType } : {}),
        security: Array.isArray(op.security) ? (op.security as Array<Record<string, string[]>>) : globalSecurity,
        irreversible: method === "delete" || (method !== "get" && method !== "head" && IRREVERSIBLE_VERBS.test(words)) || op["x-irreversible"] === true,
        deprecated: op.deprecated === true,
      });
    }
  }
  const components = isObj(document.components) ? document.components : {};
  const securitySchemes: Record<string, SecurityScheme> = {};
  for (const [k, v] of Object.entries(isObj(components.securitySchemes) ? components.securitySchemes : {})) {
    const s = follow(document, v);
    if (isObj(s) && typeof s.type === "string") securitySchemes[k] = s as unknown as SecurityScheme;
  }
  const baseUrl = (baseOverride ?? servers[0] ?? "").replace(/\/$/, "");
  return {
    title: String(info.title ?? "API"),
    version: String(info.version ?? "0"),
    ...(typeof info.description === "string" ? { description: info.description } : {}),
    baseUrl,
    servers,
    operations: ops,
    schemas: (isObj(components.schemas) ? components.schemas : {}) as Record<string, JsonSchema>,
    securitySchemes,
    source,
    document,
  };
}

/** Parse an already-loaded OpenAPI 3.0/3.1 or Swagger 2.0 document. */
export function parseOpenApiDocument(doc: unknown, opts: { baseUrl?: string; source?: ApiSource } = {}): ImportedApi {
  if (!isObj(doc)) throw new ForgeError("BAD_INPUT", "OpenAPI document must be an object");
  if (typeof doc.swagger === "string" && doc.swagger.startsWith("2.")) return buildApi(swagger2ToOpenApi3(doc), opts.source ?? "swagger-2.0", opts.baseUrl);
  if (typeof doc.openapi === "string" && /^3\.[01]/.test(doc.openapi)) {
    return buildApi(doc, opts.source ?? (doc.openapi.startsWith("3.1") ? "openapi-3.1" : "openapi-3.0"), opts.baseUrl);
  }
  throw new ForgeError("BAD_INPUT", "Not an OpenAPI 3.0/3.1 or Swagger 2.0 document (missing 'openapi'/'swagger' version)");
}

function parseText(text: string): unknown | undefined {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  if (looksLikeHtml(t)) return undefined;
  try {
    const y = parseYaml(t, { maxAliasCount: 100 }) as unknown;
    return isObj(y) && (y.openapi || y.swagger) ? y : undefined;
  } catch {
    return undefined;
  }
}

function isUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s.trim());
}

/**
 * Import an API from an OpenAPI/Swagger spec (URL, object, JSON/YAML string) or from API docs (HTML or
 * text) which are converted heuristically or via LLM. Every URL fetch goes through `safeFetch` (SSRF guard).
 */
export async function importOpenApi(source: string | URL | Record<string, unknown>, opts: ImportOptions = {}): Promise<ImportedApi> {
  if (isObj(source) && !(source instanceof URL)) return parseOpenApiDocument(source, opts);
  let text: string;
  let origin: URL | undefined;
  const s = String(source);
  if (source instanceof URL || isUrl(s)) {
    const res = await safeFetch(s, { ...opts, headers: { accept: "application/json, application/yaml, text/yaml, text/html;q=0.8, */*;q=0.5" }, maxBytes: opts.maxBytes ?? 10 * 1024 * 1024, timeoutMs: opts.timeoutMs ?? 15_000 });
    if (!res.ok) throw new ForgeError("BAD_INPUT", `Fetching ${s} failed: HTTP ${res.status}`);
    text = await res.text();
    origin = new URL(res.url || s);
  } else if (opts.allowLocalFiles && !/^\s*[{<[]/.test(s) && !s.includes("\n") && /\.(json|ya?ml|html?|txt|md)$/i.test(s.trim())) {
    text = await readFile(s.trim(), "utf8");
  } else {
    text = s;
  }
  const parsed = parseText(text);
  if (parsed !== undefined) {
    const api = parseOpenApiDocument(parsed, opts);
    // Relative server URLs ("/v1") resolve against the spec URL.
    if (origin && (!api.baseUrl || api.baseUrl.startsWith("/"))) return { ...api, baseUrl: new URL(api.baseUrl || "/", origin).toString().replace(/\/$/, "") };
    return api;
  }
  const { document, source: kind } = await docsToOpenApi(text, { llm: opts.llm, usage: opts.usage, pageUrl: origin?.toString() });
  if (!isObj(document.paths) || Object.keys(document.paths).length === 0) throw new ForgeError("BAD_INPUT", "No API endpoints found in the given document");
  return parseOpenApiDocument(document, { ...opts, source: kind });
}

/** JSON schema for a tool call: path/query/header params by name, plus `body` for the request body. Fully dereferenced. */
export function operationInputSchema(api: ImportedApi, op: ApiOperation): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of op.parameters) {
    const s = deref(api.document, p.schema) as JsonSchema;
    properties[p.name] = { ...s, ...(p.description && !s.description ? { description: p.description } : {}) };
    if (p.required) required.push(p.name);
  }
  if (op.requestBody) {
    properties.body = deref(api.document, op.requestBody.schema) as JsonSchema;
    if (op.requestBody.required) required.push("body");
  }
  return { type: "object", properties, required };
}

export function findOperation(api: ImportedApi, opId: string): ApiOperation {
  const op = api.operations.find((o) => o.id === opId) ?? api.operations.find((o) => `${o.method.toUpperCase()} ${o.path}` === opId);
  if (!op) throw new ForgeError("NOT_FOUND", `Operation "${opId}" not found. Available: ${api.operations.map((o) => o.id).join(", ")}`);
  return op;
}
