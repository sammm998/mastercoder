import { ForgeError } from "@forge/shared";
import type { ImageInput } from "../types.js";
import { toDataUri } from "../util.js";

export type FetchFn = typeof fetch;

/** Sniff an image mime type from magic bytes. */
export function sniffMime(bytes: Uint8Array): string {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4";
  return "application/octet-stream";
}

/** Vendor APIs accept https URLs or data URIs for image inputs. */
export function imageToUrl(img: ImageInput): string {
  if (typeof img === "string") return img;
  return toDataUri(img, sniffMime(img));
}

export async function readJson(res: Response, vendor: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    throw new ForgeError("PROVIDER_ERROR", `${vendor} HTTP ${res.status}: ${text.slice(0, 500)}`, { status: res.status });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ForgeError("PROVIDER_ERROR", `${vendor} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export function requireKey(value: string | undefined, envVar: string): string {
  if (!value) throw new ForgeError("BAD_INPUT", `${envVar} is not set; set it or use MEDIA_PROVIDER=mock`);
  return value;
}
