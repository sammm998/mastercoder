import { ForgeError } from "@forge/shared";
import { defineTool, type ForgeTool } from "@forge/llm";
import { jsonSchemaToZod } from "../json-schema.js";
import { makeSafeFetch, type UrlPolicy } from "../ssrf.js";
import { toolName } from "../connectors.js";
import { findOperation, operationInputSchema } from "./import.js";
import type { ApiOperation, ImportedApi } from "./model.js";

export type ApiAuth =
  | { type: "none" }
  | { type: "apiKey"; in: "header" | "query" | "cookie"; name: string; value: string }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "oauth2"; accessToken: string; tokenType?: string };

/**
 * Either a static credential, or a resolver that lends the credential to `fn` only for the duration of the
 * call (see `vaultAuth`) so plaintext secrets never outlive the request.
 */
export type AuthSource = ApiAuth | (<T>(fn: (auth: ApiAuth) => Promise<T>) => Promise<T>);

export interface CallOptions {
  /** Custom fetch (tests). Default: SSRF-guarded fetch with `policy`. */
  fetch?: typeof fetch;
  policy?: UrlPolicy;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface CallResult {
  status: number;
  ok: boolean;
  contentType: string;
  data: unknown;
}

function applyAuth(auth: ApiAuth, url: URL, headers: Record<string, string>): void {
  switch (auth.type) {
    case "none":
      return;
    case "apiKey":
      if (auth.in === "query") url.searchParams.set(auth.name, auth.value);
      else if (auth.in === "cookie") headers.cookie = [headers.cookie, `${auth.name}=${encodeURIComponent(auth.value)}`].filter(Boolean).join("; ");
      else headers[auth.name.toLowerCase()] = auth.value;
      return;
    case "bearer":
      headers.authorization = `Bearer ${auth.token}`;
      return;
    case "basic":
      headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
      return;
    case "oauth2":
      headers.authorization = `${auth.tokenType ?? "Bearer"} ${auth.accessToken}`;
      return;
  }
}

function scalar(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

function buildRequest(api: ImportedApi, op: ApiOperation, input: Record<string, unknown>, baseUrl: string): { url: URL; headers: Record<string, string>; body?: string | URLSearchParams | FormData } {
  if (!baseUrl) throw new ForgeError("BAD_INPUT", `API "${api.title}" has no server URL; pass baseUrl`);
  let path = op.path;
  for (const p of op.parameters.filter((x) => x.in === "path")) {
    const v = input[p.name];
    if (v === undefined || v === null || v === "") throw new ForgeError("BAD_INPUT", `Missing path parameter "${p.name}"`);
    path = path.replace(`{${p.name}}`, encodeURIComponent(scalar(v)));
  }
  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  const headers: Record<string, string> = { accept: "application/json, */*;q=0.5" };
  const cookies: string[] = [];
  for (const p of op.parameters) {
    const v = input[p.name];
    if (v === undefined || v === null) {
      if (p.required && p.in !== "path") throw new ForgeError("BAD_INPUT", `Missing required ${p.in} parameter "${p.name}"`);
      continue;
    }
    if (p.in === "query") {
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(p.name, scalar(x));
      else url.searchParams.set(p.name, scalar(v));
    } else if (p.in === "header") headers[p.name.toLowerCase()] = scalar(v);
    else if (p.in === "cookie") cookies.push(`${p.name}=${encodeURIComponent(scalar(v))}`);
  }
  if (cookies.length) headers.cookie = cookies.join("; ");
  let body: string | URLSearchParams | FormData | undefined;
  if (op.requestBody) {
    const b = input.body;
    if (b === undefined) {
      if (op.requestBody.required) throw new ForgeError("BAD_INPUT", "Missing request body");
    } else {
      const ct = op.requestBody.contentType;
      if (ct === "application/x-www-form-urlencoded") {
        body = new URLSearchParams(Object.entries((b ?? {}) as Record<string, unknown>).map(([k, v]) => [k, scalar(v)]));
      } else if (ct === "multipart/form-data") {
        const fd = new FormData();
        for (const [k, v] of Object.entries((b ?? {}) as Record<string, unknown>)) fd.append(k, scalar(v));
        body = fd;
      } else if (/json/i.test(ct)) {
        headers["content-type"] = ct;
        body = JSON.stringify(b);
      } else {
        headers["content-type"] = ct;
        body = scalar(b);
      }
    }
  }
  return { url, headers, ...(body !== undefined ? { body } : {}) };
}

async function withAuth<T>(auth: AuthSource, fn: (a: ApiAuth) => Promise<T>): Promise<T> {
  return typeof auth === "function" ? auth(fn) : fn(auth);
}

/** Execute one operation. Every request goes through the SSRF guard unless a custom fetch is supplied. */
export async function callOperation(api: ImportedApi, opId: string, input: Record<string, unknown>, auth: AuthSource = { type: "none" }, opts: CallOptions = {}): Promise<CallResult> {
  const op = findOperation(api, opId);
  const doFetch = opts.fetch ?? makeSafeFetch({ ...(opts.policy ?? {}), timeoutMs: opts.timeoutMs ?? 20_000, maxBytes: opts.maxBytes ?? 5 * 1024 * 1024 });
  return withAuth(auth, async (a) => {
    const { url, headers, body } = buildRequest(api, op, input, opts.baseUrl ?? api.baseUrl);
    applyAuth(a, url, headers);
    const res = await doFetch(url, { method: op.method.toUpperCase(), headers, ...(body !== undefined ? { body } : {}) });
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    let data: unknown = text;
    if (/json/i.test(contentType) && text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, ok: res.ok, contentType, data };
  });
}

/** Build the ApiAuth for one of the spec's security schemes from a single secret value. */
export function authFromScheme(api: ImportedApi, secret: string, schemeName?: string): ApiAuth {
  const name = schemeName ?? Object.keys(api.securitySchemes)[0];
  const s = name ? api.securitySchemes[name] : undefined;
  if (!s) return { type: "bearer", token: secret };
  if (s.type === "apiKey") return { type: "apiKey", in: s.in, name: s.name, value: secret };
  if (s.type === "http" && s.scheme.toLowerCase() === "basic") {
    const i = secret.indexOf(":");
    return { type: "basic", username: i >= 0 ? secret.slice(0, i) : secret, password: i >= 0 ? secret.slice(i + 1) : "" };
  }
  if (s.type === "oauth2" || s.type === "openIdConnect") return { type: "oauth2", accessToken: secret };
  return { type: "bearer", token: secret };
}

/** Minimal vault surface used for credential lending (avoids a hard dependency on the Vault class). */
export interface SecretLender {
  use<T>(scope: { workspaceId: string; projectId?: string | null }, name: string, fn: (plaintext: string) => Promise<T> | T): Promise<T>;
}

/** AuthSource that reads the credential from the vault per call; plaintext exists only inside the request. */
export function vaultAuth(vault: SecretLender, scope: { workspaceId: string; projectId?: string | null }, secretName: string, build: (secret: string) => ApiAuth): AuthSource {
  return <T>(fn: (a: ApiAuth) => Promise<T>) => vault.use(scope, secretName, (secret) => fn(build(secret)));
}

export interface OpenApiToolOptions extends CallOptions {
  /** Only expose these operation ids. */
  include?: string[];
  /** Prefix for tool names (default: sanitized API title). */
  prefix?: string;
}

/** One ForgeTool per operation; input = params + `body`; DELETE/send/pay-like operations are irreversible. */
export function openApiTools(api: ImportedApi, auth: AuthSource = { type: "none" }, opts: OpenApiToolOptions = {}): ForgeTool[] {
  const prefix = opts.prefix ?? toolName(api.title).toLowerCase().slice(0, 24);
  return api.operations
    .filter((o) => !opts.include || opts.include.includes(o.id))
    .map((op) =>
      defineTool({
        name: toolName(prefix, op.id),
        description: `${op.method.toUpperCase()} ${op.path}${op.summary ? ` - ${op.summary}` : ""}${op.description && op.description !== op.summary ? `. ${op.description.slice(0, 300)}` : ""}`,
        input: jsonSchemaToZod(operationInputSchema(api, op)),
        irreversible: op.irreversible,
        run: async (input) => {
          const r = await callOperation(api, op.id, (input ?? {}) as Record<string, unknown>, auth, opts);
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${(typeof r.data === "string" ? r.data : JSON.stringify(r.data)).slice(0, 1000)}`);
          return { status: r.status, data: r.data as unknown } as Record<string, unknown>;
        },
      }),
    ) as ForgeTool[];
}
