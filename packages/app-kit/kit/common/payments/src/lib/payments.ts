// @forge-kit:server-only
import type Stripe from "stripe";

/**
 * Handlers for verified Stripe webhook events. Fulfil orders / grant access here. Stripe retries
 * failed deliveries, so handlers must be idempotent (key on the event or session id).
 */
export type PaymentHandlers = Partial<{ [K in Stripe.Event["type"]]: (event: Extract<Stripe.Event, { type: K }>) => Promise<void> }>;

const processed = new Set<string>();

export const paymentHandlers: PaymentHandlers = {
  "checkout.session.completed": async (event) => {
    const s = event.data.object;
    console.log(JSON.stringify({ msg: "checkout completed", sessionId: s.id, paymentStatus: s.payment_status, amountTotal: s.amount_total, currency: s.currency, customer: s.customer }));
  },
  "checkout.session.async_payment_failed": async (event) => {
    console.warn(JSON.stringify({ msg: "async payment failed", sessionId: event.data.object.id }));
  },
  "customer.subscription.deleted": async (event) => {
    console.log(JSON.stringify({ msg: "subscription ended", subscriptionId: event.data.object.id, customer: event.data.object.customer }));
  },
};

/** Dispatch a verified event to its handler. Duplicate deliveries in this process are skipped. */
export async function handlePaymentEvent(event: Stripe.Event): Promise<{ handled: boolean }> {
  if (processed.has(event.id)) return { handled: true };
  const handler = paymentHandlers[event.type] as ((e: Stripe.Event) => Promise<void>) | undefined;
  if (!handler) return { handled: false };
  await handler(event);
  processed.add(event.id);
  if (processed.size > 10_000) processed.clear();
  return { handled: true };
}
