"use client";

import { useEffect, useRef } from "react";
import { monaco, defineThemes, currentMonacoTheme, languageFor } from "@/lib/monaco";

/** Read-only side-by-side diff (Monaco diff editor). */
export default function DiffView({ path, original, modified }: { path: string; original: string; modified: string }) {
  const host = useRef<HTMLDivElement>(null);
  const models = useRef<{ a: monaco.editor.ITextModel; b: monaco.editor.ITextModel } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    defineThemes();
    const lang = languageFor(path);
    const a = monaco.editor.createModel("", lang);
    const b = monaco.editor.createModel("", lang);
    models.current = { a, b };
    const editor = monaco.editor.createDiffEditor(el, {
      theme: currentMonacoTheme(),
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: el.clientWidth > 720,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    editor.setModel({ original: a, modified: b });
    return () => {
      editor.dispose();
      a.dispose();
      b.dispose();
      models.current = null;
    };
  }, [path]);

  useEffect(() => {
    const m = models.current;
    if (!m) return;
    if (m.a.getValue() !== original) m.a.setValue(original);
    if (m.b.getValue() !== modified) m.b.setValue(modified);
  }, [original, modified, path]);

  return <div ref={host} className="monaco-host" data-testid="diff-view" />;
}
