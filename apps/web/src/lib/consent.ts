export const CONSENT_COOKIE = "forge_consent";
export type Consent = "all" | "essential";

export function readCookie(name: string, cookieString: string = typeof document === "undefined" ? "" : document.cookie): string | undefined {
  for (const part of cookieString.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function readConsent(cookieString?: string): Consent | undefined {
  const v = readCookie(CONSENT_COOKIE, cookieString);
  return v === "all" || v === "essential" ? v : undefined;
}

/**
 * Preference cookies (language, theme) are only remembered across sessions with consent; otherwise
 * they are session cookies. Essential cookies (sign-in session, consent itself) are always set.
 */
export function preferenceCookie(name: string, value: string, consent: Consent | undefined = readConsent()): string {
  const persist = consent === "all" ? "; max-age=31536000" : "";
  return `${name}=${encodeURIComponent(value)}; path=/; samesite=lax${persist}`;
}
