"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { applyVisualEdit, describeElement, parseSrc, VisualEditError, type ElementInfo, type ForgeSelectMessage, type VisualEdit } from "@forge/visual-edit";
import { useT } from "@/i18n/client";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { minimalSplice } from "@/lib/collab";
import { ErrorNotice } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import type { CollabHandle } from "../editor/CollabEditor";
import { toHex, validLength } from "./color";

interface Draft {
  text: string;
  color: string;
  background: string;
  padding: string;
  fontSize: string;
  addClasses: string;
  removeClasses: string;
  src: string;
  alt: string;
  href: string;
}

/** Build the edit list from what changed in the form (pure; exported for tests). */
export function editsFromDraft(initial: Draft, draft: Draft): VisualEdit[] {
  const edits: VisualEdit[] = [];
  if (draft.text !== initial.text) edits.push({ kind: "text", value: draft.text });
  if (draft.color !== initial.color) edits.push({ kind: "style", prop: "color", value: draft.color || null });
  if (draft.background !== initial.background) edits.push({ kind: "style", prop: "backgroundColor", value: draft.background || null });
  if (draft.padding !== initial.padding) edits.push({ kind: "style", prop: "padding", value: draft.padding.trim() || null });
  if (draft.fontSize !== initial.fontSize) edits.push({ kind: "style", prop: "fontSize", value: draft.fontSize.trim() || null });
  const add = draft.addClasses.split(/\s+/).filter(Boolean);
  const remove = draft.removeClasses.split(/\s+/).filter(Boolean);
  if (add.length || remove.length) edits.push({ kind: "class", add, remove });
  if (draft.src !== initial.src) edits.push({ kind: "attr", name: "src", value: draft.src });
  if (draft.alt !== initial.alt) edits.push({ kind: "attr", name: "alt", value: draft.alt });
  if (draft.href !== initial.href) edits.push({ kind: "attr", name: "href", value: draft.href });
  return edits;
}

/**
 * Click-to-edit panel. Changes are applied straight to the source with @forge/visual-edit (AST edit,
 * no LLM) and saved with project.writeFile. If the file is open in the live editor, the same change is
 * spliced into the shared Y.Text so collaborators see it instantly and the room stays authoritative.
 */
export function VisualEditPanel({ projectId, selection, collab, onClose, onSaved }: { projectId: string; selection: ForgeSelectMessage; collab: { path: string; handle: CollabHandle } | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const loc = useMemo(() => parseSrc(selection.src), [selection.src]);
  const [source, setSource] = useState<string | null>(null);
  const [info, setInfo] = useState<ElementInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const initial = useMemo<Draft>(
    () => ({
      text: info?.text ?? (selection.hasDirectText ? selection.text : ""),
      color: info?.style?.color ?? "",
      background: info?.style?.backgroundColor ?? "",
      padding: info?.style?.padding ?? "",
      fontSize: info?.style?.fontSize ?? "",
      addClasses: "",
      removeClasses: "",
      src: info?.attrs.src ?? selection.attrs.src ?? "",
      alt: info?.attrs.alt ?? selection.attrs.alt ?? "",
      href: info?.attrs.href ?? selection.attrs.href ?? "",
    }),
    [info, selection],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  useEffect(() => setDraft(initial), [initial]);

  useEffect(() => {
    if (!loc) return;
    let cancelled = false;
    setError(null);
    setSaved(false);
    const load = async () => {
      const content = collab?.path === loc.path ? collab.handle.ytext.toString() : (await client.project.readFile.query({ projectId, path: loc.path })).content;
      if (cancelled) return;
      setSource(content);
      try {
        setInfo(describeElement(content, loc, { filename: loc.path }));
      } catch (e) {
        setInfo(null);
        setError(e);
      }
    };
    load().catch((e: unknown) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [loc, projectId, client, collab]);

  if (!loc) {
    return (
      <aside className="vedit" aria-label={t("project.visual.title")}>
        <ErrorNotice error={new Error(t("project.visual.badSource"))} />
      </aside>
    );
  }

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const edits = editsFromDraft(initial, draft);
  const lengthsOk = (!draft.padding.trim() || validLength(draft.padding)) && (!draft.fontSize.trim() || validLength(draft.fontSize));

  const save = async () => {
    if (!source || !edits.length) return;
    setSaving(true);
    setError(null);
    try {
      // Re-read the latest content so concurrent edits aren't lost, then apply every change.
      const latest = collab?.path === loc.path ? collab.handle.ytext.toString() : (await client.project.readFile.query({ projectId, path: loc.path })).content;
      let next = latest;
      for (const edit of edits) next = applyVisualEdit(next, loc, edit, { filename: loc.path });
      if (collab?.path === loc.path) {
        const splice = minimalSplice(collab.handle.ytext.toString(), next);
        if (splice)
          collab.handle.doc.transact(() => {
            collab.handle.ytext.delete(splice.index, splice.remove);
            collab.handle.ytext.insert(splice.index, splice.insert);
          }, "visual-edit");
      }
      await client.project.writeFile.mutate({ projectId, path: loc.path, content: next });
      await qc.invalidateQueries({ queryKey: trpc.project.files.queryKey({ projectId }) });
      setSource(next);
      setInfo(describeElement(next, loc, { filename: loc.path }));
      setDraft((d) => ({ ...d, addClasses: "", removeClasses: "" }));
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const errMessage = error instanceof VisualEditError ? t(`project.visual.error.${error.code}`) : null;
  const isImg = selection.tag === "img";
  const isLink = selection.tag === "a";
  const textEditable = info ? info.text !== null || !["img", "input", "br", "hr"].includes(info.tag) : selection.hasDirectText;

  return (
    <aside className="vedit" aria-label={t("project.visual.title")} data-testid="visual-edit-panel">
      <header className="row-between">
        <div>
          <p className="eyebrow">{t("project.visual.title")}</p>
          <p className="mono" style={{ fontSize: "0.78rem" }}>
            &lt;{selection.tag}&gt; · {loc.path}:{loc.line}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={t("common.close")}>
          <Icon name="x" size={16} />
        </button>
      </header>
      {textEditable && (
        <div className="field">
          <label htmlFor="ve-text">{t("project.visual.text")}</label>
          <textarea id="ve-text" className="textarea" rows={3} value={draft.text} onChange={set("text")} disabled={info !== null && info.text === null && !!initial.text} />
          {info && info.text === null && selection.text && <p className="hint">{t("project.visual.textDynamic")}</p>}
        </div>
      )}
      <div className="vedit-grid">
        <div className="field">
          <label htmlFor="ve-color">{t("project.visual.color")}</label>
          <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
            <input type="color" aria-label={t("project.visual.colorPicker")} value={toHex(draft.color) ?? toHex(selection.styles.color) ?? "#000000"} onChange={set("color")} className="swatch" />
            <input id="ve-color" className="input" value={draft.color} placeholder={toHex(selection.styles.color) ?? ""} onChange={set("color")} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="ve-bg">{t("project.visual.background")}</label>
          <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
            <input type="color" aria-label={t("project.visual.backgroundPicker")} value={toHex(draft.background) ?? toHex(selection.styles.backgroundColor) ?? "#ffffff"} onChange={set("background")} className="swatch" />
            <input id="ve-bg" className="input" value={draft.background} placeholder={toHex(selection.styles.backgroundColor) ?? ""} onChange={set("background")} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="ve-pad">{t("project.visual.padding")}</label>
          <input id="ve-pad" className="input" value={draft.padding} placeholder={selection.styles.padding} onChange={set("padding")} aria-invalid={!!draft.padding.trim() && !validLength(draft.padding)} />
        </div>
        <div className="field">
          <label htmlFor="ve-fs">{t("project.visual.fontSize")}</label>
          <input id="ve-fs" className="input" value={draft.fontSize} placeholder={selection.styles.fontSize} onChange={set("fontSize")} aria-invalid={!!draft.fontSize.trim() && !validLength(draft.fontSize)} />
        </div>
      </div>
      <details className="vedit-more">
        <summary>{t("project.visual.classes")}</summary>
        <p className="hint mono">{info?.className ?? selection.classes.join(" ") ?? "—"}</p>
        <div className="vedit-grid">
          <div className="field">
            <label htmlFor="ve-add">{t("project.visual.addClasses")}</label>
            <input id="ve-add" className="input" value={draft.addClasses} onChange={set("addClasses")} placeholder="p-8 rounded-xl" />
          </div>
          <div className="field">
            <label htmlFor="ve-rm">{t("project.visual.removeClasses")}</label>
            <input id="ve-rm" className="input" value={draft.removeClasses} onChange={set("removeClasses")} />
          </div>
        </div>
      </details>
      {isImg && (
        <div className="vedit-grid">
          <div className="field">
            <label htmlFor="ve-src">{t("project.visual.imageSrc")}</label>
            <input id="ve-src" className="input" value={draft.src} onChange={set("src")} />
          </div>
          <div className="field">
            <label htmlFor="ve-alt">{t("project.visual.alt")}</label>
            <input id="ve-alt" className="input" value={draft.alt} onChange={set("alt")} />
          </div>
        </div>
      )}
      {isLink && (
        <div className="field">
          <label htmlFor="ve-href">{t("project.visual.href")}</label>
          <input id="ve-href" className="input" value={draft.href} onChange={set("href")} />
        </div>
      )}
      {errMessage ? <div className="notice notice-warn" role="alert">{errMessage}</div> : <ErrorNotice error={error} compact />}
      <div className="row-between">
        <p className="hint">{saved ? t("project.visual.saved") : t("project.visual.noLlm")}</p>
        <button type="button" className="btn btn-primary btn-sm" disabled={!edits.length || saving || !source || !lengthsOk} onClick={() => void save()} data-testid="visual-edit-save">
          {saving ? t("common.saving") : t("project.visual.apply", { count: edits.length })}
        </button>
      </div>
    </aside>
  );
}
