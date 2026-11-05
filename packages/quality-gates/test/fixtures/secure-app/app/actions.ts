"use server";

import { z } from "zod";
import { auth } from "../lib/auth";
import { db } from "../lib/db";

const Rename = z.object({ id: z.string().uuid(), title: z.string().min(1).max(200) });

export async function renameNote(formData: FormData) {
  const session = await auth();
  if (!session) throw new Error("unauthorized");
  const input = Rename.parse({ id: formData.get("id"), title: formData.get("title") });
  await db.query("UPDATE notes SET title = $1 WHERE id = $2 AND user_id = $3", [input.title, input.id, session.user.id]);
}
