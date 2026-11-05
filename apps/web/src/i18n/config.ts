export const LOCALES = ["en", "sv"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "forge_locale";

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/**
 * Pick a locale: explicit cookie first, then the best Accept-Language match (q-values honoured),
 * then the default. `sv-SE`, `sv` and `sv-FI` all map to Swedish.
 */
export function negotiateLocale(cookie: string | undefined | null, acceptLanguage: string | undefined | null): Locale {
  if (isLocale(cookie)) return cookie;
  if (acceptLanguage) {
    const ranked = acceptLanguage
      .split(",")
      .map((part, i) => {
        const [tag = "", ...params] = part.trim().split(";");
        const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
        const quality = q ? Number(q.slice(2)) : 1;
        return { base: tag.toLowerCase().split("-")[0] ?? "", quality: Number.isFinite(quality) ? quality : 0, i };
      })
      .filter((r) => r.quality > 0)
      .sort((a, b) => b.quality - a.quality || a.i - b.i);
    for (const r of ranked) if (isLocale(r.base)) return r.base;
  }
  return DEFAULT_LOCALE;
}
