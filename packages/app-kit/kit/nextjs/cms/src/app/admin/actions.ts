"use server";

import { revalidatePath } from "next/cache";
import { isCmsAdmin } from "@/lib/cms/admin";
import { SiteContentSchema } from "@/lib/cms/schema";
import { saveSiteContent } from "@/lib/cms/store";
import { getSession } from "@/lib/session";

export type SaveResult = { ok: true; savedAt: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Server action: re-checks the session and editor rights on every call, validates, saves. */
export async function saveContentAction(input: unknown): Promise<SaveResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your session has expired. Sign in again." };
  if (!isCmsAdmin(session.user.email)) return { ok: false, error: "You are not allowed to edit content." };
  const parsed = SiteContentSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[issue.path.join(".")] ??= issue.message;
    return { ok: false, error: "Some fields need attention.", fieldErrors };
  }
  await saveSiteContent(parsed.data, session.user.id);
  revalidatePath("/");
  return { ok: true, savedAt: new Date().toISOString() };
}
