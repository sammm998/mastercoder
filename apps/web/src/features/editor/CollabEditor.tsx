"use client";

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { MonacoBinding } from "y-monaco";
import { monaco, defineThemes, currentMonacoTheme, languageFor } from "@/lib/monaco";
import { wsUrl } from "@/lib/env";
import { colorFor, peersFromAwareness, remoteCursorCss, type Peer } from "@/lib/collab";

export interface CollabHandle {
  ytext: Y.Text;
  doc: Y.Doc;
  editor: monaco.editor.IStandaloneCodeEditor;
}

export type CollabStatus = "connecting" | "connected" | "disconnected" | "denied";

/**
 * Monaco bound to a shared Y.Text over the API's y-websocket endpoint
 * (/ws/collab/:projectId?doc=<path>). Remote carets and selections carry each person's name/colour.
 */
export default function CollabEditor({
  projectId,
  path,
  userName,
  readOnly = false,
  onPeers,
  onStatus,
  onReady,
  onCommentLine,
  commentLabel,
}: {
  projectId: string;
  path: string;
  userName: string;
  readOnly?: boolean;
  onPeers?: (peers: Peer[]) => void;
  onStatus?: (s: CollabStatus) => void;
  onReady?: (h: CollabHandle | null) => void;
  onCommentLine?: (line: number) => void;
  commentLabel: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [css, setCss] = useState("");
  const cb = useRef({ onPeers, onStatus, onReady, onCommentLine });
  cb.current = { onPeers, onStatus, onReady, onCommentLine };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    defineThemes();
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(wsUrl("/ws/collab"), projectId, doc, { params: { doc: path }, maxBackoffTime: 5000 });
    const ytext = doc.getText("content");
    const model = monaco.editor.createModel("", languageFor(path), monaco.Uri.parse(`inmemory://forge/${projectId}/${path}`));
    const editor = monaco.editor.create(el, {
      model,
      theme: currentMonacoTheme(),
      automaticLayout: true,
      readOnly,
      minimap: { enabled: false },
      fontFamily: "var(--font-jetbrains), ui-monospace, Menlo, monospace",
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderLineHighlight: "line",
      padding: { top: 12, bottom: 12 },
      ariaLabel: path,
    });
    const binding = new MonacoBinding(ytext, model, new Set([editor]), provider.awareness);
    const color = colorFor(userName);
    provider.awareness.setLocalStateField("user", { name: userName, color });

    const updatePeers = () => {
      const peers = peersFromAwareness(provider.awareness.getStates() as Map<number, Record<string, unknown>>, doc.clientID);
      setCss(remoteCursorCss(peers));
      cb.current.onPeers?.(peers);
    };
    provider.awareness.on("change", updatePeers);
    updatePeers();

    const onStatusEvt = ({ status }: { status: string }) => cb.current.onStatus?.(status === "connected" ? "connected" : status === "connecting" ? "connecting" : "disconnected");
    provider.on("status", onStatusEvt);
    provider.on("connection-close", (e: CloseEvent | null) => {
      if (e?.code === 4403) {
        cb.current.onStatus?.("denied");
        provider.shouldConnect = false;
      }
    });

    const action = editor.addAction({
      id: "forge.comment-line",
      label: commentLabel,
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: (ed) => {
        const line = ed.getPosition()?.lineNumber;
        if (line) cb.current.onCommentLine?.(line);
      },
    });

    const themeObserver = new MutationObserver(() => monaco.editor.setTheme(currentMonacoTheme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    cb.current.onReady?.({ ytext, doc, editor });
    return () => {
      cb.current.onReady?.(null);
      themeObserver.disconnect();
      action.dispose();
      provider.awareness.off("change", updatePeers);
      binding.destroy();
      provider.destroy();
      editor.dispose();
      model.dispose();
      doc.destroy();
    };
  }, [projectId, path, userName, readOnly, commentLabel]);

  return (
    <>
      <style>{css}</style>
      <div ref={host} className="monaco-host" data-testid="code-editor" data-path={path} />
    </>
  );
}
