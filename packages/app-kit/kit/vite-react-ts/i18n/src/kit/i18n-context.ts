import { createContext, useContext } from "react";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../lib/i18n";

export interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

export const I18nContext = createContext<I18nValue>({ locale: DEFAULT_LOCALE, setLocale: () => undefined, t: (k, p) => t(DEFAULT_LOCALE, k, p) });

/** `const { t, locale, setLocale } = useI18n();` */
export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
