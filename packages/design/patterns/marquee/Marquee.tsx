/**
 * Marquee: an infinite CSS transform loop of words/logos. The duplicate track is aria-hidden so screen
 * readers hear the list once. It pauses on hover/focus and has a visible pause/play toggle (WCAG 2.2.2:
 * moving content longer than 5s must be pausable). With reduced motion it renders as a static wrapped list.
 */
import { useState, type CSSProperties } from "react";
import { usePrefersReducedMotion } from "../_shared/motion";

export interface MarqueeProps {
  items: string[];
  label: string;
  /** Seconds for one loop. */
  duration?: number;
  reverse?: boolean;
}

export function Marquee({ items, label, duration = 28, reverse = false }: MarqueeProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [paused, setPaused] = useState(false);
  const list = (hidden: boolean) => (
    <ul className="marquee__list" aria-hidden={hidden ? "true" : undefined}>
      {items.map((item, i) => (
        <li key={i} className="marquee__item">
          {item}
        </li>
      ))}
    </ul>
  );
  if (reducedMotion) {
    return (
      <section className="marquee marquee--static" aria-label={label} data-pattern="marquee" data-motion="static">
        {list(false)}
      </section>
    );
  }
  return (
    <section
      className={`marquee${paused ? " is-paused" : ""}${reverse ? " marquee--reverse" : ""}`}
      aria-label={label}
      data-pattern="marquee"
      data-motion="css"
      style={{ "--marquee-duration": `${duration}s` } as CSSProperties}
    >
      <div className="marquee__viewport">
        <div className="marquee__track">
          {list(false)}
          {list(true)}
        </div>
      </div>
      <button type="button" className="marquee__toggle" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
        <span className="sr-only">{paused ? "Play" : "Pause"} scrolling text</span>
        <span aria-hidden="true">{paused ? "▶" : "❚❚"}</span>
      </button>
    </section>
  );
}

export default Marquee;
