/** Plausible-compatible pageview event (https://plausible.io/docs/events-api). */
export interface PageviewEvent {
  name: "pageview";
  url: string;
  domain: string;
  referrer: string | null;
}

const KEEP_PARAMS = /^(utm_(source|medium|campaign|term|content)|ref|source)$/;

/** Event for the current page with all query parameters dropped except campaign tags. */
export function buildPageview(href: string, referrer: string, domain: string): PageviewEvent {
  const u = new URL(href);
  const kept = new URLSearchParams();
  u.searchParams.forEach((v, k) => {
    if (KEEP_PARAMS.test(k)) kept.set(k, v);
  });
  u.search = kept.toString();
  u.hash = "";
  return { name: "pageview", url: u.toString(), domain, referrer: referrerOrigin(referrer, u.host) };
}

/** External referrer reduced to its origin (no paths or queries); null for same-site or none. */
function referrerOrigin(referrer: string, host: string): string | null {
  if (!referrer) return null;
  try {
    const r = new URL(referrer);
    return r.host !== host ? r.origin : null;
  } catch {
    return null;
  }
}

/** True when the visitor asked not to be tracked (DNT or Global Privacy Control). */
export function trackingOptOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack === "1" || nav.globalPrivacyControl === true;
}

export function sendPageview(endpoint: string, event: PageviewEvent): void {
  if (trackingOptOut()) return;
  const body = JSON.stringify(event);
  // text/plain keeps this a "simple" request: no CORS preflight, no cookies.
  const sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain" }));
  if (!sent) void fetch(endpoint, { method: "POST", body, keepalive: true, credentials: "omit", headers: { "Content-Type": "text/plain" } }).catch(() => undefined);
}
