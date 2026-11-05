import { z } from "zod";
import type { ErrorIngest } from "./ingest.js";
import { ErrorEventSchema } from "./ingest.js";
import type { ProjectTokenClaims } from "../gateway/tokens.js";

export interface ErrorIngestHttpDeps {
  ingest: ErrorIngest;
  /** Accepts the project's ingest key (public, ingest-only scope) or its server token. */
  verifyToken(token: string): Promise<ProjectTokenClaims | null> | ProjectTokenClaims | null;
  maxBodyBytes?: number;
}

const BodySchema = z.union([ErrorEventSchema, z.array(ErrorEventSchema).min(1).max(50)]);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "86400" };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

/**
 * HTTP endpoint behind FORGE_ERROR_INGEST_URL. Browsers may call it (CORS open) with the public,
 * ingest-scoped key; servers use their project token. Accepts one event or a batch of up to 50.
 */
export async function handleErrorIngestRequest(req: Request, deps: ErrorIngestHttpDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? new URL(req.url).searchParams.get("key") ?? undefined;
  const claims = token ? await deps.verifyToken(token) : null;
  if (!claims) return json({ error: "unauthorized" }, 401);
  const text = await req.text();
  if (Buffer.byteLength(text) > (deps.maxBodyBytes ?? 512_000)) return json({ error: "payload_too_large" }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid_event", issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const groups: string[] = [];
  for (const e of events) groups.push((await deps.ingest.ingest(claims.projectId, e)).group.id);
  return json({ accepted: events.length, groups }, 202);
}
