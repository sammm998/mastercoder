import { handlePaymentEvent } from "@/lib/payments";
import { verifyWebhook } from "@/lib/stripe";

export const dynamic = "force-dynamic";

/** Stripe webhook: verifies the signature over the raw body, then dispatches the event. */
export async function POST(req: Request) {
  const raw = await req.text();
  let event;
  try {
    event = verifyWebhook(raw, req.headers.get("stripe-signature"));
  } catch {
    return Response.json({ error: "invalid_signature" }, { status: 400 });
  }
  try {
    const { handled } = await handlePaymentEvent(event);
    return Response.json({ received: true, handled });
  } catch (err) {
    console.error("stripe webhook handler failed", event.type, err);
    // 500 makes Stripe retry the delivery.
    return Response.json({ error: "handler_failed" }, { status: 500 });
  }
}
