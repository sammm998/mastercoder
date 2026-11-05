import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ForgeError, newId } from "@forge/shared";
import { PLANS, PlanId } from "./plans.js";
import type { BillingEvent, BillingProvider, CheckoutInput, CreateCustomerInput, UsageReport } from "./provider.js";

interface MockSession {
  id: string;
  customerId: string;
  workspaceId: string;
  plan: PlanId;
  seats: number;
  successUrl: string;
  status: "open" | "complete";
}

const MockEvent = z.object({
  id: z.string(),
  type: z.enum(["checkout.completed", "subscription.updated", "subscription.canceled", "invoice.paid", "invoice.payment_failed", "other"]),
  rawType: z.string(),
  customerId: z.string().optional(),
  workspaceId: z.string().optional(),
  plan: PlanId.optional(),
  status: z.string().optional(),
  subscriptionId: z.string().optional(),
  amountUsd: z.number().optional(),
});

/**
 * In-memory billing ledger (BILLING_PROVIDER=mock). No money moves. Checkout/portal URLs point at the
 * platform's own mock pages; webhooks are HMAC-SHA256 signed (`t=<unix>,v1=<hex>` over "<t>.<body>")
 * and verified like Stripe's, so the webhook route is exercised end-to-end.
 */
export class MockBillingProvider implements BillingProvider {
  readonly name = "mock";
  readonly isMock = true;
  readonly customers = new Map<string, CreateCustomerInput>();
  readonly sessions = new Map<string, MockSession>();
  readonly subscriptions = new Map<string, { customerId: string; plan: PlanId; seats: number; status: string }>();
  /** Meter events by identifier (deduplicated like Stripe). */
  readonly meterEvents = new Map<string, UsageReport>();

  constructor(
    private readonly opts: { webhookSecret?: string; appUrl?: string; toleranceSec?: number } = {},
  ) {}

  private get secret(): string {
    return this.opts.webhookSecret ?? "whsec_mock_forge_local";
  }
  private get appUrl(): string {
    return (this.opts.appUrl ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ customerId: string }> {
    const customerId = newId("cus_mock");
    this.customers.set(customerId, { ...input });
    return { customerId };
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ sessionId: string; url: string }> {
    if (!this.customers.has(input.customerId)) throw new ForgeError("NOT_FOUND", `Unknown customer ${input.customerId}`);
    if (PLANS[input.plan].monthlyUsd === null || PLANS[input.plan].monthlyUsd === 0) throw new ForgeError("BAD_INPUT", `Plan ${input.plan} has no self-serve checkout`);
    const id = newId("cs_mock");
    this.sessions.set(id, { id, customerId: input.customerId, workspaceId: input.workspaceId, plan: input.plan, seats: input.seats ?? 1, successUrl: input.successUrl, status: "open" });
    return { sessionId: id, url: `${this.appUrl}/billing/mock-checkout?session=${encodeURIComponent(id)}` };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    if (!this.customers.has(input.customerId)) throw new ForgeError("NOT_FOUND", `Unknown customer ${input.customerId}`);
    return { url: `${this.appUrl}/billing/mock-portal?customer=${encodeURIComponent(input.customerId)}&return=${encodeURIComponent(input.returnUrl)}` };
  }

  async reportUsage(r: UsageReport): Promise<void> {
    if (!Number.isInteger(r.credits) || r.credits <= 0) throw new ForgeError("BAD_INPUT", "credits must be a positive integer");
    if (!this.meterEvents.has(r.identifier)) this.meterEvents.set(r.identifier, { ...r });
  }

  /** Total metered credits reported for a customer. */
  usageCredits(customerId: string): number {
    return [...this.meterEvents.values()].filter((e) => e.customerId === customerId).reduce((a, e) => a + e.credits, 0);
  }

  /** Sign a payload like the mock "vendor" would (for tests and the local mock-checkout page). */
  sign(body: string, at = Math.floor(Date.now() / 1000)): string {
    return `t=${at},v1=${createHmac("sha256", this.secret).update(`${at}.${body}`).digest("hex")}`;
  }

  /** Simulate the user paying on the mock checkout page: returns the signed webhook the platform receives. */
  completeCheckout(sessionId: string): { body: string; signature: string } {
    const s = this.sessions.get(sessionId);
    if (!s) throw new ForgeError("NOT_FOUND", `Unknown checkout session ${sessionId}`);
    s.status = "complete";
    const subscriptionId = newId("sub_mock");
    this.subscriptions.set(subscriptionId, { customerId: s.customerId, plan: s.plan, seats: s.seats, status: "active" });
    const event: BillingEvent = { id: newId("evt_mock"), type: "checkout.completed", rawType: "checkout.session.completed", customerId: s.customerId, workspaceId: s.workspaceId, plan: s.plan, status: "active", subscriptionId };
    const body = JSON.stringify(event);
    return { body, signature: this.sign(body) };
  }

  async parseWebhook(rawBody: string | Buffer, signature: string): Promise<BillingEvent> {
    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const parts = Object.fromEntries(signature.split(",").map((p) => p.split("=", 2) as [string, string]));
    const t = Number(parts.t);
    if (!parts.v1 || !Number.isFinite(t)) throw new ForgeError("UNAUTHORIZED", "Malformed webhook signature");
    if (Math.abs(Date.now() / 1000 - t) > (this.opts.toleranceSec ?? 300)) throw new ForgeError("UNAUTHORIZED", "Webhook timestamp outside tolerance");
    const expected = Buffer.from(createHmac("sha256", this.secret).update(`${t}.${body}`).digest("hex"));
    const got = Buffer.from(parts.v1);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new ForgeError("UNAUTHORIZED", "Invalid webhook signature");
    return MockEvent.parse(JSON.parse(body));
  }
}
