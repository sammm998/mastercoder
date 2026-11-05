/**
 * Shared motion/a11y helpers for Forge patterns. Every animated pattern checks
 * `prefers-reduced-motion` through these hooks and falls back to a static, fully readable state.
 */
import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** True when the user asked the OS for reduced motion. Re-renders when the setting changes. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}

/** True on touch-first devices (no precise hover). */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(hover: none), (pointer: coarse)");
}

interface NavigatorHints {
  deviceMemory?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
}

/** Heuristic for devices that should not run WebGL or heavy motion (save-data, slow network, low memory/cores). */
export function isLowPowerDevice(): boolean {
  if (typeof navigator === "undefined") return true;
  const n = navigator as Navigator & NavigatorHints;
  if (n.connection?.saveData) return true;
  if (n.connection?.effectiveType && /(^|-)(2g|3g)$/.test(n.connection.effectiveType)) return true;
  if (typeof n.deviceMemory === "number" && n.deviceMemory < 4) return true;
  if (typeof n.hardwareConcurrency === "number" && n.hardwareConcurrency < 4) return true;
  return false;
}

/**
 * True when hardware-accelerated WebGL is available. `failIfMajorPerformanceCaveat` makes context creation
 * fail on software rasterisers; the renderer string catches SwiftShader/llvmpipe where the flag is ignored.
 */
export function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const opts: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
    const gl = (canvas.getContext("webgl2", opts) ?? canvas.getContext("webgl", opts)) as WebGLRenderingContext | null;
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !/swiftshader|llvmpipe|software|softpipe|basic render/i.test(renderer);
  } catch {
    return false;
  }
}

/** Run `cb` when the main thread is idle (falls back to a timeout). Returns a cancel function. */
export function onIdle(cb: () => void, timeout = 2000): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(cb, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(cb, 250);
  return () => window.clearTimeout(id);
}

/** Run `cb` after the window load event, then on idle. */
export function afterLoadIdle(cb: () => void, timeout = 3000): () => void {
  let cancelIdle = () => {};
  const start = () => {
    cancelIdle = onIdle(cb, timeout);
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
  return () => {
    window.removeEventListener("load", start);
    cancelIdle();
  };
}

export interface InViewOptions {
  once?: boolean;
  rootMargin?: string;
  threshold?: number;
}

/** IntersectionObserver hook; resolves true immediately where IO is unavailable. */
export function useInView<T extends Element>(ref: RefObject<T | null>, { once = true, rootMargin = "0px 0px -10% 0px", threshold = 0 }: InViewOptions = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) setInView(false);
      },
      { rootMargin, threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, once, rootMargin, threshold]);
  return inView;
}

/** Read a CSS custom property from :root (e.g. "--dur-base"). */
export function cssVar(name: string, fallback = ""): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Duration token in ms (reads e.g. "--dur-slow: 640ms"). */
export function durationVar(name: string, fallback: number): number {
  const v = cssVar(name);
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

/** Parse the --ease token (cubic-bezier) into a 4-number tuple for JS animation libraries. */
export function easeVar(fallback: [number, number, number, number] = [0.16, 1, 0.3, 1]): [number, number, number, number] {
  const m = /cubic-bezier\(([^)]+)\)/.exec(cssVar("--ease"));
  if (!m?.[1]) return fallback;
  const n = m[1].split(",").map((x) => Number(x.trim()));
  return n.length === 4 && n.every(Number.isFinite) ? [n[0]!, n[1]!, n[2]!, n[3]!] : fallback;
}

/** Resolve any CSS colour (including oklch()) to sRGB 0..1 via a 1x1 canvas. */
export function resolveColor(css: string): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d");
  if (!ctx) return [0.5, 0.5, 0.5];
  ctx.fillStyle = "#808080";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0]! / 255, d[1]! / 255, d[2]! / 255];
}
