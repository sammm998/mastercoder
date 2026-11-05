/**
 * Split-text reveal: words rise out of a clipping mask with a stagger when the heading scrolls into view.
 * Screen readers get the intact sentence (visually hidden copy); the split words are aria-hidden.
 * Only transform animates and every word keeps its box, so there is no layout shift. With reduced motion
 * the text is rendered plainly.
 */
import { Fragment, useRef, type CSSProperties, type ElementType } from "react";
import { useInView, usePrefersReducedMotion } from "../_shared/motion";

export interface SplitTextProps {
  text: string;
  as?: ElementType;
  className?: string;
  id?: string;
  /** Words (0-based) to emphasise with the accent colour. */
  emphasis?: number[];
  /** Start immediately instead of on scroll (use for above-the-fold headings). */
  immediate?: boolean;
}

export function SplitText({ text, as: Tag = "h2", className = "", id, emphasis = [], immediate = false }: SplitTextProps) {
  const ref = useRef<HTMLElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const inView = useInView(ref, { rootMargin: "0px 0px -15% 0px" });
  const words = text.split(/\s+/).filter(Boolean);

  if (reducedMotion) {
    return (
      <Tag id={id} className={`split ${className}`} data-pattern="split-text" data-motion="static">
        {words.map((w, i) => (
          <span key={i} className={emphasis.includes(i) ? "split__em" : undefined}>
            {w}
            {i < words.length - 1 ? " " : ""}
          </span>
        ))}
      </Tag>
    );
  }

  const revealed = immediate || inView;
  return (
    <Tag ref={ref} id={id} className={`split ${className}${revealed ? " is-revealed" : ""}`} data-pattern="split-text" data-motion="css">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((w, i) => (
          <Fragment key={i}>
            <span className="split__mask">
              <span className={`split__word${emphasis.includes(i) ? " split__em" : ""}`} style={{ "--i": i } as CSSProperties}>
                {w}
              </span>
            </span>
            {i < words.length - 1 ? " " : null}
          </Fragment>
        ))}
      </span>
    </Tag>
  );
}

export default SplitText;
