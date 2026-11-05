import { z } from "zod";
import { absoluteUrl } from "@/lib/site";
import { allowedPriceIds, stripe } from "@/lib/stripe";

const CheckoutBody = z.object({
  priceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
  quantity: z.number().int().min(1).max(100).default(1),
  mode: z.enum(["payment", "subscription"]).default("payment"),
});

/** Create a Stripe Checkout session and return its URL; the browser redirects there. */
export async function POST(req: Request) {
  const parsed = CheckoutBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body", issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  const { priceId, quantity, mode } = parsed.data;
  const allowed = allowedPriceIds();
  if (allowed && !allowed.has(priceId)) return Response.json({ error: "unknown_price" }, { status: 400 });
  const session = await stripe().checkout.sessions.create({
    mode,
    line_items: [{ price: priceId, quantity }],
    success_url: `${absoluteUrl("/checkout/success")}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: absoluteUrl("/"),
    allow_promotion_codes: true,
  });
  if (!session.url) return Response.json({ error: "no_checkout_url" }, { status: 502 });
  return Response.json({ url: session.url });
}
