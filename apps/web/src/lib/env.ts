/** Public API base (Fastify + tRPC). Inlined at build time by Next. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");

/** ws(s):// URL for a gateway path, e.g. wsUrl("/ws/events/prj_1"). */
export function wsUrl(path: string, base: string = API_URL): string {
  const u = new URL(path, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

export function oauthStartUrl(provider: "google" | "microsoft", returnTo = "/app", base: string = API_URL): string {
  return `${base}/auth/oauth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Only allow same-origin relative redirects (prevents open redirects via ?next=). */
export function safeNext(next: string | null | undefined, fallback = "/app"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
