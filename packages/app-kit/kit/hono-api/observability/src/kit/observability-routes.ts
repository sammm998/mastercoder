import type { Hono } from "hono";
import { reportError } from "../lib/observability.js";

/**
 * Reports every error a route throws (after the app's onError produced the response) to the
 * Forge error ingest. Mounted first so it wraps all routes.
 */
export function mountObservability(app: Hono): void {
  app.use(async (c, next) => {
    await next();
    if (c.error) void reportError(c.error, { url: c.req.path, runtime: "server", tags: { method: c.req.method, status: String(c.res.status) } });
  });
}
