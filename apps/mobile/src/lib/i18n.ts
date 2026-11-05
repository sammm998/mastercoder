import en from "../i18n/en.json";
import sv from "../i18n/sv.json";

/**
 * Tiny typed i18n: nested JSON catalogs (src/i18n/{en,sv}.json), dotted keys, `{name}` interpolation and
 * plural objects `{ "one": "…", "other": "…" }` selected with Intl.PluralRules on `count`.
 */

export type Locale = "en" | "sv";
export const LOCALES: readonly Locale[] = ["sv", "en"];

type Plural = { one: string; other: string };
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : T[K] extends Plural ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type Messages = typeof en;
export type TKey = Leaves<Messages>;
export type TParams = Record<string, string | number>;

export const catalogs: Record<Locale, Messages> = { en, sv: sv as Messages };

/** First supported language among the device's preferred locales (BCP-47 tags), default English. */
export function pickLocale(tags: ReadonlyArray<string | null | undefined>): Locale {
  for (const t of tags) {
    const lang = (t ?? "").toLowerCase().split(/[-_]/)[0];
    if (lang === "sv") return "sv";
    if (lang === "en") return "en";
  }
  return "en";
}

function lookup(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function isPlural(v: unknown): v is Plural {
  return !!v && typeof v === "object" && typeof (v as Plural).other === "string";
}

export function interpolate(s: string, params?: TParams): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

const pluralRules: Record<Locale, Intl.PluralRules> = { en: new Intl.PluralRules("en"), sv: new Intl.PluralRules("sv") };

/** Translate `key` in `locale`, falling back to English, then to the key itself (visible, never blank). */
export function translate(locale: Locale, key: TKey | string, params?: TParams): string {
  let v = lookup(catalogs[locale], key);
  if (v === undefined) v = lookup(catalogs.en, key);
  if (typeof v === "string") return interpolate(v, params);
  if (isPlural(v)) {
    const count = Number(params?.count ?? 0);
    const form = pluralRules[locale].select(count) === "one" ? v.one : v.other;
    return interpolate(form, params);
  }
  return key;
}

export function createT(locale: Locale) {
  return (key: TKey, params?: TParams) => translate(locale, key, params);
}
export type TFunction = ReturnType<typeof createT>;

/** Every leaf key of a catalog (plural objects count as one leaf). Used by the parity test. */
export function leafKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj === "string" || isPlural(obj)) return [prefix];
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

/** `{placeholders}` used in a string or plural object. */
export function placeholders(v: unknown): string[] {
  const strings = typeof v === "string" ? [v] : isPlural(v) ? [v.one, v.other] : [];
  return [...new Set(strings.flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string)))].sort();
}

export function rawValue(locale: Locale, key: string): unknown {
  return lookup(catalogs[locale], key);
}
