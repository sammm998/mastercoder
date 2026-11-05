import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** True when the user asked the OS to minimise motion. Safe to call outside the browser. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** React hook: re-renders when the reduced-motion preference changes. Gate JS-driven animation on it. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

/** Duration helper for JS animations: returns 0 when reduced motion is requested. */
export function motionDuration(ms: number, reduced: boolean = prefersReducedMotion()): number {
  return reduced ? 0 : ms;
}
