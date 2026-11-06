import Link from "next/link";
import "../styles/landing.css";
import "../styles/landing-crew.css";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";
import { TopBar, Footer } from "@/components/SiteChrome";
import { Icon, type IconName } from "@/components/Icon";
import { CrewAvatar } from "@/components/CrewAvatar";
import { Aurora } from "@/components/landing/Aurora";
import { ProductMock } from "@/components/landing/ProductMock";
import { ScrollFx } from "@/components/landing/ScrollFx";
import { CREW, CREW_COLOR, CREW_NAME, type CrewId } from "@/lib/crew";

const STACK = ["Next.js", "Expo", "FastAPI", "Remotion", "PPTX", "DOCX"] as const;
const STEPS = ["ask", "estimate", "build", "ship"] as const;
const MAKE: Array<{ id: "apps" | "media" | "docs" | "agents"; icon: IconName; crew: CrewId; chips: MessageKey[] }> = [
  { id: "apps", icon: "code", crew: "byggo", chips: ["landing.outputs.web", "landing.outputs.mobile", "landing.outputs.sites", "landing.outputs.apis"] },
  { id: "media", icon: "image", crew: "pixel", chips: ["landing.outputs.images", "landing.outputs.video", "landing.make.media.chip1", "landing.make.media.chip2"] },
  { id: "docs", icon: "slides", crew: "plania", chips: ["landing.outputs.decks", "landing.outputs.docs", "landing.make.docs.chip1", "landing.make.docs.chip2"] },
  { id: "agents", icon: "agent", crew: "mailo", chips: ["landing.outputs.agents", "landing.make.agents.chip1", "landing.make.agents.chip2", "landing.make.agents.chip3"] },
];
const GATE_ART = ["typecheck", "lint", "unit", "e2e", "semgrep", "lighthouse"] as const;
const FLOATERS: Array<{ id: CrewId; cls: string }> = [
  { id: "pixel", cls: "f1" },
  { id: "chatti", cls: "f2" },
  { id: "vakt", cls: "f3" },
  { id: "revy", cls: "f4" },
];

function SectionLabel({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <p className="section-label">
      <Icon name={icon} size={15} />
      <span>{children}</span>
    </p>
  );
}

export default async function Landing() {
  const { t } = await getT();
  return (
    <>
      <TopBar />
      <main id="main" className="landing">
        <ScrollFx />
        {/* ---------- Hero ---------- */}
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-top">
            <Aurora />
            <div className="hero-floaters" aria-hidden="true">
              {FLOATERS.map((f) => (
                <span key={f.id} className={`floater ${f.cls}`}>
                  <CrewAvatar id={f.id} size={64} />
                </span>
              ))}
            </div>
            <div className="container hero-inner">
              <p className="hero-badge">
                <span className="hero-badge-dot" aria-hidden="true" />
                {t("landing.hero.badge")}
              </p>
              <h1 id="hero-title" className="hero-title">
                <span className="line">{t("landing.hero.title1")}</span>{" "}
                <span className="line">
                  <span className="grad-text">{t("landing.hero.title2")}</span> {t("landing.hero.title3")}
                </span>
              </h1>
              <p className="hero-lede">{t("landing.hero.lede")}</p>
              <div className="hero-cta">
                <Link href="/signup" className="btn btn-primary btn-lg">
                  {t("landing.hero.cta")}
                  <Icon name="arrowRight" size={16} />
                </Link>
                <a href="#how" className="btn btn-lg">
                  {t("landing.hero.secondary")}
                </a>
              </div>
            </div>
          </div>
          <div className="container hero-mock-wrap">
            {/* The lead mascot sits on the edge of the product window. */}
            <img className="hero-mascot" src="/brand/scoutr-hero.webp" width={220} height={220} alt="" aria-hidden="true" fetchPriority="high" decoding="async" />
            <ProductMock t={t} />
          </div>
        </section>

        {/* ---------- Stack strip ---------- */}
        <section className="stack-strip container" aria-labelledby="stack-title">
          <h2 id="stack-title" className="stack-title">
            {t("landing.stack.label")}
          </h2>
          <ul className="stack-list">
            {STACK.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>

        {/* ---------- Statement ---------- */}
        <section className="container statement reveal" aria-label={t("landing.statement.label")}>
          <p className="statement-text">
            <span>{t("landing.statement.lead")}</span> {t("landing.statement.rest")}
          </p>
          <div className="statement-orb" aria-hidden="true">
            <div className="orb">
              <img className="orb-mascot" src="/brand/avatars/scoutr.webp" width={160} height={160} alt="" loading="lazy" decoding="async" />
            </div>
            <span className="orb-caption">{t("landing.statement.orb")}</span>
          </div>
        </section>

        {/* ---------- Why: bento ---------- */}
        <section id="why" className="section container" aria-labelledby="why-title">
          <SectionLabel icon="sparkle">{t("landing.why.eyebrow")}</SectionLabel>
          <div className="section-head-row">
            <h2 id="why-title" className="section-title">
              {t("landing.why.title1")} <span className="subtle-title">{t("landing.why.title2")}</span>
            </h2>
            <p className="section-lede">{t("landing.why.lede")}</p>
          </div>
          <div className="bento">
            <article className="bento-card b-quality reveal">
              <div className="bento-art art-gates" aria-hidden="true">
                {GATE_ART.map((g, i) => (
                  <span key={g} className="art-gate" style={{ ["--i" as string]: i }}>
                    <Icon name="check" size={12} strokeWidth={2.4} />
                    {g}
                  </span>
                ))}
              </div>
              <div className="bento-copy">
                <h3>
                  <CrewAvatar id="revy" size={30} />
                  {t("landing.pillars.quality.title")}
                </h3>
                <p>{t("landing.pillars.quality.body")}</p>
                <p className="bento-proof">{t("landing.pillars.quality.proof")}</p>
              </div>
            </article>
            <article className="bento-card b-design reveal">
              <div className="bento-art art-sliders" aria-hidden="true">
                {[62, 30, 78].map((v, i) => (
                  <span key={i} className="art-slider" style={{ ["--v" as string]: `${v}%` }}>
                    <span />
                  </span>
                ))}
              </div>
              <div className="bento-copy">
                <h3>
                  <CrewAvatar id="pixel" size={30} />
                  {t("landing.pillars.design.title")}
                </h3>
                <p>{t("landing.pillars.design.body")}</p>
                <p className="bento-proof">{t("landing.pillars.design.proof")}</p>
              </div>
            </article>
            <article className="bento-card b-security reveal">
              <div className="bento-art art-circuit" aria-hidden="true">
                <svg viewBox="0 0 240 140" fill="none" preserveAspectRatio="none">
                  <path d="M120 70H40V30H10M120 70h80V30h30M120 70v50H60v20M120 70v50h70v20M120 70H70v-40" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                </svg>
                <span className="art-shield">
                  <CrewAvatar id="vakt" size={64} />
                </span>
              </div>
              <div className="bento-copy">
                <h3>
                  <Icon name="shield" size={22} />
                  {t("landing.pillars.security.title")}
                </h3>
                <p>{t("landing.pillars.security.body")}</p>
                <p className="bento-proof">{t("landing.pillars.security.proof")}</p>
              </div>
            </article>
            <article className="bento-card b-pricing reveal">
              <div className="bento-art art-meter" aria-hidden="true">
                <span className="meter-figure">{t("landing.pricing.exampleRange")}</span>
                <span className="meter-track">
                  <span className="meter-range" />
                  <span className="meter-mark" />
                </span>
                <span className="meter-legend">
                  <span>{t("landing.pricing.lineTotal")}</span>
                  <span>{t("landing.pricing.guarantee")}</span>
                </span>
              </div>
              <div className="bento-copy">
                <h3>
                  <CrewAvatar id="scoutr" size={30} />
                  {t("landing.pillars.pricing.title")}
                </h3>
                <p>{t("landing.pillars.pricing.body")}</p>
                <p className="bento-proof">{t("landing.pillars.pricing.proof")}</p>
              </div>
            </article>
            <article className="bento-card b-lockin reveal">
              <div className="bento-art art-tiles" aria-hidden="true">
                {(["github", "code", "slides", "file", "rocket", "folder"] as const).map((n, i) => (
                  <span key={n} className="art-tile" style={{ ["--i" as string]: i }}>
                    <Icon name={n} size={20} />
                  </span>
                ))}
              </div>
              <div className="bento-copy">
                <h3>
                  <CrewAvatar id="byggo" size={30} />
                  {t("landing.pillars.lockin.title")}
                </h3>
                <p>{t("landing.pillars.lockin.body")}</p>
                <p className="bento-proof">{t("landing.pillars.lockin.proof")}</p>
              </div>
            </article>
            <article className="bento-card b-eu reveal">
              <div className="bento-art art-planet" aria-hidden="true">
                <span className="mini-planet" />
                <span className="art-coord">50.11° N · 8.68° E</span>
              </div>
              <div className="bento-copy">
                <h3>
                  <CrewAvatar id="mailo" size={30} />
                  {t("landing.pillars.eu.title")}
                </h3>
                <p>{t("landing.pillars.eu.body")}</p>
                <p className="bento-proof">{t("landing.pillars.eu.proof")}</p>
              </div>
            </article>
            <article className="bento-card b-cta reveal">
              <h3 className="cta-title">{t("landing.ctaCard.title")}</h3>
              <p>{t("landing.ctaCard.body")}</p>
              <img className="cta-mascot" src="/brand/avatars/chatti.webp" width={120} height={120} alt="" aria-hidden="true" loading="lazy" decoding="async" />
              <div className="cta-actions">
                <Link href="/signup" className="btn btn-primary">
                  {t("nav.start")}
                </Link>
                <Link href="/login" className="btn">
                  {t("nav.login")}
                </Link>
              </div>
            </article>
          </div>
        </section>

        {/* ---------- Meet your crew ---------- */}
        <section id="crew" className="section container" aria-labelledby="crew-title">
          <SectionLabel icon="users">{t("landing.crew.eyebrow")}</SectionLabel>
          <div className="section-head-row">
            <h2 id="crew-title" className="section-title">
              {t("landing.crew.title")}
            </h2>
            <p className="section-lede">{t("landing.crew.lede")}</p>
          </div>
          <ul className="crew-grid">
            {CREW.map((c) => (
              <li key={c} className={`crew-card reveal${c === "scoutr" ? " is-lead" : ""}`} style={{ ["--c" as string]: CREW_COLOR[c] }}>
                <CrewAvatar id={c} size={c === "scoutr" ? 92 : 76} />
                <h3 className="crew-name">{CREW_NAME[c]}</h3>
                <p className="crew-role">{c === "scoutr" ? t("landing.crew.lead") : t(`crew.${c}.role`)}</p>
                <p>{t(`crew.${c}.desc`)}</p>
              </li>
            ))}
          </ul>
          <p className="crew-hint">{t("landing.crew.hint")}</p>
        </section>

        {/* ---------- What you can make: sticky index + glass cards ---------- */}
        <section id="make" className="section container" aria-labelledby="make-title">
          <SectionLabel icon="slides">{t("landing.make.eyebrow")}</SectionLabel>
          <div className="section-head-row">
            <h2 id="make-title" className="section-title">
              {t("landing.make.title")}
            </h2>
            <p className="section-lede">{t("landing.make.lede")}</p>
          </div>
          <div className="make">
            <nav className="make-index" aria-label={t("landing.make.index")}>
              <ul>
                {MAKE.map((m) => (
                  <li key={m.id}>
                    <a href={`#make-${m.id}`}>
                      <Icon name={m.icon} size={16} />
                      {t(`landing.make.${m.id}.short`)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="make-cards">
              {MAKE.map((m) => (
                <article key={m.id} id={`make-${m.id}`} className={`make-card make-${m.id} reveal`}>
                  <div className="make-copy">
                    <h3>{t(`landing.make.${m.id}.title`)}</h3>
                    <p>{t(`landing.make.${m.id}.body`)}</p>
                    <ul className="tag-list">
                      {m.chips.map((c) => (
                        <li key={c} className="tag">
                          {t(c)}
                        </li>
                      ))}
                    </ul>
                    <Link href="/signup" className="btn btn-sm make-link">
                      {t(`landing.make.${m.id}.cta`)}
                      <Icon name="arrowRight" size={14} />
                    </Link>
                  </div>
                  <div className="make-art" aria-hidden="true">
                    <span className="make-glow" />
                    <span className="orb make-orb">
                      <img className="orb-mascot" src={`/brand/avatars/${m.crew}.webp`} width={150} height={150} alt="" loading="lazy" decoding="async" />
                    </span>
                    <span className="make-chip">
                      <Icon name={m.icon} size={14} />
                      {CREW_NAME[m.crew]}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- How it works ---------- */}
        <section id="how" className="section container" aria-labelledby="how-title">
          <SectionLabel icon="history">{t("landing.how.eyebrow")}</SectionLabel>
          <div className="section-head-row">
            <h2 id="how-title" className="section-title">
              {t("landing.how.title")}
            </h2>
            <p className="section-lede">{t("landing.how.lede")}</p>
          </div>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s} className="step reveal">
                <span className="step-num" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="step-label">{t("landing.how.step", { n: i + 1 })}</p>
                <h3>{t(`landing.how.${s}.title`)}</h3>
                <p>{t(`landing.how.${s}.body`)}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ---------- Pricing ---------- */}
        <section id="pricing" className="section container pricing" aria-labelledby="pricing-title">
          <div className="pricing-copy">
            <SectionLabel icon="card">{t("landing.pricing.eyebrow")}</SectionLabel>
            <h2 id="pricing-title" className="section-title">
              {t("landing.pricing.title1")} <span className="subtle-title">{t("landing.pricing.title2")}</span>
            </h2>
            <p className="section-lede">{t("landing.pricing.body")}</p>
            <ul className="pricing-points">
              {(["point1", "point2", "point3"] as const).map((k) => (
                <li key={k}>
                  <Icon name="check" size={16} strokeWidth={2.2} />
                  {t(`landing.pricing.${k}`)}
                </li>
              ))}
            </ul>
          </div>
          <figure className="estimate-card reveal" aria-labelledby="estimate-caption">
            <figcaption id="estimate-caption" className="eyebrow">
              {t("landing.pricing.exampleLabel")}
            </figcaption>
            <p className="estimate-prompt">“{t("landing.pricing.examplePrompt")}”</p>
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

        {/* ---------- Final CTA ---------- */}
        <section className="container final" aria-labelledby="final-title">
          <div className="final-card reveal">
            <div className="final-glow" aria-hidden="true" />
            <div className="final-crew" aria-hidden="true">
              {(["plania", "pixel", "byggo", "vakt", "revy"] as const).map((c) => (
                <CrewAvatar key={c} id={c} size={52} />
              ))}
            </div>
            <h2 id="final-title" className="final-title">
              {t("landing.final.title1")} <span className="grad-text">{t("landing.final.title2")}</span>
            </h2>
            <p className="section-lede">{t("landing.final.body")}</p>
            <div className="hero-cta">
              <Link href="/signup" className="btn btn-primary btn-lg">
                {t("landing.final.cta")}
              </Link>
              <Link href="/login" className="btn btn-lg">
                {t("nav.login")}
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
