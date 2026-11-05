/**
 * Browser error reporting straight to the Forge error ingest with the project's PUBLIC ingest key
 * (VITE_FORGE_ERROR_KEY: ingest-only, safe to ship). Never put the server project token here.
 */
let sent = 0;

export function reportError(err: unknown, extra: { tags?: Record<string, string> } = {}): void {
  const endpoint = import.meta.env.VITE_FORGE_ERROR_INGEST_URL as string | undefined;
  const key = import.meta.env.VITE_FORGE_ERROR_KEY as string | undefined;
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-error thrown");
  if (!endpoint || !key) {
    console.error(e);
    return;
  }
  if (sent++ >= 10) return;
  const body = JSON.stringify({
    type: e.name,
    message: (e.message || "Unknown error").slice(0, 4000),
    stack: e.stack?.slice(0, 20_000),
    url: window.location.pathname,
    runtime: "browser",
    environment: import.meta.env.PROD ? "production" : "development",
    timestamp: new Date().toISOString(),
    tags: extra.tags,
  });
  void fetch(endpoint, { method: "POST", body, keepalive: true, credentials: "omit", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` } }).catch(() => undefined);
}
