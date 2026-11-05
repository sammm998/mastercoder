import type { UsageRecord, UsageSink } from "@forge/shared";
import { createLogger, isForgeError } from "@forge/shared";
import type { ZodType, ZodTypeDef } from "zod";
import {
  ChatRequestSchema,
  ImageRequestSchema,
  SttRequestSchema,
  TTS_COST_HEADER,
  TTS_MODEL_HEADER,
  TtsRequestSchema,
  type ChatResponse,
  type GatewayRoute,
  type ImageResponse,
  type SttResponse,
} from "./protocol.js";
import type { GatewayProviders } from "./providers.js";
import type { ProjectTokenClaims } from "./tokens.js";

/** Per-project spend tracking used to enforce the AI spending cap. */
export interface SpendTracker {
  spentUsd(projectId: string): Promise<number> | number;
  /** null = no cap. */
  capUsd(projectId: string): Promise<number | null> | number | null;
  add(projectId: string, usd: number): Promise<void> | void;
}

/** In-memory spend tracker (dev/tests). Production uses billing's ledger. */
export class MemorySpendTracker implements SpendTracker {
  private readonly spent = new Map<string, number>();
  constructor(private readonly caps: Record<string, number> = {}, private readonly defaultCapUsd: number | null = null) {}
  spentUsd(projectId: string): number {
    return this.spent.get(projectId) ?? 0;
  }
  capUsd(projectId: string): number | null {
    return this.caps[projectId] ?? this.defaultCapUsd;
  }
  setCap(projectId: string, usd: number): void {
    this.caps[projectId] = usd;
  }
  add(projectId: string, usd: number): void {
    this.spent.set(projectId, this.spentUsd(projectId) + usd);
  }
}

export interface GatewayDeps {
  verifyToken(token: string): Promise<ProjectTokenClaims | null> | ProjectTokenClaims | null;
  spend: SpendTracker;
  providers: GatewayProviders;
  usage: UsageSink;
  /** Default 36 MB (fits 25 MB audio as base64). */
  maxBodyBytes?: number;
}

/** Conservative fallbacks when a provider has no estimator (USD per request). */
const FALLBACK_ESTIMATE: Record<GatewayRoute, number> = { chat: 0.05, image: 0.08, stt: 0.05, tts: 0.05 };

const log = createLogger({ component: "ai-gateway" });

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

function routeOf(url: string): GatewayRoute | null {
  const m = /\/v1\/(chat|image|stt|tts)\/?$/.exec(new URL(url).pathname);
  return (m?.[1] as GatewayRoute | undefined) ?? null;
}

async function readJson<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>, max: number): Promise<{ ok: true; value: T } | { ok: false; res: Response }> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > max) return { ok: false, res: json({ error: "payload_too_large", maxBytes: max }, 413) };
  const text = await req.text();
  if (Buffer.byteLength(text) > max) return { ok: false, res: json({ error: "payload_too_large", maxBytes: max }, 413) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, res: json({ error: "invalid_json" }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, res: json({ error: "invalid_request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400) };
  return { ok: true, value: parsed.data };
}

/**
 * Framework-agnostic Forge AI gateway: `(Request) → Response` (mount it in Fastify, Hono, Next...).
 * Validates the project token, refuses browser calls (server-side only), validates input with zod,
 * enforces the per-project spending cap, routes to the injected provider and meters usage.
 */
export async function handleGatewayRequest(req: Request, deps: GatewayDeps): Promise<Response> {
  const route = routeOf(req.url);
  if (!route) return json({ error: "not_found" }, 404);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  // Browsers always send Origin / Sec-Fetch-* on cross-origin fetches; the token must never be client-side.
  if (req.headers.get("origin") || req.headers.get("sec-fetch-site")) return json({ error: "server_side_only", message: "Call the Forge AI gateway from your server, never from the browser." }, 403);

  const auth = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  const claims = token ? await deps.verifyToken(token) : null;
  if (!claims) return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  const { projectId, workspaceId } = claims;
  const max = deps.maxBodyBytes ?? 36_000_000;

  const checkCap = async (estimateUsd: number): Promise<Response | null> => {
    const cap = await deps.spend.capUsd(projectId);
    if (cap === null) return null;
    const spent = await deps.spend.spentUsd(projectId);
    if (spent + estimateUsd > cap) return json({ error: "spend_cap", message: "This project's AI spending cap is reached.", spentUsd: spent, capUsd: cap }, 402);
    return null;
  };
  const meter = async (records: Array<Omit<UsageRecord, "projectId" | "workspaceId">>): Promise<void> => {
    let total = 0;
    for (const r of records) {
      total += r.costUsd;
      await deps.usage.record({ ...r, projectId, workspaceId, at: new Date().toISOString() });
    }
    await deps.spend.add(projectId, total);
  };
  const fail = (e: unknown): Response => {
    log.error("provider call failed", { route, projectId, error: (e as Error).message });
    if (isForgeError(e) && e.code === "MODERATION_BLOCKED") return json({ error: "moderation_blocked", message: e.message }, 422);
    return json({ error: "provider_error", message: "The AI provider failed. Try again later." }, 502);
  };

  try {
    switch (route) {
      case "chat": {
        const p = deps.providers.chat;
        if (!p) return json({ error: "not_configured", route }, 501);
        const body = await readJson(req, ChatRequestSchema, max);
        if (!body.ok) return body.res;
        const capped = await checkCap(p.estimateUsd?.(body.value) ?? FALLBACK_ESTIMATE.chat);
        if (capped) return capped;
        let r;
        try {
          r = await p.chat(body.value, { projectId });
        } catch (e) {
          return fail(e);
        }
        const tokens = r.inputTokens + r.outputTokens || 1;
        await meter([
          { kind: "llm_input_tokens", quantity: r.inputTokens, costUsd: (r.costUsd * r.inputTokens) / tokens, provider: `gateway:${p.name}`, model: r.model },
          { kind: "llm_output_tokens", quantity: r.outputTokens, costUsd: (r.costUsd * r.outputTokens) / tokens, provider: `gateway:${p.name}`, model: r.model },
        ]);
        const out: ChatResponse = { text: r.text, model: r.model, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens }, costUsd: r.costUsd };
        return json(out);
      }
      case "image": {
        const p = deps.providers.image;
        if (!p) return json({ error: "not_configured", route }, 501);
        const body = await readJson(req, ImageRequestSchema, max);
        if (!body.ok) return body.res;
        const capped = await checkCap(p.estimateUsd?.(body.value) ?? FALLBACK_ESTIMATE.image * body.value.n);
        if (capped) return capped;
        let r;
        try {
          r = await p.generate(body.value, { projectId });
        } catch (e) {
          return fail(e);
        }
        await meter([{ kind: "image_count", quantity: r.images.length, costUsd: r.costUsd, provider: `gateway:${p.name}`, model: r.model }]);
        const out: ImageResponse = { images: r.images.map((i) => ({ mediaType: i.mediaType, data: Buffer.from(i.data).toString("base64") })), model: r.model, costUsd: r.costUsd };
        return json(out);
      }
      case "stt": {
        const p = deps.providers.stt;
        if (!p) return json({ error: "not_configured", route }, 501);
        const body = await readJson(req, SttRequestSchema, max);
        if (!body.ok) return body.res;
        const audio = new Uint8Array(Buffer.from(body.value.audio, "base64"));
        const sttReq = { audio, mediaType: body.value.mediaType, language: body.value.language };
        const capped = await checkCap(p.estimateUsd?.(sttReq) ?? FALLBACK_ESTIMATE.stt);
        if (capped) return capped;
        let r;
        try {
          r = await p.transcribe(sttReq, { projectId });
        } catch (e) {
          return fail(e);
        }
        await meter([{ kind: "transcription_minutes", quantity: r.durationSec / 60, costUsd: r.costUsd, provider: `gateway:${p.name}`, model: r.model }]);
        const out: SttResponse = { text: r.text, durationSec: r.durationSec, language: r.language, model: r.model, costUsd: r.costUsd };
        return json(out);
      }
      case "tts": {
        const p = deps.providers.tts;
        if (!p) return json({ error: "not_configured", route }, 501);
        const body = await readJson(req, TtsRequestSchema, max);
        if (!body.ok) return body.res;
        const capped = await checkCap(p.estimateUsd?.(body.value) ?? FALLBACK_ESTIMATE.tts);
        if (capped) return capped;
        let r;
        try {
          r = await p.synthesize(body.value, { projectId });
        } catch (e) {
          return fail(e);
        }
        await meter([{ kind: "media_seconds", quantity: r.durationSec, costUsd: r.costUsd, provider: `gateway:${p.name}`, model: r.model }]);
        return new Response(Buffer.from(r.audio), {
          status: 200,
          headers: { "content-type": r.mediaType, "cache-control": "no-store", [TTS_COST_HEADER]: String(r.costUsd), [TTS_MODEL_HEADER]: r.model },
        });
      }
    }
  } catch (e) {
    log.error("gateway failure", { route, projectId, error: (e as Error).message });
    return json({ error: "internal_error" }, 500);
  }
}
