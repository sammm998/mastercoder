"use client";

import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useLocale, useT } from "@/i18n/client";
import { useVoice } from "@/lib/useVoice";
import { Icon, type IconName } from "./Icon";

export type ComposerMode = "build" | "plan" | "chat";
export const COMPOSER_MODES: ComposerMode[] = ["build", "plan", "chat"];

export interface ComposerSubmit {
  prompt: string;
  source: "typed" | "voice";
  mode: ComposerMode;
  /** Kept for API compatibility: true when mode is "plan". */
  planMode: boolean;
}

const MODE_ICON: Record<ComposerMode, IconName> = { build: "hammer", plan: "list", chat: "chat" };

/** A small icon button with a tooltip (the label is also its accessible name). */
export function ComposerIcon({ icon, label, onClick, pressed, disabled, children }: { icon: IconName; label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; children?: ReactNode }) {
  return (
    <button type="button" className="composer-icon" onClick={onClick} aria-label={label} data-tip={label} aria-pressed={pressed} disabled={disabled}>
      <Icon name={icon} size={17} />
      {children}
    </button>
  );
}

/**
 * The prompt box: one glass card with a mode switch (Build / Plan / Chat), small icon tools on the left
 * (mic with live waveform + transcript, attach, Figma via `tools`) and a round send button.
 * Enter sends, Shift+Enter adds a line. `ensureProject` lets the dashboard create a project just-in-time
 * for the audio socket.
 */
export function PromptComposer({
  onSubmit,
  ensureProject,
  busy = false,
  tools,
  variant = "hero",
  autoFocus = false,
}: {
  onSubmit: (s: ComposerSubmit) => void | Promise<void>;
  ensureProject: () => Promise<string>;
  busy?: boolean;
  tools?: ReactNode;
  variant?: "hero" | "chat";
  autoFocus?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<ComposerMode>("build");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const voice = useVoice({
    lang: locale,
    onDone: (text) => {
      setPrompt("");
      const m = modeRef.current;
      void onSubmit({ prompt: text, source: "voice", mode: m, planMode: m === "plan" });
    },
  });
  const listening = voice.state === "listening" || voice.state === "starting";

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const p = prompt.trim();
    if (!p || busy || listening) return;
    void Promise.resolve(onSubmit({ prompt: p, source: "typed", mode, planMode: mode === "plan" })).then(() => setPrompt(""));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
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
  const placeholder = t(`composer.placeholder.${mode}`);
  const level = Math.min(1, voice.level);

  return (
    <form className={`composer composer-${variant}`} data-mode={mode} onSubmit={submit} aria-busy={busy}>
      <div className="composer-modes" role="radiogroup" aria-label={t("composer.mode.label")}>
        {COMPOSER_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className="composer-mode"
            onClick={() => setMode(m)}
            data-tip={t(`composer.mode.${m}Hint`)}
            data-testid={`mode-${m}`}
          >
            <Icon name={MODE_ICON[m]} size={14} />
            {t(`composer.mode.${m}`)}
          </button>
        ))}
      </div>
      <label htmlFor={`${id}-prompt`} className="sr-only">
        {placeholder}
      </label>
      {listening || voice.state === "finishing" ? (
        <div className="composer-live" aria-live="polite" data-testid="live-transcript">
          <span className="wave" aria-hidden="true" style={{ ["--lvl" as string]: level }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <i key={i} />
            ))}
          </span>
          <span className="composer-live-text">{voice.live || t("composer.recording")}</span>
        </div>
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
        autoFocus={autoFocus}
        aria-describedby={`${id}-hint`}
        data-testid="prompt-input"
      />
      {voice.error && (
        <p className="notice notice-warn composer-error" role="alert">
          {t(`composer.voiceError.${voice.error}`)}
        </p>
      )}
      <div className="composer-bar">
        <div className="composer-tools" role="group" aria-label={t("composer.tools")}>
          <ComposerIcon icon={listening ? "stop" : "mic"} label={listening ? t("composer.stopVoice") : t("composer.startVoice")} onClick={() => void toggleMic()} pressed={listening} disabled={busy || voice.state === "finishing"} />
          {tools}
        </div>
        <span id={`${id}-hint`} className="composer-hint">
          {t("composer.sendHint")}
        </span>
        <button type="submit" className="composer-send" disabled={busy || !prompt.trim() || listening} aria-label={t("composer.send")} data-tip={t("composer.send")} data-testid="prompt-submit">
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrowUp" size={18} strokeWidth={2.2} />}
        </button>
      </div>
    </form>
  );
}
