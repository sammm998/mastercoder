import type { Hono } from "hono";
import { isAuthorizedCronRequest } from "../lib/cron-auth.js";
import { cronJobs } from "../lib/cron-jobs.js";

/** POST /cron/:job — called by the Forge scheduler with `Authorization: Bearer $CRON_SECRET`. */
export function mountCron(app: Hono): void {
  app.post("/cron/:job", async (c) => {
    if (!isAuthorizedCronRequest(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const job = c.req.param("job");
    const entry = Object.hasOwn(cronJobs, job) ? cronJobs[job] : undefined;
    if (!entry) return c.json({ error: "unknown_job" }, 404);
    const started = Date.now();
    try {
      const result = await entry.run();
      return c.json({ job, ok: true, durationMs: Date.now() - started, result });
    } catch (err) {
      console.error("cron job failed", job, err);
      return c.json({ job, ok: false, durationMs: Date.now() - started, error: (err as Error).message }, 500);
    }
  });
}
