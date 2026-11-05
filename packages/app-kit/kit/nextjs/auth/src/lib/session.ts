import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/** Current session (or null) in server components, route handlers and server actions. */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/** Signed-in user, or redirect to /sign-in and come back to `returnTo` afterwards. */
export async function requireUser(returnTo = "/") {
  const session = await getSession();
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`);
  return session.user;
}

/** Only allow same-site relative redirect targets. */
export function safeReturnTo(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
