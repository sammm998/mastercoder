import Stripe from "stripe";
import { z } from "zod";
import { ForgeError } from "@forge/shared";
import { PLANS, PlanId } from "../plans.js";
import type { BillingEvent, BillingEventType, BillingProvider, CheckoutInput, CreateCustomerInput, UsageReport } from "../provider.js";

export interface StripeBillingOptions {
  secretKey: string;
  webhookSecret: string;
  /** Recurring price id per paid plan (STRIPE_PRICE_PRO / _TEAM / _ENTERPRISE). */
  planPrices: Partial<Record<PlanId, string>>;
  /** Metered price attached to the billing meter (STRIPE_PRICE_USAGE); added to subscriptions so usage is invoiced. */
  usagePrice?: string;
  /** Billing meter event name (STRIPE_METER_EVENT_NAME, default "forge_credits"; value = credits of $0.001). */
  meterEventName?: string;
  /** Stripe Tax (EU VAT) on checkout; requires Stripe Tax to be enabled on the account (STRIPE_AUTOMATIC_TAX=true). */
  automaticTax?: boolean;
}

const Obj = z.record(z.unknown());
const Meta = z.record(z.string()).nullish();
const CheckoutSessionObj = z.object({ id: z.string(), customer: z.string().nullish(), client_reference_id: z.string().nullish(), subscription: z.string().nullish(), metadata: Meta, status: z.string().nullish() }).passthrough();
const SubscriptionObj = z
  .object({
    id: z.string(),
    customer: z.string(),
    status: z.string(),
    metadata: Meta,
    items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string() }).passthrough() }).passthrough()) }).passthrough().optional(),
  })
  .passthrough();
const InvoiceObj = z.object({ id: z.string(), customer: z.string().nullish(), amount_paid: z.number().nullish(), amount_due: z.number().nullish(), currency: z.string().nullish(), status: z.string().nullish() }).passthrough();

/** Stripe Billing via the official `stripe` SDK: customers, Checkout, Customer Portal, Billing Meter Events, webhooks. */
export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe";
  readonly isMock = false;
  private readonly stripe: Stripe;
  private readonly planByPrice: Map<string, PlanId>;

  constructor(private readonly opts: StripeBillingOptions) {
    if (!opts.secretKey) throw new ForgeError("BAD_INPUT", "STRIPE_SECRET_KEY is required");
    if (!opts.webhookSecret) throw new ForgeError("BAD_INPUT", "STRIPE_WEBHOOK_SECRET is required");
    this.stripe = new Stripe(opts.secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "Forge" } });
    this.planByPrice = new Map(Object.entries(opts.planPrices).map(([plan, price]) => [price as string, plan as PlanId]));
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ customerId: string }> {
    const c = await this.stripe.customers.create(
      { email: input.email, ...(input.name ? { name: input.name } : {}), metadata: { workspaceId: input.workspaceId } },
      { idempotencyKey: `forge-customer-${input.workspaceId}` },
    );
    return { customerId: c.id };
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ sessionId: string; url: string }> {
    const price = this.opts.planPrices[input.plan];
    if (!price || PLANS[input.plan].monthlyUsd === 0) throw new ForgeError("BAD_INPUT", `Plan ${input.plan} has no Stripe price configured for self-serve checkout`);
    const s = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      client_reference_id: input.workspaceId,
      line_items: [{ price, quantity: Math.max(1, input.seats ?? 1) }, ...(this.opts.usagePrice ? [{ price: this.opts.usagePrice }] : [])],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
      ...(this.opts.automaticTax ? { automatic_tax: { enabled: true }, customer_update: { address: "auto" as const } } : {}),
      metadata: { workspaceId: input.workspaceId, plan: input.plan },
      subscription_data: { metadata: { workspaceId: input.workspaceId, plan: input.plan } },
    });
    if (!s.url) throw new ForgeError("PROVIDER_ERROR", "Stripe returned a checkout session without url");
    return { sessionId: s.id, url: s.url };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const s = await this.stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl });
    return { url: s.url };
  }

  async reportUsage(r: UsageReport): Promise<void> {
    if (!Number.isInteger(r.credits) || r.credits <= 0) throw new ForgeError("BAD_INPUT", "credits must be a positive integer");
    await this.stripe.billing.meterEvents.create({
      event_name: this.opts.meterEventName ?? "forge_credits",
      identifier: r.identifier,
      payload: { stripe_customer_id: r.customerId, value: String(r.credits) },
      ...(r.timestamp ? { timestamp: Math.floor(r.timestamp.getTime() / 1000) } : {}),
    });
  }

  private plan(meta: Record<string, string> | null | undefined, priceIds: string[]): PlanId | undefined {
    for (const p of priceIds) {
      const plan = this.planByPrice.get(p);
      if (plan) return plan;
    }
    const m = PlanId.safeParse(meta?.plan);
    return m.success ? m.data : undefined;
  }

  async parseWebhook(rawBody: string | Buffer, signature: string): Promise<BillingEvent> {
    let event: { id: string; type: string; data: { object: unknown } };
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.opts.webhookSecret) as unknown as typeof event;
    } catch (e) {
      throw new ForgeError("UNAUTHORIZED", `Invalid Stripe webhook: ${(e as Error).message}`);
    }
    const base = { id: event.id, rawType: event.type };
    const obj = Obj.parse(event.data.object);
    switch (event.type) {
      case "checkout.session.completed": {
        const s = CheckoutSessionObj.parse(obj);
        return {
          ...base,
          type: "checkout.completed",
          ...(s.customer ? { customerId: s.customer } : {}),
          ...((s.client_reference_id ?? s.metadata?.workspaceId) ? { workspaceId: (s.client_reference_id ?? s.metadata?.workspaceId)! } : {}),
          ...(s.subscription ? { subscriptionId: s.subscription } : {}),
          ...(this.plan(s.metadata, []) ? { plan: this.plan(s.metadata, [])! } : {}),
          status: "active",
        };
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const s = SubscriptionObj.parse(obj);
        const plan = this.plan(s.metadata, s.items?.data.map((i) => i.price.id) ?? []);
        const type: BillingEventType = event.type === "customer.subscription.deleted" || s.status === "canceled" ? "subscription.canceled" : "subscription.updated";
        return { ...base, type, customerId: s.customer, subscriptionId: s.id, status: s.status, ...(s.metadata?.workspaceId ? { workspaceId: s.metadata.workspaceId } : {}), ...(plan ? { plan } : {}) };
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        const inv = InvoiceObj.parse(obj);
        const cents = event.type === "invoice.paid" ? inv.amount_paid : inv.amount_due;
        return {
          ...base,
          type: event.type,
          ...(inv.customer ? { customerId: inv.customer } : {}),
          ...(inv.status ? { status: inv.status } : {}),
          ...(typeof cents === "number" && (inv.currency ?? "usd") === "usd" ? { amountUsd: cents / 100 } : {}),
        };
      }
      default:
        return { ...base, type: "other" };
    }
  }
}
