import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { ViewTransition, type ReactNode } from "react";
import "../styles/globals.css";
import { fraunces, interTight, jetbrainsMono } from "./fonts";
import { getLocale } from "@/i18n/server";
import { getMessages } from "@/i18n/messages";
import { createTranslator, pick } from "@/i18n/translate";
import { I18nProvider } from "@/i18n/client";
import { CookieBanner } from "@/components/CookieBanner";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const t = createTranslator(getMessages(locale), locale);
  return {
    title: { default: t("meta.title"), template: `%s — Forge` },
    description: t("meta.description"),
    icons: { icon: "/favicon.svg" },
    applicationName: "Forge",
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3eee5" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0e0c" },
  ],
  width: "device-width",
  initialScale: 1,
};

/** Namespaces every page needs on the client; app pages add the rest in app/app/layout.tsx. */
const ROOT_NAMESPACES = ["common", "nav", "cookie", "errors", "auth"] as const;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const messages = getMessages(locale);
  const t = createTranslator(messages, locale);
  return (
    <html lang={locale} data-theme={theme === "system" ? undefined : theme} className={`${fraunces.variable} ${interTight.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body>
        <a href="#main" className="skip-link">
          {t("common.skipToContent")}
        </a>
        <I18nProvider locale={locale} messages={pick(messages, ROOT_NAMESPACES)}>
          <ViewTransition default="page">{children}</ViewTransition>
          <CookieBanner />
        </I18nProvider>
        <div className="grain" aria-hidden="true" />
      </body>
    </html>
  );
}
