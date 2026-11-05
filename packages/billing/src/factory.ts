import { env, selectAdapter } from "@forge/shared";
import { MockBillingProvider } from "./mock-billing.js";
import { StripeBillingProvider } from "./adapters/stripe.js";
import type { BillingProvider } from "./provider.js";

/** BILLING_PROVIDER=stripe|mock (default mock). */
export function createBillingProvider(): BillingProvider {
  return selectAdapter<BillingProvider>(
    "BILLING_PROVIDER",
    {
      stripe: () =>
        new StripeBillingProvider({
          secretKey: env("STRIPE_SECRET_KEY"),
          webhookSecret: env("STRIPE_WEBHOOK_SECRET"),
          planPrices: {
            ...(process.env.STRIPE_PRICE_PRO ? { pro: process.env.STRIPE_PRICE_PRO } : {}),
            ...(process.env.STRIPE_PRICE_TEAM ? { team: process.env.STRIPE_PRICE_TEAM } : {}),
            ...(process.env.STRIPE_PRICE_ENTERPRISE ? { enterprise: process.env.STRIPE_PRICE_ENTERPRISE } : {}),
          },
          ...(process.env.STRIPE_PRICE_USAGE ? { usagePrice: process.env.STRIPE_PRICE_USAGE } : {}),
          meterEventName: process.env.STRIPE_METER_EVENT_NAME || "forge_credits",
          automaticTax: process.env.STRIPE_AUTOMATIC_TAX === "true",
        }),
      mock: () => new MockBillingProvider({ ...(process.env.BILLING_MOCK_WEBHOOK_SECRET ? { webhookSecret: process.env.BILLING_MOCK_WEBHOOK_SECRET } : {}) }),
    },
    "mock",
  ).instance;
}
