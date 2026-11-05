import { isLocale } from "@/lib/i18n";
import { LOCALE_COOKIE } from "@/lib/i18n-server";

/** POST { locale: "sv" | "en" } → remembers the visitor's language for a year. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { locale?: unknown } | null;
  const locale = body?.locale;
  if (!isLocale(locale)) return Response.json({ error: "unsupported_locale" }, { status: 400 });
  const res = Response.json({ locale });
  res.headers.append("Set-Cookie", `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return res;
}
