import Link from "next/link";
import "../styles/landing.css";
import { getT } from "@/i18n/server";
import { TopBar, Footer } from "@/components/SiteChrome";
import { HeroBackdrop } from "@/components/landing/HeroBackdrop";
import { PromptTicker } from "@/components/landing/PromptTicker";

const PILLARS = ["quality", "design", "security", "pricing", "lockin", "eu"] as const;
const STEPS = ["ask", "estimate", "build", "ship"] as const;
const OUTPUTS = ["web", "mobile", "sites", "apis", "images", "video", "decks", "docs", "agents"] as const;

export default async function Landing() {
  const { t } = await getT();
  const prompts = [t("landing.hero.prompt1"), t("landing.hero.prompt2"), t("landing.hero.prompt3")];
  return (
    <>
      <TopBar />
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <HeroBackdrop />
          <div className="container hero-inner">
            <p className="eyebrow hero-eyebrow">
              <span className="dot" style={{ color: "var(--accent)" }} /> {t("landing.hero.eyebrow")}
            </p>
            <h1 id="hero-title" className="hero-title">
              <span className="line">{t("landing.hero.title1")}</span>{" "}
              <span className="line">
                <em>{t("landing.hero.title2")}</em> {t("landing.hero.title3")}
              </span>
            </h1>
            <div className="hero-foot">
              <p className="hero-lede">{t("landing.hero.lede")}</p>
              <div className="hero-prompt" role="presentation">
                <span className="eyebrow">{t("landing.hero.promptLabel")}</span>
                <PromptTicker prompts={prompts} label={t("landing.hero.promptLabel")} />
                <div className="row">
                  <Link href="/signup" className="btn btn-primary btn-lg">
                    {t("landing.hero.cta")}
                  </Link>
                  <a href="#how" className="btn btn-lg">
                    {t("landing.hero.secondary")}
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="outputs" aria-label={t("landing.outputs.label")}>
          <div className="marquee" aria-hidden="true">
            {[0, 1].map((k) => (
              <ul key={k}>
                {OUTPUTS.map((o) => (
                  <li key={o}>{t(`landing.outputs.${o}`)}</li>
                ))}
              </ul>
            ))}
          </div>
          <ul className="sr-only">
            {OUTPUTS.map((o) => (
              <li key={o}>{t(`landing.outputs.${o}`)}</li>
            ))}
          </ul>
        </section>

        <section id="why" className="section container pillars" aria-labelledby="why-title">
          <div className="pillars-head">
            <p className="eyebrow">{t("landing.why.eyebrow")}</p>
            <h2 id="why-title" className="section-title">
              {t("landing.why.title1")} <em>{t("landing.why.title2")}</em>
            </h2>
            <p className="muted">{t("landing.why.lede")}</p>
          </div>
          <ol className="pillar-list">
            {PILLARS.map((p, i) => (
              <li key={p} className="pillar">
                <span className="pillar-num" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3>{t(`landing.pillars.${p}.title`)}</h3>
                  <p className="muted">{t(`landing.pillars.${p}.body`)}</p>
                  <p className="pillar-proof mono">{t(`landing.pillars.${p}.proof`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="how" className="section how" aria-labelledby="how-title">
          <div className="container">
            <p className="eyebrow">{t("landing.how.eyebrow")}</p>
            <h2 id="how-title" className="section-title">
              {t("landing.how.title")}
            </h2>
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s} className="step">
                  <span className="step-num mono" aria-hidden="true">
                    {t("landing.how.step", { n: i + 1 })}
                  </span>
                  <h3>{t(`landing.how.${s}.title`)}</h3>
                  <p className="muted">{t(`landing.how.${s}.body`)}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="pricing" className="section container pricing" aria-labelledby="pricing-title">
          <div>
            <p className="eyebrow">{t("landing.pricing.eyebrow")}</p>
            <h2 id="pricing-title" className="section-title">
              {t("landing.pricing.title1")} <em>{t("landing.pricing.title2")}</em>
            </h2>
            <p className="muted" style={{ maxWidth: 520 }}>
              {t("landing.pricing.body")}
            </p>
          </div>
          <figure className="estimate-card" aria-label={t("landing.pricing.exampleLabel")}>
            <figcaption className="eyebrow">{t("landing.pricing.exampleLabel")}</figcaption>
            <p className="estimate-prompt serif">“{t("landing.pricing.examplePrompt")}”</p>
            <dl className="estimate-lines">
              <div>
                <dt>{t("landing.pricing.linePlan")}</dt>
                <dd className="mono">$0.18</dd>
              </div>
              <div>
                <dt>{t("landing.pricing.lineBuild")}</dt>
                <dd className="mono">$1.10 – $2.40</dd>
              </div>
              <div>
                <dt>{t("landing.pricing.lineVerify")}</dt>
                <dd className="mono">$0.30</dd>
              </div>
              <div className="estimate-total">
                <dt>{t("landing.pricing.lineTotal")}</dt>
                <dd className="mono">$1.58 – $2.88</dd>
              </div>
            </dl>
            <p className="badge badge-ok">{t("landing.pricing.guarantee")}</p>
          </figure>
        </section>

        <section className="section eu" aria-labelledby="eu-title">
          <div className="container eu-inner">
            <p className="eu-coord mono" aria-hidden="true">
              50.1109° N, 8.6821° E
            </p>
            <h2 id="eu-title" className="section-title">
              {t("landing.eu.title")}
            </h2>
            <p className="muted">{t("landing.eu.body")}</p>
          </div>
        </section>

        <section className="section container final" aria-labelledby="final-title">
          <h2 id="final-title" className="final-title">
            {t("landing.final.title1")} <em>{t("landing.final.title2")}</em>
          </h2>
          <div className="row">
            <Link href="/signup" className="btn btn-primary btn-lg">
              {t("landing.final.cta")}
            </Link>
            <Link href="/login" className="btn btn-lg">
              {t("nav.login")}
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
