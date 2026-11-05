import type { Translate } from "@/i18n/translate";
import { Icon } from "@/components/Icon";
import { LogoMark } from "@/components/Logo";

const PHASES = ["plan", "design", "build", "verify", "review", "finish"] as const;
const GATES: Array<[string, "ok" | "skip"]> = [
  ["typecheck", "ok"],
  ["lint", "ok"],
  ["unit", "ok"],
  ["e2e", "ok"],
  ["semgrep", "ok"],
  ["gitleaks", "ok"],
  ["rls", "ok"],
  ["lighthouse", "skip"],
];

/**
 * A static, illustrative rendering of the Forge project workspace (agent timeline + live preview) for the
 * hero. Built from the same visual language as the real app; clearly captioned as an example.
 */
export function ProductMock({ t }: { t: Translate }) {
  return (
    <figure className="mock" aria-labelledby="mock-caption">
      <figcaption id="mock-caption" className="sr-only">
        {t("landing.mock.caption")}
      </figcaption>
      <div className="mock-window" aria-hidden="true">
        <div className="mock-chrome">
          <span className="mock-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="mock-title">
            <LogoMark /> {t("landing.mock.project")}
          </span>
          <span className="mock-live">
            <span className="dot" /> {t("project.chat.connection.open")}
          </span>
        </div>
        <div className="mock-body">
          <div className="mock-agent">
            <ol className="mock-stepper">
              {PHASES.map((p, i) => (
                <li key={p} data-state={i < 3 ? "done" : i === 3 ? "active" : "todo"}>
                  <span className="mock-step-dot" />
                  <span>{t(`project.chat.phase.${p}`)}</span>
                </li>
              ))}
            </ol>
            <div className="mock-bubble">{t("landing.hero.prompt1")}</div>
            <div className="mock-card mock-estimate">
              <span className="mock-label">{t("project.chat.estimateTitle")}</span>
              <span className="mock-price">$1.60 – $2.90</span>
              <span className="mock-meter">
                <span style={{ width: "46%" }} />
              </span>
            </div>
            <div className="mock-row">
              <Icon name="file" size={13} />
              <span>{t("landing.mock.wrote")}</span>
              <code>app/book/page.tsx</code>
            </div>
            <div className="mock-row">
              <Icon name="terminal" size={13} />
              <span>{t("landing.mock.tests")}</span>
            </div>
            <div className="mock-card mock-gates">
              <span className="mock-label">{t("project.gates.title")}</span>
              <span className="mock-gates-sum">{t("landing.mock.gatesSummary")}</span>
              <span className="mock-chips">
                {GATES.map(([g, s]) => (
                  <span key={g} className={`mock-chip ${s}`}>
                    <Icon name={s === "ok" ? "check" : "skip"} size={10} strokeWidth={2.4} />
                    {g}
                  </span>
                ))}
              </span>
            </div>
            <div className="mock-composer">
              <span>{t("landing.mock.composer")}</span>
              <span className="mock-send">
                <Icon name="arrowUp" size={14} strokeWidth={2.2} />
              </span>
            </div>
          </div>
          <div className="mock-preview">
            <div className="mock-tabs">
              <span data-on="true">{t("project.tabs.preview")}</span>
              <span>{t("project.tabs.code")}</span>
              <span>{t("project.tabs.history")}</span>
              <span>{t("project.tabs.deploy")}</span>
            </div>
            <div className="mock-site">
              <div className="mock-site-nav">
                <strong>{t("landing.mock.siteBrand")}</strong>
                <span>{t("landing.mock.siteNav")}</span>
              </div>
              <div className="mock-site-hero">
                <p className="mock-site-kicker">{t("landing.mock.siteKicker")}</p>
                <p className="mock-site-title">{t("landing.mock.siteTitle")}</p>
                <span className="mock-site-btn">{t("landing.mock.siteCta")}</span>
              </div>
              <div className="mock-site-grid">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="mock-site-tile" style={{ ["--i" as string]: i }}>
                    <span className="mock-site-img" />
                    <span className="mock-site-line" />
                    <span className="mock-site-line short" />
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="mock-glow" aria-hidden="true" />
    </figure>
  );
}
