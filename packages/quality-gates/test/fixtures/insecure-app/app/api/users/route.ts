import { db } from "../../../lib/db";

// INSECURE FIXTURE: no auth check, SQL built from request input.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const name = searchParams.get("name");
  const result = await db.query(`SELECT id, email FROM users WHERE name = '${name}'`);
  return Response.json(result.rows);
}
