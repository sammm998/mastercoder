import { auth } from "../../../lib/auth";
import { db } from "../../../lib/db";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const name = searchParams.get("name") ?? "";
  const result = await db.query("SELECT id, email FROM users WHERE name = $1", [name]);
  return Response.json(result.rows);
}
