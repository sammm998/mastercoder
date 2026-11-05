/**
 * Parallax layers: each layer translates vertically by its depth as the section crosses the viewport.
 * Passive scroll listener + rAF, active only while the section is on screen, transform-only. The section
 * reserves its own height (aspect ratio / min-height), so nothing shifts. Static with reduced motion.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { usePrefersReducedMotion } from "../_shared/motion";

export interface ParallaxLayer {
  /** -1..1: negative moves against scroll, 0 is fixed to the section, larger = faster. */
  depth: number;
  content: ReactNode;
  /** Decorative layers are hidden from assistive tech. */
  decorative?: boolean;
  style?: CSSProperties;
}

export interface ParallaxLayersProps {
  id?: string;
  label: string;
  layers: ParallaxLayer[];
  /** Max travel in px for depth 1. */
  travel?: number;
  className?: string;
  /** Render as a decorative <div> (aria-hidden when every layer is decorative) instead of a labelled <section>. */
  as?: "section" | "div";
}

export function ParallaxLayers({ id, label, layers, travel = 160, className = "", as = "section" }: ParallaxLayersProps) {
  const root = useRef<HTMLElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion) return;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>("[data-depth]"));
    let raf = 0;
    let onScreen = false;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // -1 when the section enters from the bottom, +1 when it leaves at the top.
      const progress = Math.max(-1, Math.min(1, (vh / 2 - (r.top + r.height / 2)) / (vh / 2 + r.height / 2)));
      for (const n of nodes) {
        const depth = Number(n.dataset.depth ?? 0);
        n.style.transform = `translate3d(0, ${(-progress * depth * travel).toFixed(1)}px, 0)`;
      }
    };
    const onScroll = () => {
      if (onScreen && !raf) raf = requestAnimationFrame(update);
    };
    const io = new IntersectionObserver(([e]) => {
      onScreen = Boolean(e?.isIntersecting);
      if (onScreen) onScroll();
    });
    io.observe(el);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      nodes.forEach((n) => (n.style.transform = ""));
    };
  }, [reducedMotion, travel]);

  const children = layers.map((layer, i) => (
    <div key={i} className="parallax__layer" data-depth={layer.depth} aria-hidden={layer.decorative ? "true" : undefined} style={{ zIndex: i, ...layer.style }}>
      {layer.content}
    </div>
  ));
  const motion = reducedMotion ? "static" : "scroll";
  if (as === "div") {
    const allDecorative = layers.every((l) => l.decorative);
    return (
      <div ref={root as RefObject<HTMLDivElement | null>} id={id} className={`parallax ${className}`} aria-hidden={allDecorative ? "true" : undefined} data-pattern="parallax-layers" data-motion={motion}>
        {children}
      </div>
    );
  }
  return (
    <section ref={root} id={id} className={`parallax ${className}`} aria-label={label} data-pattern="parallax-layers" data-motion={motion}>
      {children}
    </section>
  );
}

export default ParallaxLayers;
