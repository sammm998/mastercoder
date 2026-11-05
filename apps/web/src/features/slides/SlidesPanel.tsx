"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import { useTRPC } from "@/lib/trpc";
import type { ForgeEvent } from "@/lib/events";
import { ErrorNotice, EmptyState, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { addSlide, isDeck, layoutsIn, moveSlide, removeSlide, themeFrom, updateSlide, viewOf, type DeckTheme, type RawDeck, type SlideView } from "./deck";

type Kind = "deck" | "document";

function SlideCanvas({ s, theme, n }: { s: SlideView; theme: DeckTheme; n: number }) {
  return (
    <div className={`slide slide-${s.layout}`} style={{ background: theme.bg, color: theme.text, fontFamily: theme.body, ["--slide-accent" as string]: theme.accent }}>
      <span className="slide-num" style={{ color: theme.muted }}>
        {String(n).padStart(2, "0")}
      </span>
      {s.title && (
        <h3 className="slide-title" style={{ fontFamily: theme.display }}>
          {s.title}
        </h3>
      )}
      {s.subtitle && <p className="slide-sub" style={{ color: theme.muted }}>{s.subtitle}</p>}
      {s.body && <p className="slide-body">{s.body}</p>}
      {s.bullets.length > 0 && (
        <ul className="slide-bullets">
          {s.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      {s.image && <img className="slide-img" src={s.image} alt="" loading="lazy" />}
    </div>
  );
}

function DeckEditor({ projectId, artifactId, brand }: { projectId: string; artifactId: string; brand: unknown }) {
  const t = useT();
  const trpc = useTRPC();
  const q = useQuery(trpc.slides.get.queryOptions({ projectId, artifactId, kind: "deck" }));
  const [deck, setDeck] = useState<RawDeck | null>(null);
  const [current, setCurrent] = useState(0);
  const [dirty, setDirty] = useState(false);
  const save = useMutation(trpc.slides.save.mutationOptions({ onSuccess: () => setDirty(false) }));
  const exp = useMutation(trpc.slides.export.mutationOptions({ onSuccess: (r) => window.open(r.url, "_blank", "noopener") }));

  useEffect(() => {
    if (q.data && isDeck(q.data.content)) {
      setDeck(q.data.content);
      setDirty(false);
    }
  }, [q.data]);

  const theme = useMemo(() => themeFrom(brand, q.data?.content), [brand, q.data]);
  if (q.isPending) return <LoadingBlock rows={5} />;
  if (q.isError) return <ErrorNotice error={q.error} />;
  const exportRow = (
    <div className="row" style={{ gap: 6 }}>
      {(["pptx", "pdf", "html"] as const).map((f) => (
        <button key={f} type="button" className="btn btn-sm" disabled={exp.isPending} onClick={() => exp.mutate({ projectId, artifactId, kind: "deck", format: f })} aria-label={t("project.slides.exportAs", { format: f.toUpperCase() })}>
          {f.toUpperCase()}
        </button>
      ))}
    </div>
  );
  if (!deck) {
    return (
      <div className="stack">
        <p className="notice">{t("project.slides.unsupported")}</p>
        {exportRow}
        <ErrorNotice error={exp.error} service="slides" />
      </div>
    );
  }
  const idx = Math.min(current, deck.slides.length - 1);
  const view = viewOf(deck.slides[idx]!);
  const edit = (patch: Partial<SlideView>) => {
    setDeck((d) => (d ? updateSlide(d, idx, patch) : d));
    setDirty(true);
  };
  const mutateDeck = (fn: (d: RawDeck) => RawDeck, nextIndex?: number) => {
    setDeck((d) => (d ? fn(d) : d));
    if (nextIndex !== undefined) setCurrent(nextIndex);
    setDirty(true);
  };

  return (
    <div className="deck-editor">
      <ol className="deck-rail" aria-label={t("project.slides.title")}>
        {deck.slides.map((s, i) => (
          <li key={i}>
            <button type="button" className="deck-thumb" aria-current={i === idx ? "true" : undefined} onClick={() => setCurrent(i)} aria-label={t("project.slides.slide", { n: i + 1 })}>
              <SlideCanvas s={viewOf(s)} theme={theme} n={i + 1} />
            </button>
          </li>
        ))}
      </ol>
      <div className="deck-stage stack">
        <SlideCanvas s={view} theme={theme} n={idx + 1} />
        <div className="row-between">
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => mutateDeck((d) => moveSlide(d, idx, -1), Math.max(0, idx - 1))} disabled={idx === 0} aria-label={t("project.slides.moveUp")} title={t("project.slides.moveUp")}>
              <Icon name="arrowUp" size={14} />
            </button>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => mutateDeck((d) => moveSlide(d, idx, 1), Math.min(deck.slides.length - 1, idx + 1))} disabled={idx === deck.slides.length - 1} aria-label={t("project.slides.moveDown")} title={t("project.slides.moveDown")}>
              <Icon name="arrowDown" size={14} />
            </button>
            <button type="button" className="btn btn-sm" onClick={() => mutateDeck((d) => addSlide(d, idx, t("project.slides.slide", { n: idx + 2 })), idx + 1)}>
              <Icon name="plus" size={14} /> {t("project.slides.addSlide")}
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => mutateDeck((d) => removeSlide(d, idx), Math.max(0, idx - 1))} disabled={deck.slides.length <= 1}>
              {t("project.slides.deleteSlide")}
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {exportRow}
            <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate({ projectId, artifactId, kind: "deck", content: deck })}>
              {save.isPending ? t("common.saving") : dirty ? t("project.slides.save") : t("project.slides.saved")}
            </button>
          </div>
        </div>
        <ErrorNotice error={save.error ?? exp.error} service="slides" compact />
        <div className="vedit-grid">
          <div className="field">
            <label htmlFor="sl-title">{t("project.slides.slideTitle")}</label>
            <input id="sl-title" className="input" value={view.title} onChange={(e) => edit({ title: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="sl-layout">{t("project.slides.layout")}</label>
            <select id="sl-layout" className="select" value={view.layout} onChange={(e) => edit({ layout: e.target.value })}>
              {layoutsIn(deck).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="sl-sub">{t("project.slides.subtitle")}</label>
          <input id="sl-sub" className="input" value={view.subtitle} onChange={(e) => edit({ subtitle: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="sl-body">{t("project.slides.body")}</label>
          <textarea id="sl-body" className="textarea" rows={3} value={view.body} onChange={(e) => edit({ body: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="sl-bullets">{t("project.slides.bullets")}</label>
          <textarea id="sl-bullets" className="textarea" rows={4} value={view.bullets.join("\n")} onChange={(e) => edit({ bullets: e.target.value.split("\n") })} />
        </div>
        <div className="field">
          <label htmlFor="sl-notes">{t("project.slides.notes")}</label>
          <textarea id="sl-notes" className="textarea" rows={2} value={view.notes} onChange={(e) => edit({ notes: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

function DocumentView({ projectId, artifactId }: { projectId: string; artifactId: string }) {
  const t = useT();
  const trpc = useTRPC();
  const q = useQuery(trpc.slides.get.queryOptions({ projectId, artifactId, kind: "document" }));
  const exp = useMutation(trpc.slides.export.mutationOptions({ onSuccess: (r) => window.open(r.url, "_blank", "noopener") }));
  if (q.isPending) return <LoadingBlock rows={5} />;
  if (q.isError) return <ErrorNotice error={q.error} />;
  const doc = q.data.content as { title?: unknown; sections?: Array<{ heading?: unknown; body?: unknown }> } | null;
  return (
    <div className="stack">
      <div className="row" style={{ gap: 6 }}>
        {(["docx", "pdf", "html"] as const).map((f) => (
          <button key={f} type="button" className="btn btn-sm" disabled={exp.isPending} onClick={() => exp.mutate({ projectId, artifactId, kind: "document", format: f })} aria-label={t("project.slides.exportAs", { format: f.toUpperCase() })}>
            {f.toUpperCase()}
          </button>
        ))}
      </div>
      <ErrorNotice error={exp.error} service="slides" compact />
      <article className="doc-view">
        {typeof doc?.title === "string" && <h3>{doc.title}</h3>}
        {Array.isArray(doc?.sections) ? (
          doc.sections.map((s, i) => (
            <section key={i}>
              {typeof s.heading === "string" && <h4>{s.heading}</h4>}
              {typeof s.body === "string" && <p>{s.body}</p>}
            </section>
          ))
        ) : (
          <pre className="code">{JSON.stringify(doc, null, 2)}</pre>
        )}
      </article>
    </div>
  );
}

export function SlidesPanel({ projectId, events, canWrite, brand }: { projectId: string; events: ForgeEvent[]; canWrite: boolean; brand: unknown }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const decks = useQuery(trpc.project.artifacts.queryOptions({ projectId }));
  const items = (decks.data ?? []).filter((a) => a.kind === "deck" || a.kind === "document");
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("deck");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(8);
  const gen = useMutation(trpc.slides.generate.mutationOptions());
  const lastArtifact = useMemo(() => [...events].reverse().find((e) => e.type === "artifact.ready")?.id, [events]);
  useEffect(() => {
    if (lastArtifact) void qc.invalidateQueries({ queryKey: trpc.project.artifacts.queryKey({ projectId }) });
  }, [lastArtifact, qc, trpc, projectId]);
  const active = items.find((a) => a.id === selected) ?? items[0];

  return (
    <div className="panel-pad stack-lg">
      {canWrite && (
        <details className="card">
          <summary className="section-title-sm" style={{ cursor: "pointer" }}>
            {t("project.slides.generateTitle")}
          </summary>
          <form
            className="stack"
            style={{ marginTop: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt.trim()) gen.mutate({ projectId, kind, prompt: prompt.trim(), slideCount: kind === "deck" ? count : undefined });
            }}
          >
            <div className="seg" role="radiogroup">
              {(["deck", "document"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === "deck" ? t("project.slides.kindDeck") : t("project.slides.kindDocument")}
                </button>
              ))}
            </div>
            <div className="field">
              <label htmlFor="sl-prompt">{t("project.slides.prompt")}</label>
              <textarea id="sl-prompt" className="textarea" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={8000} />
            </div>
            {kind === "deck" && (
              <div className="field" style={{ maxWidth: 160 }}>
                <label htmlFor="sl-count">{t("project.slides.count")}</label>
                <input id="sl-count" className="input" type="number" min={1} max={60} value={count} onChange={(e) => setCount(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} />
              </div>
            )}
            <button type="submit" className="btn btn-primary btn-sm" style={{ justifySelf: "start" }} disabled={!prompt.trim() || gen.isPending}>
              {t("project.slides.generate")}
            </button>
            {gen.isSuccess && <p className="notice notice-ok">{t("project.slides.queued")}</p>}
            <ErrorNotice error={gen.error} compact />
          </form>
        </details>
      )}
      {decks.isPending ? (
        <LoadingBlock rows={4} />
      ) : decks.isError ? (
        <ErrorNotice error={decks.error} />
      ) : !active ? (
        <EmptyState title={t("project.slides.title")} body={t("project.slides.empty")} />
      ) : (
        <>
          {items.length > 1 && (
            <div className="field" style={{ maxWidth: 420 }}>
              <label htmlFor="deck-pick">{t("project.slides.pick")}</label>
              <select id="deck-pick" className="select" value={active.id} onChange={(e) => setSelected(e.target.value)}>
                {items.map((a) => (
                  <option key={a.id} value={a.id}>
                    {(a.kind === "deck" ? t("project.slides.kindDeck") : t("project.slides.kindDocument")) + " · " + formatDate(a.createdAt, locale)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {active.kind === "deck" ? <DeckEditor key={active.id} projectId={projectId} artifactId={active.id} brand={brand} /> : <DocumentView key={active.id} projectId={projectId} artifactId={active.id} />}
        </>
      )}
    </div>
  );
}
