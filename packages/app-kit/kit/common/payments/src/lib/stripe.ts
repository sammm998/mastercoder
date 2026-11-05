// @forge-kit:server-only
import Stripe from "stripe";

let client: Stripe | null = null;

/** Server-side Stripe client (STRIPE_SECRET_KEY). */
export function stripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  client = new Stripe(key, { appInfo: { name: "forge-app" }, maxNetworkRetries: 2 });
  return client;
}

/** Price ids checkout may use (STRIPE_PRICE_IDS); null = any price of the account. */
export function allowedPriceIds(): Set<string> | null {
  const ids = (process.env.STRIPE_PRICE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/**
 * Verify a webhook's `Stripe-Signature` against the raw body. Throws on a bad or missing
 * signature; never parse the JSON yourself before this.
 */
export function verifyWebhook(rawBody: string, signature: string | null | undefined): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  if (!signature) throw new Error("Missing Stripe-Signature header");
  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}
