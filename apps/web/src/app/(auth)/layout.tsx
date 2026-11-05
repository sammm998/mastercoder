import type { ReactNode } from "react";
import "@/styles/auth.css";
import { getT } from "@/i18n/server";
import { TRPCReactProvider } from "@/lib/trpc";
import { TopBar } from "@/components/SiteChrome";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = await getT();
  return (
    <TRPCReactProvider>
      <TopBar minimal />
      <main id="main" className="auth">
        <div className="auth-form">{children}</div>
        <aside className="auth-side" aria-hidden="true">
          <div className="auth-side-inner">
            <p className="auth-quote">{t("auth.sideQuote")}</p>
            <p className="eyebrow">{t("auth.sideFacts")}</p>
          </div>
        </aside>
      </main>
    </TRPCReactProvider>
  );
}
