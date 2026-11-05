"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "./config";
import { createTranslator, type Messages, type Translate } from "./translate";
import { preferenceCookie } from "../lib/consent";

interface I18nValue {
  locale: Locale;
  messages: Partial<Messages>;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

/** Provides translations to client components. Nested providers merge extra namespaces. */
export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Partial<Messages>; children: ReactNode }) {
  const parent = useContext(I18nContext);
  const value = useMemo<I18nValue>(() => {
    const merged = { ...(parent?.messages ?? {}), ...messages };
    return { locale, messages: merged, t: createTranslator(merged, locale) };
  }, [locale, messages, parent]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error("useT must be used inside <I18nProvider>");
  return v;
}

export function useT(): Translate {
  return useI18n().t;
}

export function useLocale(): Locale {
  return useI18n().locale;
}

/** Persist the locale in a cookie (1 year) and re-render server components in the new language. */
export function useSetLocale(): (locale: Locale) => void {
  const router = useRouter();
  return useCallback(
    (locale: Locale) => {
      document.cookie = preferenceCookie(LOCALE_COOKIE, locale);
      document.documentElement.lang = locale;
      router.refresh();
    },
    [router],
  );
}
