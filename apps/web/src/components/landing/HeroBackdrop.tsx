"use client";

import { useEffect, useRef, useState } from "react";

/** Lazy-loads the WebGL field on first interaction, so it never competes with first paint. */
export function HeroBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (saveData) return;
    const start = () => {
      void import("./ember-field").then(({ startEmberField }) => {
        if (cancelled) return;
        stop = startEmberField(canvas, { reducedMotion, onReady: () => setReady(true) });
      });
    };
    // Start on the first sign of a person (pointer, touch, scroll, key): the static gradient is the
    // first paint, and the field never competes with loading or runs for idle/background tabs.
    const events = ["pointermove", "pointerdown", "touchstart", "scroll", "keydown"] as const;
    const kick = () => {
      events.forEach((e) => window.removeEventListener(e, kick));
      start();
    };
    events.forEach((e) => window.addEventListener(e, kick, { passive: true, once: true }));
    return () => {
      cancelled = true;
      events.forEach((e) => window.removeEventListener(e, kick));
      stop?.();
    };
  }, []);
  return <canvas ref={ref} className="hero-canvas" data-ready={ready} aria-hidden="true" />;
}
