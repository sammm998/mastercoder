// @forge-kit:server-only
/**
 * Server-side error reporting to the Forge error ingest (FORGE_ERROR_INGEST_URL). Events use
 * Sentry-style fields (type, message, stack, release, environment, tags) and are grouped by
 * fingerprint on the Forge side, which can suggest fixes for the owner to approve.
 * Reporting never throws and never blocks the request for long.
 */

export interface ErrorContext {
  url?: string;
  runtime?: "server" | "edge" | "browser" | "mobile";
  tags?: Record<string, string>;
  fingerprint?: string[];
}

const recent = new Map<string, number>();

function describe(err: unknown): { type: string; message: string; stack?: string } {
  if (err instanceof Error) return { type: err.name || "Error", message: err.message || String(err), stack: err.stack };
  return { type: "NonError", message: typeof err === "string" ? err : JSON.stringify(err) ?? String(err) };
}

/** Strip query strings (may contain tokens) from URLs before reporting. */
export function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, "http://local");
    return u.origin === "http://local" ? u.pathname : `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

export async function reportError(err: unknown, ctx: ErrorContext = {}): Promise<void> {
  const endpoint = process.env.FORGE_ERROR_INGEST_URL;
  const token = process.env.FORGE_PROJECT_TOKEN;
  const e = describe(err);
  if (!endpoint || !token) {
    console.error("[error]", e.type, e.message);
    return;
  }
  // Drop exact duplicates within 10 s to avoid flooding during an outage.
  const key = `${e.type}:${e.message}:${e.stack?.split("\n")[1] ?? ""}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - 10_000) return;
  recent.set(key, now);
  if (recent.size > 500) recent.clear();
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...e,
        stack: e.stack?.slice(0, 20_000),
        message: e.message.slice(0, 4000),
        url: scrubUrl(ctx.url),
        runtime: ctx.runtime ?? "server",
        release: process.env.APP_RELEASE,
        environment: process.env.NODE_ENV === "production" ? "production" : "development",
        timestamp: new Date().toISOString(),
        tags: ctx.tags,
        fingerprint: ctx.fingerprint,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Reporting must never take the app down.
  }
}
