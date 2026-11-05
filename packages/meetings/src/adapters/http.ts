import { ForgeError } from "@forge/shared";
import type { ZodType, ZodTypeDef } from "zod";

export type FetchLike = typeof fetch;

/** fetch → status check → JSON → zod; vendor failures become ForgeError(PROVIDER_ERROR) (no secrets in messages). */
export async function fetchJson<T>(vendor: string, url: string, init: RequestInit, schema: ZodType<T, ZodTypeDef, unknown>, fetchImpl?: FetchLike): Promise<T> {
  const text = await fetchText(vendor, url, init, fetchImpl);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ForgeError("PROVIDER_ERROR", `${vendor}: response is not JSON: ${text.slice(0, 200)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ForgeError("PROVIDER_ERROR", `${vendor}: unexpected response shape: ${parsed.error.message.slice(0, 500)}`);
  return parsed.data;
}

export async function fetchText(vendor: string, url: string, init: RequestInit, fetchImpl?: FetchLike): Promise<string> {
  const f = fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await f(url, init);
  } catch (e) {
    throw new ForgeError("PROVIDER_ERROR", `${vendor}: request failed: ${(e as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok) {
    const code = res.status === 404 ? "NOT_FOUND" : res.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR";
    throw new ForgeError(code, `${vendor}: HTTP ${res.status}: ${body.slice(0, 500)}`, { status: res.status, vendor });
  }
  return body;
}

export function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
  const v = k ? headers[k] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function bodyText(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}
