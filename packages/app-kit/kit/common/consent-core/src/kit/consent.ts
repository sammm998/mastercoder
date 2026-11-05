/**
 * Cookie consent store (browser). The decision is kept in a first-party, essential cookie
 * `forge_consent` for 180 days. Non-essential scripts stay blocked until their category is granted:
 * mark them `<script type="text/plain" data-consent="analytics" data-src="...">` (or inline body)
 * and `activateConsentedScripts()` turns them into real scripts once allowed.
 */
export const CONSENT_COOKIE = "forge_consent";
export const CONSENT_VERSION = 1;
export const CONSENT_CATEGORIES = ["analytics", "marketing"] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export interface ConsentState {
  v: number;
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  /** ISO time of the decision. */
  at: string;
}

const listeners = new Set<() => void>();
let cached: ConsentState | null | undefined;

export function parseConsent(raw: string | undefined | null): ConsentState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<ConsentState>;
    if (v.v !== CONSENT_VERSION || typeof v.analytics !== "boolean" || typeof v.marketing !== "boolean") return null;
    return { v: CONSENT_VERSION, necessary: true, analytics: v.analytics, marketing: v.marketing, at: String(v.at ?? "") };
  } catch {
    return null;
  }
}

function readCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${CONSENT_COOKIE}=`))
    ?.slice(CONSENT_COOKIE.length + 1);
}

/** Current decision, or null when the visitor has not decided yet. */
export function getConsent(): ConsentState | null {
  if (cached === undefined) cached = parseConsent(readCookie());
  return cached;
}

export function hasConsent(category: ConsentCategory): boolean {
  return getConsent()?.[category] === true;
}

export function setConsent(choice: Record<ConsentCategory, boolean>): ConsentState {
  const state: ConsentState = { v: CONSENT_VERSION, necessary: true, analytics: choice.analytics, marketing: choice.marketing, at: new Date().toISOString() };
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(state))}; Max-Age=${60 * 60 * 24 * 180}; Path=/; SameSite=Lax${secure}`;
  cached = state;
  activateConsentedScripts();
  listeners.forEach((l) => l());
  return state;
}

/** Forget the decision so the banner shows again (e.g. from a "Cookie settings" link). */
export function resetConsent(): void {
  document.cookie = `${CONSENT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  cached = null;
  listeners.forEach((l) => l());
}

export function subscribeConsent(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Replace blocked `<script type="text/plain" data-consent=...>` tags whose category is granted. */
export function activateConsentedScripts(root: ParentNode = document): number {
  let n = 0;
  root.querySelectorAll<HTMLScriptElement>('script[type="text/plain"][data-consent]').forEach((blocked) => {
    const category = blocked.dataset.consent as ConsentCategory;
    if (!hasConsent(category)) return;
    const s = document.createElement("script");
    for (const attr of Array.from(blocked.attributes)) {
      if (attr.name === "type" || attr.name === "data-consent" || attr.name === "data-src") continue;
      s.setAttribute(attr.name, attr.value);
    }
    if (blocked.dataset.src) s.src = blocked.dataset.src;
    else s.textContent = blocked.textContent;
    blocked.replaceWith(s);
    n++;
  });
  return n;
}

export const CONSENT_TEXT = {
  en: {
    title: "Cookies and privacy",
    body: "We use essential cookies to run this site. With your permission we also use cookies for analytics and marketing. You can change your choice at any time.",
    acceptAll: "Accept all",
    rejectAll: "Only essential",
    choose: "Choose",
    save: "Save choices",
    analytics: "Analytics",
    marketing: "Marketing",
    necessary: "Essential (always on)",
  },
  sv: {
    title: "Kakor och integritet",
    body: "Vi använder nödvändiga kakor för att driva webbplatsen. Med ditt godkännande använder vi även kakor för statistik och marknadsföring. Du kan ändra ditt val när som helst.",
    acceptAll: "Godkänn alla",
    rejectAll: "Endast nödvändiga",
    choose: "Välj",
    save: "Spara val",
    analytics: "Statistik",
    marketing: "Marknadsföring",
    necessary: "Nödvändiga (alltid på)",
  },
} as const;

export function consentText(lang: string | undefined) {
  return lang?.toLowerCase().startsWith("sv") ? CONSENT_TEXT.sv : CONSENT_TEXT.en;
}
