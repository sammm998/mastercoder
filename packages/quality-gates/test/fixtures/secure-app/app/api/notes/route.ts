import { z } from "zod";
import { auth } from "../../../lib/auth";
import { db } from "../../../lib/db";

const NoteInput = z.object({ title: z.string().min(1).max(200), body: z.string().max(10000).default("") });

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = NoteInput.safeParse(await req.json());
  if (!parsed.success) return Response.json(parsed.error.flatten(), { status: 400 });
  await db.query("INSERT INTO notes (title, body, user_id) VALUES ($1, $2, $3)", [parsed.data.title, parsed.data.body, session.user.id]);
  return Response.json({ ok: true }, { status: 201 });
}
