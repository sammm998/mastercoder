import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { KitBody, KitProviders, kitHtmlLang } from "@/kit/slots";
import { site } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.name, template: `%s · ${site.name}` },
  description: site.description,
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf7" },
    { media: "(prefers-color-scheme: dark)", color: "#101014" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await kitHtmlLang();
  const year = new Date().getFullYear();
  return (
    <html lang={lang}>
      <body>
        <KitProviders>
          <a className="skip-link" href="#main">
            Skip to content
          </a>
          <header className="site-header">
            <nav className="container" aria-label="Main">
              <Link className="brand" href="/">
                {site.name}
              </Link>
            </nav>
          </header>
          <main id="main" tabIndex={-1}>
            {children}
          </main>
          <footer className="site-footer">
            <div className="container">
              <p>
                © {year} {site.name}
              </p>
            </div>
          </footer>
          <KitBody />
        </KitProviders>
      </body>
    </html>
  );
}
