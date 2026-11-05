import type { TemplateId } from "@forge/templates";

export const KIT_FEATURES = ["db", "email", "auth", "storage", "ai", "payments", "cron", "seo", "analytics", "cookie-consent", "i18n", "cms", "observability"] as const;
export type KitFeature = (typeof KIT_FEATURES)[number];

export interface EnvVarSpec {
  name: string;
  description: string;
  example?: string;
  /** Secrets are never shipped to the browser and never logged. */
  secret?: boolean;
}

/** Contributions a feature makes to the template's generated kit slot file. */
export interface SlotContribution {
  imports?: string[];
  /** JSX/markup rendered at the end of <body> (web) or statements run at startup (backends/mobile). */
  body?: string[];
  head?: string[];
  /** Provider wrapper, e.g. ["<I18nProvider>", "</I18nProvider>"]. */
  wrap?: [string, string];
  /** nextjs: expression (awaited) for <html lang>. */
  lang?: string;
}

export interface TemplateFeatureSpec {
  /** Kit source dirs (relative to kit/), copied in order; later dirs override earlier files. */
  dirs: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  /** Python requirement lines (fastapi). */
  requirements?: string[];
  env?: EnvVarSpec[];
  slot?: SlotContribution;
}

export interface FeatureSpec {
  description: string;
  requires?: KitFeature[];
  templates: Partial<Record<TemplateId, TemplateFeatureSpec | "builtin">>;
}

// Versions: `npm view <pkg> version` on 2026-11-05.
const V = {
  betterAuth: "^1.7.17",
  drizzleOrm: "^0.45.4",
  drizzleKit: "^0.31.11",
  postgres: "^4.0.0",
  awsS3: "^3.1162.0",
  stripe: "^23.1.0",
  nodemailer: "^10.3.1",
  serverOnly: "^0.0.1",
  zod: "^4.6.7",
};

const AI_ENV: EnvVarSpec[] = [
  { name: "FORGE_AI_GATEWAY_URL", description: "Forge AI gateway base URL (server-side only)", example: "https://ai.forge.eu" },
  { name: "FORGE_PROJECT_TOKEN", description: "Project token for the Forge AI gateway and error ingest (server-side only)", secret: true },
];
const DB_ENV: EnvVarSpec[] = [
  { name: "DATABASE_URL", description: "Postgres URL for a role WITHOUT superuser/BYPASSRLS so row-level security applies", example: "postgres://app:app@localhost:5432/app", secret: true },
  { name: "DATABASE_MIGRATION_URL", description: "Owner role used by drizzle-kit migrations (defaults to DATABASE_URL)", secret: true },
];
const EMAIL_ENV: EnvVarSpec[] = [
  { name: "EMAIL_PROVIDER", description: "smtp | resend | postmark", example: "smtp" },
  { name: "EMAIL_FROM", description: "Sender address", example: "App <hello@example.eu>" },
  { name: "SMTP_URL", description: "SMTP connection URL (EMAIL_PROVIDER=smtp)", example: "smtp://localhost:1025", secret: true },
  { name: "RESEND_API_KEY", description: "Resend API key (EMAIL_PROVIDER=resend)", secret: true },
  { name: "POSTMARK_SERVER_TOKEN", description: "Postmark server token (EMAIL_PROVIDER=postmark)", secret: true },
];
const AUTH_ENV: EnvVarSpec[] = [
  { name: "BETTER_AUTH_SECRET", description: "32+ random characters used to sign sessions", secret: true },
  { name: "BETTER_AUTH_URL", description: "Public base URL of the app", example: "http://localhost:3000" },
  { name: "GOOGLE_CLIENT_ID", description: "Google OAuth client id (optional)" },
  { name: "GOOGLE_CLIENT_SECRET", description: "Google OAuth client secret (optional)", secret: true },
  { name: "MICROSOFT_CLIENT_ID", description: "Microsoft Entra ID app id (optional)" },
  { name: "MICROSOFT_CLIENT_SECRET", description: "Microsoft Entra ID client secret (optional)", secret: true },
  { name: "MICROSOFT_TENANT_ID", description: "Entra tenant: common | organizations | <tenant id>", example: "common" },
];
const STORAGE_ENV: EnvVarSpec[] = [
  { name: "S3_ENDPOINT", description: "S3-compatible endpoint (empty for AWS)", example: "http://localhost:9000" },
  { name: "S3_REGION", description: "Bucket region (EU)", example: "eu-central-1" },
  { name: "S3_BUCKET", description: "Bucket name", example: "uploads" },
  { name: "S3_ACCESS_KEY_ID", description: "Access key", secret: true },
  { name: "S3_SECRET_ACCESS_KEY", description: "Secret key", secret: true },
  { name: "S3_FORCE_PATH_STYLE", description: "true for MinIO/SeaweedFS", example: "true" },
];
const PAY_ENV: EnvVarSpec[] = [
  { name: "STRIPE_SECRET_KEY", description: "Stripe secret key", secret: true },
  { name: "STRIPE_WEBHOOK_SECRET", description: "Signing secret of the Stripe webhook endpoint", secret: true },
];
const PRICE_ENV: EnvVarSpec = { name: "STRIPE_PRICE_IDS", description: "Comma-separated Stripe price ids checkout may use (empty = any price of the account)" };
const CHECKOUT_URL_ENV: EnvVarSpec[] = [
  { name: "CHECKOUT_SUCCESS_URL", description: "Where Stripe redirects after payment", example: "https://example.eu/thanks?session_id={CHECKOUT_SESSION_ID}" },
  { name: "CHECKOUT_CANCEL_URL", description: "Where Stripe redirects when the buyer cancels", example: "https://example.eu/" },
];
const CRON_ENV: EnvVarSpec[] = [{ name: "CRON_SECRET", description: "Shared secret the Forge scheduler sends as Bearer token", secret: true }];
const OBS_SERVER_ENV: EnvVarSpec[] = [
  { name: "FORGE_ERROR_INGEST_URL", description: "Forge error ingest endpoint", example: "https://errors.forge.eu/v1/events" },
  { name: "FORGE_PROJECT_TOKEN", description: "Project token (server-side only)", secret: true },
  { name: "APP_RELEASE", description: "Release/version tag attached to error events", example: "0.1.0" },
];

export const FEATURES: Record<KitFeature, FeatureSpec> = {
  db: {
    description: "Drizzle ORM + Postgres, migrations dir, RLS owner-policy helper, withUser() per-transaction user",
    templates: {
      nextjs: { dirs: ["common/db", "nextjs/db"], dependencies: { "drizzle-orm": V.drizzleOrm, postgres: V.postgres }, devDependencies: { "drizzle-kit": V.drizzleKit }, scripts: { "db:generate": "drizzle-kit generate", "db:migrate": "drizzle-kit migrate" }, env: DB_ENV },
      "hono-api": { dirs: ["common/db", "hono-api/db"], dependencies: { "drizzle-orm": V.drizzleOrm, postgres: V.postgres }, devDependencies: { "drizzle-kit": V.drizzleKit }, scripts: { "db:generate": "drizzle-kit generate", "db:migrate": "drizzle-kit migrate" }, env: DB_ENV },
    },
  },
  email: {
    description: "Transactional email behind one interface: SMTP, Resend, Postmark",
    templates: {
      nextjs: { dirs: ["common/email"], dependencies: { nodemailer: V.nodemailer, "server-only": V.serverOnly }, env: EMAIL_ENV },
      "hono-api": { dirs: ["common/email"], dependencies: { nodemailer: V.nodemailer }, env: EMAIL_ENV },
    },
  },
  auth: {
    description: "Better Auth: email+password, magic link, Google, Microsoft",
    requires: ["db", "email"],
    templates: {
      nextjs: { dirs: ["common/auth", "nextjs/auth"], dependencies: { "better-auth": V.betterAuth }, env: AUTH_ENV },
      "hono-api": { dirs: ["common/auth", "hono-api/auth"], dependencies: { "better-auth": V.betterAuth }, env: AUTH_ENV, slot: { imports: ['import { mountAuth } from "./auth-routes.js";'], body: ["mountAuth(app);"] } },
    },
  },
  storage: {
    description: "S3-compatible object storage client (upload, download, presigned URLs)",
    templates: {
      nextjs: { dirs: ["common/storage"], dependencies: { "@aws-sdk/client-s3": V.awsS3, "@aws-sdk/s3-request-presigner": V.awsS3, "server-only": V.serverOnly }, env: STORAGE_ENV },
      "hono-api": { dirs: ["common/storage"], dependencies: { "@aws-sdk/client-s3": V.awsS3, "@aws-sdk/s3-request-presigner": V.awsS3 }, env: STORAGE_ENV },
    },
  },
  ai: {
    description: "Forge AI gateway client: chat, image, speech-to-text, text-to-speech (server-side only)",
    templates: {
      nextjs: { dirs: ["common/ai"], dependencies: { "server-only": V.serverOnly }, env: AI_ENV },
      "hono-api": { dirs: ["common/ai"], env: AI_ENV },
      fastapi: { dirs: ["fastapi/ai"], requirements: ["httpx==0.28.1"], env: AI_ENV },
    },
  },
  payments: {
    description: "Stripe Checkout + signature-verified webhook",
    templates: {
      nextjs: { dirs: ["common/payments", "nextjs/payments"], dependencies: { stripe: V.stripe, zod: V.zod, "server-only": V.serverOnly }, env: [...PAY_ENV, PRICE_ENV] },
      "hono-api": { dirs: ["common/payments", "hono-api/payments"], dependencies: { stripe: V.stripe }, env: [...PAY_ENV, PRICE_ENV, ...CHECKOUT_URL_ENV], slot: { imports: ['import { mountPayments } from "./payments-routes.js";'], body: ["mountPayments(app);"] } },
    },
  },
  cron: {
    description: "Scheduled jobs: forge.json crons + handler route protected by CRON_SECRET",
    templates: {
      nextjs: { dirs: ["common/cron", "nextjs/cron"], env: CRON_ENV },
      "hono-api": { dirs: ["common/cron", "hono-api/cron"], env: CRON_ENV, slot: { imports: ['import { mountCron } from "./cron-routes.js";'], body: ["mountCron(app);"] } },
      fastapi: { dirs: ["fastapi/cron"], env: CRON_ENV, slot: { imports: ["from app.kit.cron import router as cron_router"], body: ["app.include_router(cron_router)"] } },
    },
  },
  seo: {
    description: "Metadata helpers, sitemap.xml, robots.txt, Open Graph, JSON-LD",
    templates: {
      nextjs: { dirs: ["nextjs/seo"], env: [{ name: "NEXT_PUBLIC_SITE_URL", description: "Public origin for canonical URLs and the sitemap", example: "https://example.eu" }] },
      "vite-react-ts": { dirs: ["vite-react-ts/seo"] },
      "astro-site": "builtin",
    },
  },
  analytics: {
    description: "Cookieless, privacy-friendly pageview beacon (Forge or Plausible-compatible endpoint)",
    templates: {
      nextjs: {
        dirs: ["common/analytics-core", "nextjs/analytics"],
        env: [
          { name: "NEXT_PUBLIC_ANALYTICS_ENDPOINT", description: "Plausible-compatible event endpoint", example: "https://analytics.forge.eu/api/event" },
          { name: "NEXT_PUBLIC_ANALYTICS_DOMAIN", description: "Site domain as registered with the analytics service", example: "example.eu" },
        ],
        slot: { imports: ['import { Analytics } from "./analytics";'], body: ["<Analytics />"] },
      },
      "vite-react-ts": {
        dirs: ["common/analytics-core", "vite-react-ts/analytics"],
        env: [
          { name: "VITE_ANALYTICS_ENDPOINT", description: "Plausible-compatible event endpoint", example: "https://analytics.forge.eu/api/event" },
          { name: "VITE_ANALYTICS_DOMAIN", description: "Site domain", example: "example.eu" },
        ],
        slot: { imports: ['import { Analytics } from "./analytics";'], body: ["<Analytics />"] },
      },
      "astro-site": {
        dirs: ["common/analytics-core", "astro-site/analytics"],
        env: [
          { name: "PUBLIC_ANALYTICS_ENDPOINT", description: "Plausible-compatible event endpoint", example: "https://analytics.forge.eu/api/event" },
          { name: "PUBLIC_ANALYTICS_DOMAIN", description: "Site domain", example: "example.eu" },
        ],
        slot: { imports: ['import Analytics from "./Analytics.astro";'], body: ["<Analytics />"] },
      },
    },
  },
  "cookie-consent": {
    description: "Accessible consent banner; non-essential scripts stay blocked until accepted",
    templates: {
      nextjs: { dirs: ["common/consent-core", "common/cookie-consent-react", "nextjs/cookie-consent"], slot: { imports: ['import { CookieConsent } from "./cookie-consent";'], body: ["<CookieConsent />"] } },
      "vite-react-ts": { dirs: ["common/consent-core", "common/cookie-consent-react"], slot: { imports: ['import { CookieConsent } from "./cookie-consent";'], body: ["<CookieConsent />"] } },
      "astro-site": { dirs: ["common/consent-core", "astro-site/cookie-consent"], slot: { imports: ['import CookieConsent from "./CookieConsent.astro";'], body: ["<CookieConsent />"] } },
    },
  },
  i18n: {
    description: "Swedish/English messages, locale negotiation and t()",
    templates: {
      nextjs: { dirs: ["common/i18n", "nextjs/i18n"], slot: { imports: ['import { getLocale } from "@/lib/i18n-server";'], lang: "getLocale()" } },
      "hono-api": { dirs: ["common/i18n"] },
      "vite-react-ts": { dirs: ["common/i18n", "vite-react-ts/i18n"], slot: { imports: ['import { I18nProvider } from "./i18n-provider";'], wrap: ["<I18nProvider>", "</I18nProvider>"] } },
      expo: { dirs: ["common/i18n"] },
    },
  },
  cms: {
    description: "JSON content model + auth-protected /admin editor so non-developers edit site content",
    requires: ["auth", "db"],
    templates: {
      nextjs: { dirs: ["nextjs/cms"], dependencies: { zod: V.zod }, env: [{ name: "CMS_ADMIN_EMAILS", description: "Comma-separated emails allowed to edit content at /admin", example: "editor@example.eu" }] },
    },
  },
  observability: {
    description: "Error reporting to FORGE_ERROR_INGEST_URL (Sentry-style events), server + browser",
    templates: {
      nextjs: { dirs: ["common/observability", "nextjs/observability"], dependencies: { "server-only": V.serverOnly, zod: V.zod }, env: OBS_SERVER_ENV, slot: { imports: ['import { ClientErrorListener } from "./client-error-listener";'], body: ["<ClientErrorListener />"] } },
      "hono-api": { dirs: ["common/observability", "hono-api/observability"], env: OBS_SERVER_ENV, slot: { imports: ['import { mountObservability } from "./observability-routes.js";'], body: ["mountObservability(app);"] } },
      "vite-react-ts": {
        dirs: ["vite-react-ts/observability"],
        env: [
          { name: "VITE_FORGE_ERROR_INGEST_URL", description: "Forge error ingest endpoint", example: "https://errors.forge.eu/v1/events" },
          { name: "VITE_FORGE_ERROR_KEY", description: "Public, ingest-only project key (safe in the browser)" },
        ],
        slot: { imports: ['import { ErrorReporter } from "./error-reporter";'], body: ["<ErrorReporter />"] },
      },
      expo: {
        dirs: ["expo/observability"],
        env: [
          { name: "EXPO_PUBLIC_FORGE_ERROR_INGEST_URL", description: "Forge error ingest endpoint", example: "https://errors.forge.eu/v1/events" },
          { name: "EXPO_PUBLIC_FORGE_ERROR_KEY", description: "Public, ingest-only project key" },
        ],
        slot: { imports: ['import { installErrorReporter } from "../lib/observability";'], body: ["installErrorReporter();"] },
      },
      fastapi: { dirs: ["fastapi/observability"], requirements: ["httpx==0.28.1"], env: OBS_SERVER_ENV, slot: { imports: ["from app.kit.observability import install_error_reporting"], body: ["install_error_reporting(app)"] } },
    },
  },
};

/** Which features a template supports ("builtin" = already part of the template). */
export function kitSupport(templateId: TemplateId): Record<KitFeature, "supported" | "builtin" | "unsupported"> {
  const out = {} as Record<KitFeature, "supported" | "builtin" | "unsupported">;
  for (const f of KIT_FEATURES) {
    const t = FEATURES[f].templates[templateId];
    out[f] = t === "builtin" ? "builtin" : t ? "supported" : "unsupported";
  }
  return out;
}

/** Add required features (transitively) and return them in canonical order. */
export function resolveFeatures(features: readonly KitFeature[]): KitFeature[] {
  const set = new Set<KitFeature>();
  const visit = (f: KitFeature) => {
    if (set.has(f)) return;
    set.add(f);
    for (const r of FEATURES[f].requires ?? []) visit(r);
  };
  features.forEach(visit);
  return KIT_FEATURES.filter((f) => set.has(f));
}
