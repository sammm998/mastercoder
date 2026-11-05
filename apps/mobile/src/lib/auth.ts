/** Sign-in helpers. */

/**
 * Accepts the sign-in link from the email (https://app/auth/magic?token=…), the app deep link
 * (forge://auth/magic?token=…) or the bare token, and returns the token (or null).
 */
export function extractMagicToken(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/[?&]token=([^&#\s]+)/);
  const raw = m ? safeDecode(m[1] ?? "") : s;
  // API accepts 10–200 chars; tokens are URL-safe.
  return /^[A-Za-z0-9_\-.~%+=/]{10,200}$/.test(raw) ? raw : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.trim().length <= 254;
}
