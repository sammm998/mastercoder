import type { PlanId } from "./plans.js";

export interface CreateCustomerInput {
  workspaceId: string;
  email: string;
  name?: string;
}

export interface CheckoutInput {
  customerId: string;
  workspaceId: string;
  plan: PlanId;
  seats?: number;
  successUrl: string;
  cancelUrl: string;
}

export interface UsageReport {
  customerId: string;
  /** Integer billing credits (1 credit = $0.001 of user-facing price). */
  credits: number;
  /** Idempotency key (Stripe dedupes meter events by identifier). */
  identifier: string;
  timestamp?: Date;
}

export type BillingEventType = "checkout.completed" | "subscription.updated" | "subscription.canceled" | "invoice.paid" | "invoice.payment_failed" | "other";

/** Provider-neutral webhook event. */
export interface BillingEvent {
  id: string;
  type: BillingEventType;
  /** Vendor event type, e.g. "customer.subscription.updated". */
  rawType: string;
  customerId?: string;
  workspaceId?: string;
  plan?: PlanId;
  status?: string;
  subscriptionId?: string;
  amountUsd?: number;
}

export interface BillingProvider {
  readonly name: string;
  readonly isMock: boolean;
  createCustomer(input: CreateCustomerInput): Promise<{ customerId: string }>;
  /** Hosted checkout for a plan subscription. */
  createCheckoutSession(input: CheckoutInput): Promise<{ sessionId: string; url: string }>;
  /** Hosted customer portal (payment methods, invoices, cancel). */
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Report metered usage (billing meter events). */
  reportUsage(report: UsageReport): Promise<void>;
  /** Verify the signature and normalize a webhook. Throws UNAUTHORIZED on a bad signature. */
  parseWebhook(rawBody: string | Buffer, signature: string): Promise<BillingEvent>;
}
