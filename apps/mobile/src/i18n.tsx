import { useLocales } from "expo-localization";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createT, pickLocale, type Locale, type TFunction } from "./lib/i18n";
import { kv } from "./storage";

const PREF_KEY = "forge.locale";
type Pref = Locale | "system";

interface I18nValue {
  locale: Locale;
  pref: Pref;
  setPref(p: Pref): void;
  t: TFunction;
}

const Ctx = createContext<I18nValue | null>(null);

/** Device language by default (expo-localization), overridable in Settings and persisted. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const deviceLocales = useLocales();
  const [pref, setPrefState] = useState<Pref>("system");
  useEffect(() => {
    void kv.getItem(PREF_KEY).then((v) => {
      if (v === "sv" || v === "en" || v === "system") setPrefState(v);
    });
  }, []);
  const setPref = useCallback((p: Pref) => {
    setPrefState(p);
    void kv.setItem(PREF_KEY, p);
  }, []);
  const locale: Locale = pref === "system" ? pickLocale(deviceLocales.map((l) => l.languageTag)) : pref;
  const value = useMemo(() => ({ locale, pref, setPref, t: createT(locale) }), [locale, pref, setPref]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}

export function useT(): TFunction {
  return useI18n().t;
}
