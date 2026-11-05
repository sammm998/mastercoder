import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { cronJobs } from "@/lib/cron-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Called by the Forge scheduler per forge.json "crons" entry with `Authorization: Bearer $CRON_SECRET`. */
export async function POST(req: Request, ctx: { params: Promise<{ job: string }> }) {
  if (!isAuthorizedCronRequest(req.headers.get("authorization"))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { job } = await ctx.params;
  const entry = Object.hasOwn(cronJobs, job) ? cronJobs[job] : undefined;
  if (!entry) return Response.json({ error: "unknown_job" }, { status: 404 });
  const started = Date.now();
  try {
    const result = await entry.run();
    return Response.json({ job, ok: true, durationMs: Date.now() - started, result });
  } catch (err) {
    console.error("cron job failed", job, err);
    return Response.json({ job, ok: false, durationMs: Date.now() - started, error: (err as Error).message }, { status: 500 });
  }
}
