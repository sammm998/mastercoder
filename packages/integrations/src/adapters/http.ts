import type { ZodType, ZodTypeDef } from "zod";
import { ForgeError } from "@forge/shared";

export interface VendorRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * JSON request against a fixed, trusted vendor API base URL (not user-supplied, so no SSRF guard needed).
 * Non-2xx -> ForgeError(PROVIDER_ERROR) with a truncated body; responses are zod-validated.
 */
export async function vendorJson<T>(vendor: string, url: string, req: VendorRequest, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
  if (req.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(u, {
      method: req.method ?? "GET",
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new ForgeError("PROVIDER_ERROR", `${vendor} request failed: ${(e as Error).message}`, { vendor, url: u.pathname });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ForgeError("PROVIDER_ERROR", `${vendor} ${req.method ?? "GET"} ${u.pathname} -> HTTP ${res.status}: ${text.slice(0, 500)}`, {
      vendor,
      status: res.status,
    });
  }
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ForgeError("PROVIDER_ERROR", `${vendor} returned non-JSON response for ${u.pathname}`, { vendor });
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ForgeError("PROVIDER_ERROR", `${vendor} response for ${u.pathname} did not match schema: ${parsed.error.message.slice(0, 500)}`, { vendor });
  return parsed.data;
}

/** Opaque, url-safe connection ids for brokers whose final id only exists after consent (Nango, Pipedream). */
export function encodeConnectionId(prefix: string, payload: Record<string, unknown>): string {
  return `${prefix}_${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

export function decodeConnectionId<T>(prefix: string, id: string, schema: ZodType<T, ZodTypeDef, unknown>): T {
  if (!id.startsWith(`${prefix}_`)) throw new ForgeError("BAD_INPUT", `Not a ${prefix} connection id`);
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(id.slice(prefix.length + 1), "base64url").toString("utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through */
  }
  throw new ForgeError("BAD_INPUT", `Malformed ${prefix} connection id`);
}
