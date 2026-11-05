"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isInspectorMessage, type ForgeSelectMessage, type ParentToInspector } from "@forge/visual-edit/protocol";
import { useT } from "@/i18n/client";
import { Icon, type IconName } from "@/components/Icon";

export type PreviewMode = "browse" | "edit" | "comment";
const DEVICES: Array<{ w: number; icon: IconName; key: "mobile" | "tablet" | "desktop" }> = [
  { w: 375, icon: "phone", key: "mobile" },
  { w: 768, icon: "tablet", key: "tablet" },
  { w: 1440, icon: "monitor", key: "desktop" },
];

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Live preview in a sandboxed iframe at 375/768/1440 px (scaled to fit). In edit/comment mode the
 * generated app's inspector reports clicked elements via postMessage; messages are accepted only from
 * the preview's own origin and window.
 */
export function PreviewPane({
  url,
  mode,
  onModeChange,
  onSelect,
  highlight,
  reloadKey,
  canWrite,
  placeholder,
}: {
  url: string | null;
  mode: PreviewMode;
  onModeChange: (m: PreviewMode) => void;
  onSelect: (m: ForgeSelectMessage, mode: PreviewMode) => void;
  highlight: string | null;
  reloadKey: number;
  canWrite: boolean;
  /** Shown instead of the empty state while there is no preview URL (e.g. the live build view). */
  placeholder?: ReactNode;
}) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [device, setDevice] = useState(1440);
  const [scale, setScale] = useState(1);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const origin = url ? originOf(url) : null;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const post = (msg: ParentToInspector) => {
    if (origin && frame.current?.contentWindow) frame.current.contentWindow.postMessage(msg, origin);
  };

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, (el.clientWidth - 32) / device)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [device]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!origin || e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      if (!isInspectorMessage(e.data)) return;
      if (e.data.type === "forge:ready") {
        setReady(true);
        frame.current?.contentWindow?.postMessage({ type: "forge:inspect", enabled: modeRef.current !== "browse" } satisfies ParentToInspector, origin);
      } else if (modeRef.current !== "browse") onSelectRef.current(e.data, modeRef.current);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  useEffect(() => {
    post({ type: "forge:inspect", enabled: mode !== "browse" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ready]);

  useEffect(() => {
    post({ type: "forge:highlight", src: highlight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, ready]);

  useEffect(() => {
    setReady(false);
    setLoaded(false);
  }, [url, reloadKey]);

  return (
    <div className="preview">
      <div className="preview-bar">
        <div className="seg" role="group" aria-label={t("project.preview.device")}>
          {DEVICES.map((d) => (
            <button key={d.w} type="button" aria-pressed={device === d.w} onClick={() => setDevice(d.w)} title={t(`project.preview.${d.key}`, { w: d.w })} aria-label={t(`project.preview.${d.key}`, { w: d.w })}>
              <Icon name={d.icon} size={14} />
            </button>
          ))}
        </div>
        <span className="mono subtle preview-url" title={url ?? undefined}>
          {url ?? t("project.preview.none")}
        </span>
        <div className="row" style={{ gap: 6 }}>
          {canWrite && (
            <button type="button" className="btn btn-sm" aria-pressed={mode === "edit"} data-on={mode === "edit"} onClick={() => onModeChange(mode === "edit" ? "browse" : "edit")} disabled={!url} data-testid="visual-edit-toggle">
              <Icon name="cursor" size={14} /> {t("project.preview.visualEdit")}
            </button>
          )}
          <button type="button" className="btn btn-sm" aria-pressed={mode === "comment"} data-on={mode === "comment"} onClick={() => onModeChange(mode === "comment" ? "browse" : "comment")} disabled={!url}>
            <Icon name="comment" size={14} /> {t("project.preview.comment")}
          </button>
          {url && (
            <a className="btn btn-sm btn-icon" href={url} target="_blank" rel="noreferrer noopener" aria-label={t("project.preview.openNew")} title={t("project.preview.openNew")}>
              <Icon name="external" size={14} />
            </a>
          )}
        </div>
      </div>
      <div className="preview-stage" ref={stage}>
        {!url && placeholder ? (
          <div className="preview-live">{placeholder}</div>
        ) : !url ? (
          <div className="preview-empty">
            <span className="preview-empty-mark" aria-hidden="true" />
            <p className="serif" style={{ fontSize: "var(--step-2)" }}>
              {t("project.preview.emptyTitle")}
            </p>
            <p className="muted">{t("project.preview.emptyBody")}</p>
          </div>
        ) : (
          <div className="preview-device" style={{ width: device * scale, height: `calc((100% - 32px))` }}>
            <iframe
              key={`${url}#${reloadKey}`}
              ref={frame}
              src={url}
              title={t("project.preview.frameTitle")}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              allow="clipboard-write"
              referrerPolicy="no-referrer"
              onLoad={() => setLoaded(true)}
              style={{ width: device, height: `${100 / scale}%`, transform: `scale(${scale})` }}
            />
          </div>
        )}
        {url && loaded && mode !== "browse" && !ready && (
          <p className="notice notice-warn preview-hint" role="status">
            {t("project.preview.noInspector")}
          </p>
        )}
        {url && mode !== "browse" && ready && (
          <p className="preview-mode-hint" role="status">
            {mode === "edit" ? t("project.preview.editHint") : t("project.preview.commentHint")}
          </p>
        )}
      </div>
    </div>
  );
}
