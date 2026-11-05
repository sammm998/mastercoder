"use client";

import { useEffect, useState } from "react";
import { useLocale, useSetLocale, useT } from "@/i18n/client";
import { LOCALES, type Locale } from "@/i18n/config";
import { applyTheme, effectiveTheme } from "@/lib/theme";

export function LocaleSwitcher() {
  const t = useT();
  const locale = useLocale();
  const setLocale = useSetLocale();
  return (
    <div className="seg" role="group" aria-label={t("common.language")} data-testid="locale-switcher">
      {LOCALES.map((l: Locale) => (
        <button key={l} type="button" aria-pressed={l === locale} lang={l} onClick={() => l !== locale && setLocale(l)} title={t(`common.languages.${l}`)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/**
 * Light/dark switch. The server renders data-theme from the cookie (or nothing → the OS preference), and
 * both icons are in the markup with CSS showing the right one, so there is no flash or hydration mismatch.
 * Clicking stores an explicit choice in the theme cookie.
 */
export function ThemeToggle({ tipSide }: { tipSide?: "right" }) {
  const t = useT();
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    setDark(effectiveTheme() === "dark");
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => setDark(effectiveTheme() === "dark");
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const label = dark === false ? t("common.theme.toDark") : t("common.theme.toLight");
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm theme-toggle"
      onClick={() => {
        const next = effectiveTheme() === "dark" ? "light" : "dark";
        applyTheme(next);
        setDark(next === "dark");
      }}
      aria-label={label}
      data-tip={label}
      data-tip-side={tipSide}
      data-testid="theme-toggle"
    >
      <svg className="icon-moon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
      <svg className="icon-sun" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    </button>
  );
}
