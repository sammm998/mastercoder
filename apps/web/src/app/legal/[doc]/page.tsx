import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "@/styles/legal.css";
import { getT } from "@/i18n/server";
import { formatDate } from "@/i18n/format";
import type { MessageKey } from "@/i18n/translate";
import { TopBar, Footer } from "@/components/SiteChrome";

const DOCS = { terms: 10, privacy: 8, dpa: 7 } as const;
type Doc = keyof typeof DOCS;
const UPDATED = "2026-10-01";

function isDoc(v: string): v is Doc {
  return v in DOCS;
}

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  if (!isDoc(doc)) return {};
  const { t } = await getT();
  return { title: t(`legal.${doc}.title`), description: t(`legal.${doc}.intro`) };
}

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  if (!isDoc(doc)) notFound();
  const { t, locale } = await getT();
  const sections = Array.from({ length: DOCS[doc] }, (_, i) => i + 1);
  const key = (s: string) => `legal.${doc}.${s}` as MessageKey;
  return (
    <>
      <TopBar minimal />
      <main id="main" className="container legal">
        <header className="legal-head">
          <p className="eyebrow">{t("footer.legal")}</p>
          <h1>{t(key("title"))}</h1>
          <p className="subtle">{t("legal.updated", { date: formatDate(UPDATED, locale, false) })}</p>
          <p className="legal-intro">{t(key("intro"))}</p>
        </header>
        <div className="legal-body">
          <nav aria-label={t("legal.onThisPage")} className="legal-toc">
            <p className="eyebrow">{t("legal.onThisPage")}</p>
            <ol>
              {sections.map((n) => (
                <li key={n}>
                  <a href={`#s${n}`}>{t(key(`s${n}t`))}</a>
                </li>
              ))}
            </ol>
          </nav>
          <article>
            {sections.map((n) => (
              <section key={n} id={doc === "privacy" && n === 7 ? "cookies" : `s${n}`} aria-labelledby={`h${n}`}>
                {doc === "privacy" && n === 7 && <span id={`s${n}`} />}
                <h2 id={`h${n}`}>{t(key(`s${n}t`))}</h2>
                <p>{t(key(`s${n}`))}</p>
              </section>
            ))}
          </article>
        </div>
      </main>
      <Footer />
    </>
  );
}
