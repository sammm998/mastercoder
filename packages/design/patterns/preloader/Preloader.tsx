/**
 * Non-blocking preloader. The page renders underneath from the first frame; this is only a thin
 * decorative curtain (aria-hidden, pointer-events: none) that counts to 100 as fonts + window load
 * resolve, capped at `maxMs`, then wipes away with a transform and unmounts. It is skipped entirely when
 * already shown this session (cached), with reduced motion, or with Save-Data.
 */
import { useEffect, useState } from "react";
import { isLowPowerDevice, prefersReducedMotion } from "../_shared/motion";

const KEY = "forge:preloaded";

function alreadyShown(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return true; // storage blocked: never risk showing it on every navigation
  }
}

export interface PreloaderProps {
  label: string;
  /** Hard cap so the curtain never delays interaction (ms). */
  maxMs?: number;
}

export function Preloader({ label, maxMs = 1200 }: PreloaderProps) {
  const [phase, setPhase] = useState<"skip" | "count" | "leave">(() =>
    typeof window === "undefined" || alreadyShown() || prefersReducedMotion() || isLowPowerDevice() ? "skip" : "count",
  );
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (phase !== "count") return;
    try {
      sessionStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    const start = performance.now();
    let raf = 0;
    let done = false;
    const ready = Promise.all([
      document.fonts?.ready ?? Promise.resolve(),
      document.readyState === "complete" ? Promise.resolve() : new Promise((r) => window.addEventListener("load", r, { once: true })),
    ]).then(() => {
      done = true;
    });
    const tick = (now: number) => {
      const t = (now - start) / maxMs;
      const target = done ? 100 : Math.min(90, t * 100);
      setProgress((p) => Math.min(100, p + (target - p) * 0.2 + 0.5));
      if ((done && t > 0.35) || t >= 1) {
        setProgress(100);
        setPhase("leave");
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    void ready;
    return () => cancelAnimationFrame(raf);
  }, [phase, maxMs]);

  // Safety net: unmount even if the transitionend event never fires.
  useEffect(() => {
    if (phase !== "leave") return;
    const t = window.setTimeout(() => setPhase("skip"), 2000);
    return () => window.clearTimeout(t);
  }, [phase]);

  if (phase === "skip") return null;
  return (
    <div
      className={`preloader${phase === "leave" ? " is-leaving" : ""}`}
      aria-hidden="true"
      data-pattern="preloader"
      data-motion="css"
      onTransitionEnd={() => setPhase("skip")}
    >
      <span className="preloader__label">{label}</span>
      <span className="preloader__count">{String(Math.round(progress)).padStart(3, "0")}</span>
      <span className="preloader__bar" style={{ transform: `scaleX(${progress / 100})` }} />
    </div>
  );
}

export default Preloader;
