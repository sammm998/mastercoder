import "server-only";

/** Editors are listed by email in CMS_ADMIN_EMAILS (comma-separated, case-insensitive). */
export function isCmsAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = (process.env.CMS_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}
