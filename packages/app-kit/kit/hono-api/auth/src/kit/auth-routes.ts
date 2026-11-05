import type { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { auth, trustedOrigins, type AuthSession } from "../lib/auth.js";

/** Better Auth endpoints at /api/auth/* (sign-up, sign-in, magic link, OAuth callbacks, session). */
export function mountAuth(app: Hono): void {
  if (trustedOrigins.length > 0) {
    app.use("/api/auth/*", cors({ origin: trustedOrigins, credentials: true, allowHeaders: ["Content-Type", "Authorization"], allowMethods: ["GET", "POST", "OPTIONS"] }));
  }
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
}

export type AuthVariables = { user: AuthSession["user"]; session: AuthSession["session"] };

/** Route middleware: 401 unless signed in; exposes c.get("user") / c.get("session"). */
export const requireUser = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const s = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!s) return c.json({ error: "unauthorized" }, 401);
  c.set("user", s.user);
  c.set("session", s.session);
  await next();
});
