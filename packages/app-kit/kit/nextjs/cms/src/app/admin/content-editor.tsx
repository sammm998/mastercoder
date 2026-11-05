"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { Section, SiteContent } from "@/lib/cms/schema";
import { saveContentAction, type SaveResult } from "./actions";

function Field({ id, label, value, onChange, multiline, error }: { id: string; label: string; value: string; onChange: (v: string) => void; multiline?: boolean; error?: string }) {
  const errId = `${id}-error`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} rows={5} value={value} aria-invalid={Boolean(error)} aria-describedby={error ? errId : undefined} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} value={value} aria-invalid={Boolean(error)} aria-describedby={error ? errId : undefined} onChange={(e) => onChange(e.target.value)} />
      )}
      {error && (
        <span id={errId} style={{ color: "var(--color-accent)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Form editor for the site content model. Saves through a server action that re-checks access. */
export function ContentEditor({ initial }: { initial: SiteContent }) {
  const [content, setContent] = useState<SiteContent>(initial);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [pending, startTransition] = useTransition();
  const errors = result && !result.ok ? (result.fieldErrors ?? {}) : {};

  const setHero = (key: keyof SiteContent["hero"], value: string) => setContent((c) => ({ ...c, hero: { ...c.hero, [key]: value } }));
  const setSection = (i: number, patch: Partial<Section>) => setContent((c) => ({ ...c, sections: c.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const addSection = () => setContent((c) => ({ ...c, sections: [...c.sections, { id: `section-${c.sections.length + 1}`, heading: "New section", body: "" }] }));
  const removeSection = (i: number) => setContent((c) => ({ ...c, sections: c.sections.filter((_, j) => j !== i) }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    startTransition(async () => setResult(await saveContentAction(content)));
  }

  return (
    <form onSubmit={onSubmit} aria-describedby="cms-status">
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>
          <h2>Hero</h2>
        </legend>
        <Field id="hero-title" label="Title" value={content.hero.title} onChange={(v) => setHero("title", v)} error={errors["hero.title"]} />
        <Field id="hero-lead" label="Intro text" multiline value={content.hero.lead} onChange={(v) => setHero("lead", v)} error={errors["hero.lead"]} />
        <Field id="hero-cta" label="Button label" value={content.hero.ctaLabel} onChange={(v) => setHero("ctaLabel", v)} error={errors["hero.ctaLabel"]} />
        <Field id="hero-href" label="Button link" value={content.hero.ctaHref} onChange={(v) => setHero("ctaHref", v)} error={errors["hero.ctaHref"]} />
      </fieldset>
      <h2>Sections</h2>
      {content.sections.map((s, i) => (
        <fieldset key={i} style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
          <legend>Section {i + 1}</legend>
          <Field id={`s${i}-id`} label="Anchor id" value={s.id} onChange={(v) => setSection(i, { id: v })} error={errors[`sections.${i}.id`]} />
          <Field id={`s${i}-heading`} label="Heading" value={s.heading} onChange={(v) => setSection(i, { heading: v })} error={errors[`sections.${i}.heading`]} />
          <Field id={`s${i}-body`} label="Text" multiline value={s.body} onChange={(v) => setSection(i, { body: v })} error={errors[`sections.${i}.body`]} />
          <button type="button" className="button" data-variant="ghost" onClick={() => removeSection(i)}>
            Remove section {i + 1}
          </button>
        </fieldset>
      ))}
      <p style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <button type="button" className="button" data-variant="ghost" onClick={addSection}>
          Add section
        </button>
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
      </p>
      <p id="cms-status" role="status" aria-live="polite">
        {result?.ok ? `Saved ${new Date(result.savedAt).toLocaleTimeString()}.` : result?.error}
      </p>
    </form>
  );
}
