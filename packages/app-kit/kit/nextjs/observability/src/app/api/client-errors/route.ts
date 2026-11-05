import { z } from "zod";
import { reportError } from "@/lib/observability";

const ClientError = z.object({
  type: z.string().max(200).default("Error"),
  message: z.string().min(1).max(4000),
  stack: z.string().max(20_000).optional(),
  url: z.string().max(2000).optional(),
});

/**
 * Browser errors are relayed through this route so FORGE_PROJECT_TOKEN never leaves the server.
 * Bodies are size-limited and validated; nothing is echoed back.
 */
export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > 30_000) return new Response(null, { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const parsed = ClientError.safeParse(raw);
  if (!parsed.success) return new Response(null, { status: 400 });
  const e = new Error(parsed.data.message);
  e.name = parsed.data.type;
  e.stack = parsed.data.stack;
  await reportError(e, { url: parsed.data.url, runtime: "browser", tags: { userAgent: (req.headers.get("user-agent") ?? "").slice(0, 200) } });
  return new Response(null, { status: 204 });
}
