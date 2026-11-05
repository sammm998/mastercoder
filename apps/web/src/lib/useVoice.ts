"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceStreamer } from "./audio";
import { wsUrl } from "./env";

export type VoiceState = "idle" | "starting" | "listening" | "finishing";
export type VoiceError = "denied" | "unsupported" | "not_configured" | "connection";

/**
 * Mic button state: while listening, `partial` shows the live transcript; on stop the joined final
 * text is delivered to `onDone` (and becomes a normal prompt with source "voice").
 */
export function useVoice(opts: { lang: string; onDone: (text: string) => void }) {
  const [state, setState] = useState<VoiceState>("idle");
  const [partial, setPartial] = useState("");
  const [finals, setFinals] = useState<string[]>([]);
  const [error, setError] = useState<VoiceError | null>(null);
  const [level, setLevel] = useState(0);
  const streamer = useRef<VoiceStreamer | null>(null);
  const finalsRef = useRef<string[]>([]);
  const onDone = useRef(opts.onDone);
  onDone.current = opts.onDone;

  const start = useCallback(
    async (projectId: string) => {
      setError(null);
      setPartial("");
      setFinals([]);
      finalsRef.current = [];
      setState("starting");
      const s = new VoiceStreamer(wsUrl(`/ws/audio/${encodeURIComponent(projectId)}?lang=${encodeURIComponent(opts.lang)}`), {
        onPartial: setPartial,
        onFinal: (text) => {
          finalsRef.current = [...finalsRef.current, text];
          setFinals(finalsRef.current);
          setPartial("");
        },
        onError: (code) => {
          setError(code);
          setState("idle");
          streamer.current = null;
        },
        onLevel: (l) => setLevel(l),
      });
      streamer.current = s;
      await s.start();
      setState((cur) => (cur === "starting" ? "listening" : cur));
    },
    [opts.lang],
  );

  const stop = useCallback(() => {
    const s = streamer.current;
    if (!s) return;
    setState("finishing");
    s.stop();
    streamer.current = null;
    window.setTimeout(() => {
      const text = [...finalsRef.current, partialRef.current].join(" ").replace(/\s+/g, " ").trim();
      setState("idle");
      setPartial("");
      if (text) onDone.current(text);
    }, 1600);
  }, []);

  const partialRef = useRef("");
  partialRef.current = partial;

  useEffect(() => () => streamer.current?.stop(0), []);

  return { state, partial, finals, error, level, start, stop, live: [...finals, partial].join(" ").trim() };
}
