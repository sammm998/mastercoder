"use client";

import { useEffect, useRef, useState } from "react";

/** Lazy-loads the WebGL field after the page is idle, so it never competes with first paint. */
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
    const ric = window.requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => number) | undefined;
    const handle = ric ? ric(start, { timeout: 2500 }) : window.setTimeout(start, 1200);
    return () => {
      cancelled = true;
      if (ric) window.cancelIdleCallback?.(handle);
      else window.clearTimeout(handle);
      stop?.();
    };
  }, []);
  return <canvas ref={ref} className="hero-canvas" data-ready={ready} aria-hidden="true" />;
}
