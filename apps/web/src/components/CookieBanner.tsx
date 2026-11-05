"use client";

import { useEffect, useState } from "react";
import { useT } from "@/i18n/client";
import { CONSENT_COOKIE, readConsent, readCookie, type Consent } from "@/lib/consent";
import { LOCALE_COOKIE } from "@/i18n/config";
import { THEME_COOKIE } from "@/lib/theme";

/**
 * Forge sets only essential cookies (session, security, this choice). Remembering language and theme
 * across visits is optional and needs consent; there is no advertising or third-party tracking.
 */
export function CookieBanner() {
  const t = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Read after hydration so the server-rendered HTML is identical for everyone (no layout shift).
    const id = requestAnimationFrame(() => setOpen(readConsent() === undefined));
    return () => cancelAnimationFrame(id);
  }, []);
  if (!open) return null;

  const choose = (c: Consent) => {
    document.cookie = `${CONSENT_COOKIE}=${c}; path=/; max-age=${c === "all" ? 31536000 : 15552000}; samesite=lax`;
    if (c === "all") {
      // Upgrade any session preference cookies to persistent ones.
      for (const name of [LOCALE_COOKIE, THEME_COOKIE]) {
        const v = readCookie(name);
        if (v) document.cookie = `${name}=${encodeURIComponent(v)}; path=/; max-age=31536000; samesite=lax`;
      }
    }
    setOpen(false);
  };

  return (
    <section className="cookie-banner" role="region" aria-labelledby="cookie-title" data-testid="cookie-banner">
      <div>
        <h2 id="cookie-title" style={{ fontSize: "1.25rem", marginBottom: 6 }}>
          {t("cookie.title")}
        </h2>
        <p style={{ opacity: 0.85 }}>
          {t("cookie.body")} <a href="/legal/privacy#cookies">{t("cookie.learnMore")}</a>
        </p>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => choose("all")}>
          {t("cookie.acceptAll")}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => choose("essential")}>
          {t("cookie.essentialOnly")}
        </button>
      </div>
    </section>
  );
}
