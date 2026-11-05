import Link from "next/link";
import { getT } from "@/i18n/server";
import { Wordmark } from "./Logo";
import { LocaleSwitcher, ThemeToggle } from "./Preferences";

export async function TopBar({ minimal = false }: { minimal?: boolean }) {
  const { t } = await getT();
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <Wordmark label={t("common.home")} />
        <nav className="topnav" aria-label={t("nav.primary")}>
          {!minimal && (
            <>
              <a className="hide-sm" href="/#why">
                {t("nav.why")}
              </a>
              <a className="hide-sm" href="/#how">
                {t("nav.how")}
              </a>
              <a className="hide-sm" href="/#pricing">
                {t("nav.pricing")}
              </a>
            </>
          )}
          <LocaleSwitcher />
          <ThemeToggle />
          {!minimal && (
            <>
              <Link href="/login" className="hide-sm">
                {t("nav.login")}
              </Link>
              <Link href="/signup" className="btn btn-ink btn-sm">
                {t("nav.start")}
              </Link>
            </>
          )}
        </nav>
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
      <div className="container" style={{ marginTop: "var(--space-7)" }}>
        <p className="subtle" style={{ fontSize: "0.8rem" }}>
          {t("footer.copyright", { year: new Date().getFullYear() })}
        </p>
      </div>
    </footer>
  );
}
