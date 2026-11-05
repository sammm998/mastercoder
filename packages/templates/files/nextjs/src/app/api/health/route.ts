export const dynamic = "force-dynamic";

/** Liveness probe used by the Forge deployer and the Docker HEALTHCHECK. */
export function GET() {
  return Response.json({ status: "ok", uptimeSec: Math.round(process.uptime()) });
}
