// forge:public — liveness probe, intentionally unauthenticated.
export async function GET() {
  return Response.json({ ok: true });
}
