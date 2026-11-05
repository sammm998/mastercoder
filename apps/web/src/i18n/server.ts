import "server-only";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, negotiateLocale, type Locale } from "./config";
import { getMessages } from "./messages";
import { createTranslator, type Translate } from "./translate";

export async function getLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return negotiateLocale(c.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
}

export async function getT(): Promise<{ t: Translate; locale: Locale }> {
  const locale = await getLocale();
  return { t: createTranslator(getMessages(locale), locale), locale };
}
