import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const ProjectTokenClaimsSchema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().optional(),
  /** Expiry, unix seconds. */
  exp: z.number().int().optional(),
  /** Scope: "ai" for the AI gateway, "ingest" for error ingest. Absent = all. */
  scope: z.array(z.enum(["ai", "ingest"])).optional(),
});
export type ProjectTokenClaims = z.infer<typeof ProjectTokenClaimsSchema>;

const PREFIX = "fpt_";

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Stateless HMAC project token: `fpt_<base64url(claims)>.<hmac>`. Injected into apps as FORGE_PROJECT_TOKEN. */
export function createProjectToken(claims: ProjectTokenClaims, secret: string): string {
  if (secret.length < 32) throw new Error("project token secret must be at least 32 characters");
  const payload = Buffer.from(JSON.stringify(ProjectTokenClaimsSchema.parse(claims))).toString("base64url");
  return `${PREFIX}${payload}.${sign(payload, secret)}`;
}

/** Claims of a valid, unexpired token; null otherwise. Constant-time signature comparison. */
export function verifyProjectToken(token: string, secret: string, requiredScope?: "ai" | "ingest", nowSec = Math.floor(Date.now() / 1000)): ProjectTokenClaims | null {
  if (!token.startsWith(PREFIX)) return null;
  const [payload, sig] = token.slice(PREFIX.length).split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload, secret));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const claims = ProjectTokenClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (claims.exp !== undefined && claims.exp < nowSec) return null;
    if (requiredScope && claims.scope && !claims.scope.includes(requiredScope)) return null;
    return claims;
  } catch {
    return null;
  }
}
