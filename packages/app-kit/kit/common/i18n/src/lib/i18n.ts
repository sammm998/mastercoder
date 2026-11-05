/**
 * Swedish/English i18n. Add keys to both dictionaries; `t()` falls back to English, then the key.
 * Placeholders use {name} syntax: t("sv", "greeting", { name: "Ada" }).
 */
export const LOCALES = ["en", "sv"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const en = {
  "common.skipToContent": "Skip to content",
  "common.loading": "Loading…",
  "common.error": "Something went wrong. Please try again.",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "auth.signIn": "Sign in",
  "auth.signOut": "Sign out",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.magicLink": "Email me a sign-in link",
  "auth.magicLinkSent": "Check your inbox for a sign-in link.",
  "auth.continueWithGoogle": "Continue with Google",
  "auth.continueWithMicrosoft": "Continue with Microsoft",
  "consent.title": "Cookies and privacy",
  "consent.body": "We use essential cookies to run this site. With your permission we also use analytics and marketing cookies.",
  "consent.acceptAll": "Accept all",
  "consent.rejectAll": "Only essential",
  "consent.settings": "Choose",
  "consent.save": "Save choices",
  "consent.analytics": "Analytics",
  "consent.marketing": "Marketing",
  greeting: "Hello, {name}!",
} as const;

export type MessageKey = keyof typeof en;

const sv: Record<MessageKey, string> = {
  "common.skipToContent": "Hoppa till innehållet",
  "common.loading": "Laddar…",
  "common.error": "Något gick fel. Försök igen.",
  "common.save": "Spara",
  "common.cancel": "Avbryt",
  "auth.signIn": "Logga in",
  "auth.signOut": "Logga ut",
  "auth.email": "E-post",
  "auth.password": "Lösenord",
  "auth.magicLink": "Skicka en inloggningslänk",
  "auth.magicLinkSent": "Kolla din inkorg efter en inloggningslänk.",
  "auth.continueWithGoogle": "Fortsätt med Google",
  "auth.continueWithMicrosoft": "Fortsätt med Microsoft",
  "consent.title": "Kakor och integritet",
  "consent.body": "Vi använder nödvändiga kakor för att driva webbplatsen. Med ditt godkännande använder vi även kakor för statistik och marknadsföring.",
  "consent.acceptAll": "Godkänn alla",
  "consent.rejectAll": "Endast nödvändiga",
  "consent.settings": "Välj",
  "consent.save": "Spara val",
  "consent.analytics": "Statistik",
  "consent.marketing": "Marknadsföring",
  greeting: "Hej, {name}!",
};

export const messages: Record<Locale, Record<MessageKey, string>> = { en, sv };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

export function t(locale: Locale, key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = messages[locale][key] ?? messages.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Best supported locale for an Accept-Language header (or navigator.languages joined by ","). */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag = "", ...rest] = part.trim().split(";");
      const q = Number(rest.find((r) => r.trim().startsWith("q="))?.split("=")[1] ?? 1);
      return { lang: tag.toLowerCase().split("-")[0] ?? "", q: Number.isFinite(q) ? q : 0 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { lang, q } of ranked) if (q > 0 && isLocale(lang)) return lang;
  return DEFAULT_LOCALE;
}

/** Locale-aware formatting helpers. */
export function formatDate(locale: Locale, date: Date, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  return new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", opts).format(date);
}

export function formatCurrency(locale: Locale, amount: number, currency = locale === "sv" ? "SEK" : "EUR"): string {
  return new Intl.NumberFormat(locale === "sv" ? "sv-SE" : "en-GB", { style: "currency", currency }).format(amount);
}
