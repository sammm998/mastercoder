import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { Env } from "./env.js";
import { mountKit } from "./kit/index.js";

export const SERVICE_NAME = "{{projectSlug}}";

const EchoBody = z.object({
  message: z.string().min(1).max(2000),
  uppercase: z.boolean().optional(),
});

export function createApp(env: Pick<Env, "CORS_ORIGINS" | "BODY_LIMIT_BYTES" | "NODE_ENV">): Hono {
  const app = new Hono();
  const origins = env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

  if (env.NODE_ENV !== "test") app.use(logger());
  app.use(secureHeaders());
  app.use(bodyLimit({ maxSize: env.BODY_LIMIT_BYTES }));
  if (origins.length > 0) app.use("/v1/*", cors({ origin: origins, credentials: true }));

  // App-kit features (auth, payments, cron, observability middleware ...) mount before app routes.
  mountKit(app);

  app.get("/health", (c) => c.json({ status: "ok", service: SERVICE_NAME, uptimeSec: Math.round(process.uptime()) }));

  /** Validated request example: the body is checked by zod before the handler runs. */
  app.post(
    "/v1/echo",
    zValidator("json", EchoBody, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_body", issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    }),
    (c) => {
      const { message, uppercase } = c.req.valid("json");
      return c.json({ message: uppercase ? message.toUpperCase() : message });
    },
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
