/**
 * Lenis smooth-scroll provider. Lenis is dynamically imported after load + idle, only for fine pointers
 * without reduced motion (touch keeps native momentum scrolling; reduced motion keeps native jumps).
 * Optionally keeps GSAP ScrollTrigger in sync. In-page anchor links are routed through Lenis and focus
 * moves to the target so keyboard and screen-reader users land where they expect.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { afterLoadIdle, useCoarsePointer, usePrefersReducedMotion } from "../_shared/motion";

interface LenisLike {
  scrollTo(target: string | number | HTMLElement, opts?: { offset?: number; immediate?: boolean }): void;
  on(event: "scroll", cb: () => void): void;
  destroy(): void;
}

interface SmoothScrollContextValue {
  /** null until Lenis is active (or when disabled). */
  lenis: LenisLike | null;
  scrollTo(target: string | HTMLElement): void;
}

const Ctx = createContext<SmoothScrollContextValue>({
  lenis: null,
  scrollTo: (t) => {
    const el = typeof t === "string" ? document.querySelector<HTMLElement>(t) : t;
    el?.scrollIntoView();
  },
});

export const useSmoothScroll = () => useContext(Ctx);

export interface SmoothScrollProviderProps {
  children: ReactNode;
  /** Keep GSAP ScrollTrigger positions in sync with Lenis. */
  syncScrollTrigger?: boolean;
  /** 0..1 lerp (lower = smoother). */
  lerp?: number;
}

function focusTarget(el: HTMLElement) {
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

export function SmoothScrollProvider({ children, syncScrollTrigger = false, lerp = 0.1 }: SmoothScrollProviderProps) {
  const reducedMotion = usePrefersReducedMotion();
  const coarse = useCoarsePointer();
  const [lenis, setLenis] = useState<LenisLike | null>(null);

  useEffect(() => {
    if (reducedMotion || coarse) return;
    let instance: LenisLike | null = null;
    let cancelled = false;
    const cancelIdle = afterLoadIdle(() => {
      void import("lenis").then(async ({ default: Lenis }) => {
        if (cancelled) return;
        const l = new Lenis({ lerp, autoRaf: true, anchors: false });
        instance = l;
        document.documentElement.dataset.smoothScroll = "lenis";
        if (syncScrollTrigger) {
          const { ScrollTrigger } = await import("gsap/ScrollTrigger");
          l.on("scroll", () => ScrollTrigger.update());
        }
        setLenis(l);
      });
    });
    return () => {
      cancelled = true;
      cancelIdle();
      instance?.destroy();
      delete document.documentElement.dataset.smoothScroll;
      setLenis(null);
    };
  }, [reducedMotion, coarse, lerp, syncScrollTrigger]);

  // Route in-page anchors through Lenis and move focus to the target.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href^='#']") : null;
      const href = a?.getAttribute("href");
      if (!a || !href || href === "#" || href.startsWith("#/")) return;
      const el = document.querySelector<HTMLElement>(href);
      if (!el) return;
      e.preventDefault();
      if (lenis) lenis.scrollTo(el, { offset: 0 });
      else el.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
      history.replaceState(null, "", href);
      focusTarget(el);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [lenis, reducedMotion]);

  const value: SmoothScrollContextValue = {
    lenis,
    scrollTo: (t) => {
      const el = typeof t === "string" ? document.querySelector<HTMLElement>(t) : t;
      if (!el) return;
      if (lenis) lenis.scrollTo(el);
      else el.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
      focusTarget(el);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export default SmoothScrollProvider;
