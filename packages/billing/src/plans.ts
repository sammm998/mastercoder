import { z } from "zod";
import { ForgeError } from "@forge/shared";

export const PlanId = z.enum(["free", "pro", "team", "enterprise"]);
export type PlanId = z.infer<typeof PlanId>;

export interface PlanLimits {
  /** Builds running at the same time per workspace. */
  concurrentBuilds: number;
  /** Sandbox minutes included per month (beyond that billed as usage on paid plans, hard stop on Free). */
  sandboxMinutes: number;
  /** Meeting-bot hours per month. */
  botHours: number;
  seats: number;
  customDomains: number;
  /** Always-on user agents (cron / webhook / chat). */
  activeAgents: number;
}

export type Feature =
  | "web_apps"
  | "websites"
  | "mobile_apps"
  | "backends"
  | "images"
  | "video"
  | "slides_docs"
  | "user_agents"
  | "integrations"
  | "meeting_bot"
  | "voice_input"
  | "custom_domains"
  | "private_projects"
  | "realtime_collaboration"
  | "sso"
  | "audit_log"
  | "dedicated_kms_key"
  | "priority_queue"
  | "sla";

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly subscription price in USD; null = custom contract (Enterprise). */
  monthlyUsd: number | null;
  /** Usage credit included every month, in USD of user-facing price (see pricing.ts). */
  includedCreditUsd: number;
  /** Paid plans may continue past the included credit (metered overage); Free stops. */
  overage: boolean;
  limits: PlanLimits;
  features: Feature[];
  /** Env var holding the Stripe recurring price id for this plan. */
  stripePriceEnv?: string;
}

const CORE: Feature[] = ["web_apps", "websites", "mobile_apps", "backends", "images", "slides_docs", "integrations", "voice_input"];

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    monthlyUsd: 0,
    includedCreditUsd: 2,
    overage: false,
    limits: { concurrentBuilds: 1, sandboxMinutes: 60, botHours: 1, seats: 1, customDomains: 0, activeAgents: 1 },
    features: CORE,
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyUsd: 25,
    includedCreditUsd: 25,
    overage: true,
    limits: { concurrentBuilds: 3, sandboxMinutes: 1_500, botHours: 10, seats: 1, customDomains: 3, activeAgents: 10 },
    features: [...CORE, "video", "user_agents", "meeting_bot", "custom_domains", "private_projects"],
    stripePriceEnv: "STRIPE_PRICE_PRO",
  },
  team: {
    id: "team",
    name: "Team",
    monthlyUsd: 99,
    includedCreditUsd: 100,
    overage: true,
    limits: { concurrentBuilds: 10, sandboxMinutes: 6_000, botHours: 50, seats: 5, customDomains: 15, activeAgents: 50 },
    features: [...CORE, "video", "user_agents", "meeting_bot", "custom_domains", "private_projects", "realtime_collaboration", "audit_log", "priority_queue"],
    stripePriceEnv: "STRIPE_PRICE_TEAM",
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    monthlyUsd: null,
    includedCreditUsd: 1_000,
    overage: true,
    limits: { concurrentBuilds: 50, sandboxMinutes: 60_000, botHours: 500, seats: 1_000, customDomains: 100, activeAgents: 1_000 },
    features: [
      ...CORE,
      "video",
      "user_agents",
      "meeting_bot",
      "custom_domains",
      "private_projects",
      "realtime_collaboration",
      "audit_log",
      "priority_queue",
      "sso",
      "dedicated_kms_key",
      "sla",
    ],
    stripePriceEnv: "STRIPE_PRICE_ENTERPRISE",
  },
};

export function getPlan(id: string): Plan {
  const p = PlanId.safeParse(id);
  if (!p.success) throw new ForgeError("BAD_INPUT", `Unknown plan "${id}"`);
  return PLANS[p.data];
}

export function planHasFeature(id: PlanId, f: Feature): boolean {
  return PLANS[id].features.includes(f);
}

/** Throws FORBIDDEN when the plan lacks a feature (UI shows an upgrade prompt). */
export function requireFeature(id: PlanId, f: Feature): void {
  if (!planHasFeature(id, f)) throw new ForgeError("FORBIDDEN", `The ${PLANS[id].name} plan does not include ${f.replace(/_/g, " ")}`, { plan: id, feature: f });
}

/** Throws RATE_LIMITED when a counted limit would be exceeded (e.g. concurrent builds). */
export function checkLimit(id: PlanId, limit: keyof PlanLimits, current: number, adding = 1): void {
  const max = PLANS[id].limits[limit];
  if (current + adding > max) throw new ForgeError("RATE_LIMITED", `${PLANS[id].name} plan limit reached: ${limit} ${current}/${max}`, { plan: id, limit, max, current });
}
