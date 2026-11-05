import { createHmac, timingSafeEqual } from "node:crypto";
import { ForgeError } from "@forge/shared";
import type { WebhookHeaders } from "./types.js";

function header(h: WebhookHeaders, name: string): string | undefined {
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  const v = k ? h[k] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Standard Webhooks / Svix signature (used by Recall.ai): headers webhook-id|svix-id, webhook-timestamp|svix-timestamp,
 * webhook-signature|svix-signature = space-separated "v1,<base64 HMAC-SHA256(secret, `${id}.${ts}.${body}`)>".
 * Secret format "whsec_<base64>". Rejects timestamps older/newer than `toleranceSec` (replay protection).
 */
export function verifyStandardWebhook(headers: WebhookHeaders, body: string, secret: string, opts: { toleranceSec?: number; nowSec?: number } = {}): void {
  const id = header(headers, "webhook-id") ?? header(headers, "svix-id");
  const ts = header(headers, "webhook-timestamp") ?? header(headers, "svix-timestamp");
  const sigs = header(headers, "webhook-signature") ?? header(headers, "svix-signature");
  if (!id || !ts || !sigs) throw new ForgeError("UNAUTHORIZED", "Missing webhook signature headers");
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > (opts.toleranceSec ?? 300)) throw new ForgeError("UNAUTHORIZED", "Webhook timestamp outside tolerance");
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  const ok = sigs.split(" ").some((s) => {
    const [v, sig] = s.split(",");
    return v === "v1" && sig !== undefined && safeEq(sig, expected);
  });
  if (!ok) throw new ForgeError("UNAUTHORIZED", "Invalid webhook signature");
}

/** Produce Standard Webhooks headers (tests + mock). */
export function signStandardWebhook(body: string, secret: string, id = "msg_test", nowSec = Math.floor(Date.now() / 1000)): Record<string, string> {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const sig = createHmac("sha256", key).update(`${id}.${nowSec}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(nowSec), "webhook-signature": `v1,${sig}` };
}

/**
 * Vendors that do not sign deliveries (MeetStream, Vexa): Forge appends `forge_token=<urlToken>` to the callback URL
 * it registers; the API layer copies the query value into the `x-forge-webhook-token` header before parseWebhook.
 */
export const URL_TOKEN_HEADER = "x-forge-webhook-token";

export function urlToken(secret: string, vendor: string): string {
  return createHmac("sha256", secret).update(`forge-webhook:${vendor}`).digest("hex").slice(0, 40);
}

export function withUrlToken(webhookUrl: string, secret: string | undefined, vendor: string): string {
  if (!secret) return webhookUrl;
  const u = new URL(webhookUrl);
  u.searchParams.set("forge_token", urlToken(secret, vendor));
  return u.toString();
}

export function verifyUrlToken(headers: WebhookHeaders, secret: string, vendor: string): void {
  const got = header(headers, URL_TOKEN_HEADER);
  if (!got || !safeEq(got, urlToken(secret, vendor))) throw new ForgeError("UNAUTHORIZED", `Invalid ${vendor} webhook token`);
}
