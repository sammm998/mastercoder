import "server-only";
import { cookies, headers } from "next/headers";
import { isLocale, negotiateLocale, t, type Locale, type MessageKey } from "@/lib/i18n";

export const LOCALE_COOKIE = "locale";

/** Locale from the `locale` cookie, else negotiated from Accept-Language. Makes the route dynamic. */
export async function getLocale(): Promise<Locale> {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  return negotiateLocale((await headers()).get("accept-language"));
}

/** Translator bound to the request's locale, for server components. */
export async function getT(): Promise<(key: MessageKey, params?: Record<string, string | number>) => string> {
  const locale = await getLocale();
  return (key, params) => t(locale, key, params);
}
