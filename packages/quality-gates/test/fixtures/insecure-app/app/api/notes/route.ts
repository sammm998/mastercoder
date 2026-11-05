import { db } from "../../../lib/db";

// INSECURE FIXTURE: unauthenticated, unvalidated POST.
export async function POST(req: Request) {
  const body = await req.json();
  await db.query("INSERT INTO notes (title, body, user_id) VALUES ($1, $2, $3)", [body.title, body.body, body.userId]);
  return Response.json({ ok: true }, { status: 201 });
}
