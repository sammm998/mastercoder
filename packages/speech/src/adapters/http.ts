import { ForgeError } from "@forge/shared";
import type { ZodType, ZodTypeDef } from "zod";

export type FetchLike = typeof fetch;

/** fetch → status check → JSON → zod. Errors become ForgeError(PROVIDER_ERROR) without leaking secrets. */
export async function fetchJson<T>(
  vendor: string,
  url: string,
  init: RequestInit,
  schema: ZodType<T, ZodTypeDef, unknown>,
  fetchImpl?: FetchLike,
): Promise<T> {
  const f = fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await f(url, init);
  } catch (e) {
    throw new ForgeError("PROVIDER_ERROR", `${vendor}: request failed: ${(e as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new ForgeError("PROVIDER_ERROR", `${vendor}: HTTP ${res.status}: ${body.slice(0, 500)}`, { status: res.status, vendor });
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ForgeError("PROVIDER_ERROR", `${vendor}: response is not JSON: ${body.slice(0, 200)}`, { vendor });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ForgeError("PROVIDER_ERROR", `${vendor}: unexpected response shape: ${parsed.error.message.slice(0, 500)}`, { vendor });
  }
  return parsed.data;
}

const EXT: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "video/mp4": "mp4",
};

export function extensionForMime(mimeType: string): string {
  return EXT[mimeType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "bin";
}

/** Multipart file part (Node 22 / browsers have Blob + FormData globally). */
export function audioBlob(audio: Uint8Array, mimeType: string): Blob {
  // Copy into a fresh ArrayBuffer so SharedArrayBuffer-backed views are accepted by Blob.
  const copy = new Uint8Array(audio.byteLength);
  copy.set(audio);
  return new Blob([copy.buffer], { type: mimeType });
}
