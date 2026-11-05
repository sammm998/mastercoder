import { cookies } from "next/headers";
import { jwtVerify } from "jose";

export interface Session {
  user: { id: string; email: string };
}

/** Resolve the signed-in user from the session cookie; null when unauthenticated. */
export async function auth(): Promise<Session | null> {
  const token = cookies().get("session")?.value;
  if (!token) return null;
  const key = new TextEncoder().encode(process.env.SESSION_SECRET);
  try {
    const { payload } = await jwtVerify(token, key);
    return { user: { id: String(payload.sub), email: String(payload.email) } };
  } catch {
    return null;
  }
}
