import { describe, it, expect, vi, beforeEach } from "vitest";

const stripeMock = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rec =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return typeof result === "function" ? (result as (...a: unknown[]) => unknown)(...args) : result;
    };
  const events: Record<string, unknown> = {};
  const instance = {
    customers: { create: rec("customers.create", { id: "cus_123" }) },
    checkout: { sessions: { create: rec("checkout.sessions.create", { id: "cs_123", url: "https://checkout.stripe.com/c/pay/cs_123" }) } },
    billingPortal: { sessions: { create: rec("billingPortal.sessions.create", { url: "https://billing.stripe.com/p/session/abc" }) } },
    billing: { meterEvents: { create: rec("billing.meterEvents.create", { identifier: "x" }) } },
    webhooks: {
      constructEvent: (body: string, sig: string, secret: string) => {
        calls.push({ method: "webhooks.constructEvent", args: [body, sig, secret] });
        if (sig !== "valid") throw new Error("No signatures found matching the expected signature for payload");
        return events[JSON.parse(body).id as string];
      },
    },
  };
  const ctor = vi.fn(() => instance);
  return { calls, events, ctor };
});
vi.mock("stripe", () => ({ default: stripeMock.ctor }));

import { MockBillingProvider, StripeBillingProvider, createBillingProvider } from "../src/index.js";

const opts = { secretKey: "sk_test_x", webhookSecret: "whsec_x", planPrices: { pro: "price_pro", team: "price_team" }, usagePrice: "price_usage", meterEventName: "forge_credits" };

describe("StripeBillingProvider (vi.mock stripe)", () => {
  beforeEach(() => {
    stripeMock.calls.length = 0;
  });

  it("creates customers, checkout and portal sessions", async () => {
    const p = new StripeBillingProvider(opts);
    expect(stripeMock.ctor).toHaveBeenCalledWith("sk_test_x", expect.objectContaining({ maxNetworkRetries: 2 }));
    expect(await p.createCustomer({ workspaceId: "ws_1", email: "a@example.com", name: "Acme" })).toEqual({ customerId: "cus_123" });
    expect(stripeMock.calls[0]!.args).toEqual([{ email: "a@example.com", name: "Acme", metadata: { workspaceId: "ws_1" } }, { idempotencyKey: "forge-customer-ws_1" }]);
    const s = await p.createCheckoutSession({ customerId: "cus_123", workspaceId: "ws_1", plan: "team", seats: 5, successUrl: "https://app/ok", cancelUrl: "https://app/no" });
    expect(s).toEqual({ sessionId: "cs_123", url: "https://checkout.stripe.com/c/pay/cs_123" });
    expect(stripeMock.calls[1]!.args[0]).toMatchObject({
      mode: "subscription",
      customer: "cus_123",
      client_reference_id: "ws_1",
      line_items: [{ price: "price_team", quantity: 5 }, { price: "price_usage" }],
      subscription_data: { metadata: { workspaceId: "ws_1", plan: "team" } },
    });
    await expect(p.createCheckoutSession({ customerId: "cus_123", workspaceId: "ws_1", plan: "free", successUrl: "x", cancelUrl: "y" })).rejects.toThrow(/no Stripe price/);
    expect(await p.createPortalSession({ customerId: "cus_123", returnUrl: "https://app/billing" })).toEqual({ url: "https://billing.stripe.com/p/session/abc" });
  });

  it("reports usage via Billing Meter Events", async () => {
    const p = new StripeBillingProvider(opts);
    await p.reportUsage({ customerId: "cus_123", credits: 1500, identifier: "task_tsk_1", timestamp: new Date("2026-11-05T10:00:00Z") });
    expect(stripeMock.calls[0]).toEqual({
      method: "billing.meterEvents.create",
      args: [{ event_name: "forge_credits", identifier: "task_tsk_1", payload: { stripe_customer_id: "cus_123", value: "1500" }, timestamp: 1793872800 }],
    });
    await expect(p.reportUsage({ customerId: "c", credits: 0.5, identifier: "i" })).rejects.toThrow(/positive integer/);
  });

  it("verifies and normalizes webhooks", async () => {
    const p = new StripeBillingProvider(opts);
    stripeMock.events.evt_1 = { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", customer: "cus_123", client_reference_id: "ws_1", subscription: "sub_1", metadata: { plan: "pro", workspaceId: "ws_1" } } } };
    stripeMock.events.evt_2 = { id: "evt_2", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_123", status: "past_due", metadata: {}, items: { data: [{ price: { id: "price_team" } }] } } } };
    stripeMock.events.evt_3 = { id: "evt_3", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_123", status: "canceled", metadata: { workspaceId: "ws_1", plan: "team" } } } };
    stripeMock.events.evt_4 = { id: "evt_4", type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_123", amount_paid: 9900, currency: "usd", status: "paid" } } };
    stripeMock.events.evt_5 = { id: "evt_5", type: "payment_intent.created", data: { object: { id: "pi_1" } } };
    const parse = (id: string) => p.parseWebhook(JSON.stringify({ id }), "valid");
    expect(await parse("evt_1")).toEqual({ id: "evt_1", rawType: "checkout.session.completed", type: "checkout.completed", customerId: "cus_123", workspaceId: "ws_1", subscriptionId: "sub_1", plan: "pro", status: "active" });
    expect(await parse("evt_2")).toMatchObject({ type: "subscription.updated", plan: "team", status: "past_due", subscriptionId: "sub_1" });
    expect(await parse("evt_3")).toMatchObject({ type: "subscription.canceled", workspaceId: "ws_1" });
    expect(await parse("evt_4")).toMatchObject({ type: "invoice.paid", amountUsd: 99 });
    expect(await parse("evt_5")).toEqual({ id: "evt_5", rawType: "payment_intent.created", type: "other" });
    expect(stripeMock.calls.find((c) => c.method === "webhooks.constructEvent")!.args[2]).toBe("whsec_x");
    await expect(p.parseWebhook(JSON.stringify({ id: "evt_1" }), "forged")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("factory selects by BILLING_PROVIDER and requires keys", () => {
    const prev = { p: process.env.BILLING_PROVIDER, k: process.env.STRIPE_SECRET_KEY };
    delete process.env.BILLING_PROVIDER;
    expect(createBillingProvider().isMock).toBe(true);
    process.env.BILLING_PROVIDER = "stripe";
    delete process.env.STRIPE_SECRET_KEY;
    expect(() => createBillingProvider()).toThrow(/STRIPE_SECRET_KEY/);
    for (const [k, v] of [["BILLING_PROVIDER", prev.p], ["STRIPE_SECRET_KEY", prev.k]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});

describe("MockBillingProvider", () => {
  it("runs checkout -> signed webhook -> verified event, and dedupes meter events", async () => {
    const m = new MockBillingProvider({ appUrl: "https://forge.example" });
    const { customerId } = await m.createCustomer({ workspaceId: "ws_1", email: "a@example.com" });
    const s = await m.createCheckoutSession({ customerId, workspaceId: "ws_1", plan: "pro", successUrl: "x", cancelUrl: "y" });
    expect(s.url).toMatch(/^https:\/\/forge\.example\/billing\/mock-checkout\?session=cs_mock_/);
    const hook = m.completeCheckout(s.sessionId);
    expect(await m.parseWebhook(hook.body, hook.signature)).toMatchObject({ type: "checkout.completed", workspaceId: "ws_1", plan: "pro", customerId });
    await expect(m.parseWebhook(hook.body.replace("pro", "team"), hook.signature)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(m.parseWebhook(hook.body, m.sign(hook.body, Math.floor(Date.now() / 1000) - 3600))).rejects.toThrow(/tolerance/);
    await expect(m.parseWebhook(hook.body, "garbage")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await m.reportUsage({ customerId, credits: 10, identifier: "a" });
    await m.reportUsage({ customerId, credits: 10, identifier: "a" });
    await m.reportUsage({ customerId, credits: 5, identifier: "b" });
    expect(m.usageCredits(customerId)).toBe(15);
    expect((await m.createPortalSession({ customerId, returnUrl: "https://forge.example/b" })).url).toContain("mock-portal");
    await expect(m.createCheckoutSession({ customerId, workspaceId: "ws_1", plan: "enterprise", successUrl: "x", cancelUrl: "y" })).rejects.toThrow(/self-serve/);
    await expect(m.createCheckoutSession({ customerId: "cus_nope", workspaceId: "ws_1", plan: "pro", successUrl: "x", cancelUrl: "y" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
