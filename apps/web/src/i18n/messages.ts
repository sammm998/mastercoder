import en from "../../messages/en.json";
import sv from "../../messages/sv.json";
import type { Locale } from "./config";
import type { Messages } from "./translate";

const catalogs: Record<Locale, Messages> = { en, sv };

export function getMessages(locale: Locale): Messages {
  return catalogs[locale];
}
