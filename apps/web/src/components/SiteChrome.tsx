import Link from "next/link";
import { getT } from "@/i18n/server";
import { Wordmark } from "./Logo";
import { LocaleSwitcher, ThemeToggle } from "./Preferences";

/** Marketing/auth top bar: brand left, a pill-shaped glass nav in the middle, preferences + CTA right. */
export async function TopBar({ minimal = false }: { minimal?: boolean }) {
  const { t } = await getT();
  return (
    <header className={`topbar${minimal ? " topbar-minimal" : ""}`}>
      <div className="container topbar-inner">
        <Wordmark label={t("common.home")} />
        {!minimal && (
          <nav className="topnav-pill" aria-label={t("nav.primary")}>
            <a href="/#make">{t("nav.make")}</a>
            <a href="/#why">{t("nav.why")}</a>
            <a href="/#crew">{t("nav.crew")}</a>
            <a href="/#how">{t("nav.how")}</a>
            <a href="/#pricing">{t("nav.pricing")}</a>
          </nav>
        )}
        <div className="topnav">
          <LocaleSwitcher />
          <ThemeToggle />
          {!minimal && (
            <>
              <Link href="/login" className="hide-sm">
                {t("nav.login")}
              </Link>
              <Link href="/signup" className="btn btn-primary btn-sm">
                {t("nav.start")}
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export async function Footer() {
  const { t } = await getT();
  return (
    <footer className="footer">
      <div className="container footer-grid">
        <div className="stack">
          <Wordmark label={t("common.home")} />
          <p style={{ maxWidth: 340 }}>{t("footer.tagline")}</p>
          <p className="eyebrow">{t("footer.region")}</p>
        </div>
        <div>
          <h2>{t("footer.product")}</h2>
          <ul>
            <li>
              <a href="/#make">{t("nav.make")}</a>
            </li>
            <li>
              <a href="/#why">{t("nav.why")}</a>
            </li>
            <li>
              <a href="/#how">{t("nav.how")}</a>
            </li>
            <li>
              <a href="/#pricing">{t("nav.pricing")}</a>
            </li>
          </ul>
        </div>
        <div>
          <h2>{t("footer.account")}</h2>
          <ul>
            <li>
              <Link href="/signup">{t("nav.start")}</Link>
            </li>
            <li>
              <Link href="/login">{t("nav.login")}</Link>
            </li>
          </ul>
        </div>
        <div>
          <h2>{t("footer.legal")}</h2>
          <ul>
            <li>
              <Link href="/legal/terms">{t("legal.terms.title")}</Link>
            </li>
            <li>
              <Link href="/legal/privacy">{t("legal.privacy.title")}</Link>
            </li>
            <li>
              <Link href="/legal/dpa">{t("legal.dpa.title")}</Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="container">
        <div className="footer-bottom">
          <p>{t("footer.copyright", { year: String(new Date().getFullYear()) })}</p>
          <p>{t("footer.madeIn")}</p>
        </div>
      </div>
    </footer>
  );
}
