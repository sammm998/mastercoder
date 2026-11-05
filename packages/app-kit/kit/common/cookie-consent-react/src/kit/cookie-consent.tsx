"use client";

import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties } from "react";
import { activateConsentedScripts, consentText, getConsent, setConsent, subscribeConsent, type ConsentState } from "./consent";

const noSubscribe = () => () => undefined;

const panel: CSSProperties = {
  position: "fixed",
  insetInline: "var(--space-4)",
  bottom: "var(--space-4)",
  zIndex: 1000,
  maxWidth: "36rem",
  marginInline: "auto",
  padding: "var(--space-6)",
  background: "var(--color-surface)",
  color: "var(--color-text)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "0 10px 40px rgb(0 0 0 / 0.15)",
};

/**
 * Accessible cookie banner: a labelled, non-modal dialog; "Accept all" and "Only essential" are
 * equally prominent (GDPR); per-category choices behind "Choose". Nothing non-essential runs until
 * the visitor accepts it.
 */
export function CookieConsent() {
  const consent = useSyncExternalStore<ConsentState | null | undefined>(subscribeConsent, getConsent, () => undefined);
  const lang = useSyncExternalStore(noSubscribe, () => document.documentElement.lang || "en", () => "en");
  const [choosing, setChoosing] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    activateConsentedScripts();
  }, []);

  // undefined = server render / not hydrated yet; an object = decided.
  if (consent !== null) return null;
  const t = consentText(lang);

  return (
    <div role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={bodyId} style={panel}>
      <h2 id={titleId} style={{ fontSize: "1.125rem", margin: "0 0 var(--space-2)" }}>
        {t.title}
      </h2>
      <p id={bodyId} style={{ margin: "0 0 var(--space-4)" }}>
        {t.body}
      </p>
      {choosing && (
        <fieldset style={{ border: 0, padding: 0, margin: "0 0 var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
          <label>
            <input type="checkbox" checked disabled /> {t.necessary}
          </label>
          <label>
            <input type="checkbox" checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} /> {t.analytics}
          </label>
          <label>
            <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} /> {t.marketing}
          </label>
        </fieldset>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        <button type="button" className="button" onClick={() => setConsent({ analytics: true, marketing: true })}>
          {t.acceptAll}
        </button>
        <button type="button" className="button" onClick={() => setConsent({ analytics: false, marketing: false })}>
          {t.rejectAll}
        </button>
        {choosing ? (
          <button type="button" className="button" data-variant="ghost" onClick={() => setConsent({ analytics, marketing })}>
            {t.save}
          </button>
        ) : (
          <button type="button" className="button" data-variant="ghost" aria-expanded={false} onClick={() => setChoosing(true)}>
            {t.choose}
          </button>
        )}
      </div>
    </div>
  );
}
