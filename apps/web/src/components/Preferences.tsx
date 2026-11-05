"use client";

import { useState } from "react";
import { useLocale, useSetLocale, useT } from "@/i18n/client";
import { LOCALES, type Locale } from "@/i18n/config";
import { applyTheme, parseTheme, THEME_COOKIE, type Theme } from "@/lib/theme";
import { readCookie } from "@/lib/consent";

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

const ICONS: Record<Theme, string> = {
  system: "M12 3a9 9 0 1 0 0 18V3z",
  light: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  dark: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
};

export function ThemeToggle({ initial }: { initial?: Theme }) {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(() => initial ?? (typeof document === "undefined" ? "system" : parseTheme(readCookie(THEME_COOKIE))));
  const order: Theme[] = ["system", "light", "dark"];
  const next = order[(order.indexOf(theme) + 1) % order.length]!;
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      aria-label={t("common.theme.toggle", { theme: t(`common.theme.${theme}`) })}
      title={t("common.theme.toggle", { theme: t(`common.theme.${theme}`) })}
      data-testid="theme-toggle"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill={theme === "light" ? "none" : "currentColor"} stroke="currentColor" strokeWidth={theme === "light" ? 1.8 : 0} strokeLinecap="round" aria-hidden="true">
        <path d={ICONS[theme]} />
        {theme === "system" && <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />}
      </svg>
    </button>
  );
}
