import { createHmac, timingSafeEqual } from "node:crypto";

export interface PreviewClaims {
  projectId: string;
  /** Internal URL of the running dev server (worker private network). */
  target: string;
  /** Expiry, unix seconds. */
  exp: number;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

/** Signed, expiring preview link token (HMAC-SHA256 with the platform secret). */
export function signPreviewToken(claims: PreviewClaims, secret: string): string {
  const body = b64(JSON.stringify(claims));
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function verifyPreviewToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): PreviewClaims | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PreviewClaims;
    if (typeof c.projectId !== "string" || typeof c.target !== "string" || typeof c.exp !== "number" || c.exp < nowSec) return null;
    if (!/^https?:\/\//.test(c.target)) return null;
    return c;
  } catch {
    return null;
  }
}
