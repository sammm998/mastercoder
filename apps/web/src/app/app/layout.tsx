import type { ReactNode } from "react";
import type { Metadata } from "next";
import "@/styles/app.css";
import { getT } from "@/i18n/server";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/client";
import { TRPCReactProvider } from "@/lib/trpc";
import { AppShell } from "./AppShell";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("nav.app"), robots: { index: false } };
}

/** Everything under /app is an authenticated client app; the shell gates on `auth.me`. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { locale } = await getT();
  return (
    <TRPCReactProvider>
      <I18nProvider locale={locale} messages={getMessages(locale)}>
        <AppShell>{children}</AppShell>
      </I18nProvider>
    </TRPCReactProvider>
  );
}
