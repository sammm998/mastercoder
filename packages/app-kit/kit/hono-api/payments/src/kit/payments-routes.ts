import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import { handlePaymentEvent } from "../lib/payments.js";
import { allowedPriceIds, stripe, verifyWebhook } from "../lib/stripe.js";

const CheckoutBody = z.object({
  priceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
  quantity: z.number().int().min(1).max(100).default(1),
  mode: z.enum(["payment", "subscription"]).default("payment"),
});

/** POST /v1/checkout → { url } and POST /webhooks/stripe (signature-verified). */
export function mountPayments(app: Hono): void {
  app.post(
    "/v1/checkout",
    zValidator("json", CheckoutBody, (r, c) => {
      if (!r.success) return c.json({ error: "invalid_body" }, 400);
    }),
    async (c) => {
      const { priceId, quantity, mode } = c.req.valid("json");
      const allowed = allowedPriceIds();
      if (allowed && !allowed.has(priceId)) return c.json({ error: "unknown_price" }, 400);
      const success = process.env.CHECKOUT_SUCCESS_URL;
      const cancel = process.env.CHECKOUT_CANCEL_URL;
      if (!success || !cancel) return c.json({ error: "checkout_not_configured" }, 500);
      const session = await stripe().checkout.sessions.create({ mode, line_items: [{ price: priceId, quantity }], success_url: success, cancel_url: cancel, allow_promotion_codes: true });
      if (!session.url) return c.json({ error: "no_checkout_url" }, 502);
      return c.json({ url: session.url });
    },
  );

  app.post("/webhooks/stripe", async (c) => {
    const raw = await c.req.text();
    let event;
    try {
      event = verifyWebhook(raw, c.req.header("stripe-signature"));
    } catch {
      return c.json({ error: "invalid_signature" }, 400);
    }
    try {
      const { handled } = await handlePaymentEvent(event);
      return c.json({ received: true, handled });
    } catch (err) {
      console.error("stripe webhook handler failed", event.type, err);
      return c.json({ error: "handler_failed" }, 500);
    }
  });
}
