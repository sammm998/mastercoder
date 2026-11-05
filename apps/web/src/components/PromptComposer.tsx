"use client";

import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useLocale, useT } from "@/i18n/client";
import { useVoice } from "@/lib/useVoice";
import { Icon } from "./Icon";

export interface ComposerSubmit {
  prompt: string;
  source: "typed" | "voice";
  planMode: boolean;
}

/**
 * The prompt box: type, or press the mic to stream speech (live transcript shown while speaking; the
 * final text is submitted as a normal prompt with source "voice"). `ensureProject` lets the dashboard
 * create a project just-in-time for the audio socket.
 */
export function PromptComposer({
  onSubmit,
  ensureProject,
  busy = false,
  placeholder,
  submitLabel,
  showPlanMode = true,
  extra,
  variant = "hero",
}: {
  onSubmit: (s: ComposerSubmit) => void | Promise<void>;
  ensureProject: () => Promise<string>;
  busy?: boolean;
  placeholder: string;
  submitLabel: string;
  showPlanMode?: boolean;
  extra?: ReactNode;
  variant?: "hero" | "chat";
}) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const voice = useVoice({
    lang: locale,
    onDone: (text) => {
      setPrompt("");
      void onSubmit({ prompt: text, source: "voice", planMode });
    },
  });
  const listening = voice.state === "listening" || voice.state === "starting";

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const p = prompt.trim();
    if (!p || busy) return;
    void Promise.resolve(onSubmit({ prompt: p, source: "typed", planMode })).then(() => setPrompt(""));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };
  const toggleMic = async () => {
    if (listening) return voice.stop();
    try {
      const projectId = await ensureProject();
      await voice.start(projectId);
    } catch {
      /* ensureProject surfaces its own error */
    }
  };

  return (
    <form className={`prompt-box prompt-${variant}`} onSubmit={submit} aria-busy={busy}>
      <label htmlFor={`${id}-prompt`} className="sr-only">
        {placeholder}
      </label>
      {listening || voice.state === "finishing" ? (
        <p className="transcript-live" aria-live="polite" data-testid="live-transcript">
          {voice.live || t("composer.listening")}
        </p>
      ) : null}
      <textarea
        id={`${id}-prompt`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        rows={variant === "chat" ? 2 : 3}
        maxLength={20000}
        disabled={listening}
        data-testid="prompt-input"
      />
      {voice.error && (
        <p className="notice notice-warn" role="alert" style={{ margin: "0 8px" }}>
          {t(`composer.voiceError.${voice.error}`)}
        </p>
      )}
      <div className="prompt-actions">
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn-icon mic"
            data-active={listening}
            onClick={() => void toggleMic()}
            aria-pressed={listening}
            aria-label={listening ? t("composer.stopVoice") : t("composer.startVoice")}
            title={listening ? t("composer.stopVoice") : t("composer.startVoice")}
            disabled={busy || voice.state === "finishing"}
            style={listening ? { transform: `scale(${1 + Math.min(voice.level, 1) * 0.12})` } : undefined}
          >
            <Icon name={listening ? "stop" : "mic"} />
          </button>
          {extra}
          {showPlanMode && (
            <label className="switch" title={t("composer.planModeHint")}>
              <input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} />
              {t("composer.planMode")}
            </label>
          )}
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="hint" aria-hidden="true">
            {t("composer.shortcut")}
          </span>
          <button type="submit" className="btn btn-primary" disabled={busy || !prompt.trim() || listening} data-testid="prompt-submit">
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={16} />}
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
