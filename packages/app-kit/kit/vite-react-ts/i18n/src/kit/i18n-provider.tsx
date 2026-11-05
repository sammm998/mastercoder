import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { isLocale, negotiateLocale, t, type Locale } from "../lib/i18n";
import { I18nContext } from "./i18n-context";

const STORAGE_KEY = "locale";

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // storage blocked
  }
  return negotiateLocale(navigator.languages?.join(",") ?? navigator.language);
}

/** Provides locale + t() and keeps <html lang> in sync. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // storage blocked: keep it for this session only
    }
    setLocaleState(l);
  }, []);
  const value = useMemo(() => ({ locale, setLocale, t: (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => t(locale, key, params) }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
