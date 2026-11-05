/**
 * Bento grid: an asymmetric modular grid of feature tiles (semantic list of articles). Tiles span
 * different column/row counts on wide screens and collapse to one column on phones. Hover/focus lift is
 * transform-only and guarded by prefers-reduced-motion in CSS. Whole-tile links keep a single tab stop.
 */
import type { ReactNode } from "react";

export type BentoSize = "sm" | "md" | "lg" | "wide" | "tall";

export interface BentoItem {
  id: string;
  title: string;
  body: string;
  kicker?: string;
  size?: BentoSize;
  visual?: ReactNode;
  href?: string;
  /** Use the accent surface for this tile. */
  accent?: boolean;
}

export interface BentoGridProps {
  id?: string;
  title: string;
  intro?: string;
  items: BentoItem[];
}

export function BentoGrid({ id = "features", title, intro, items }: BentoGridProps) {
  return (
    <section id={id} className="bento" aria-labelledby={`${id}-title`} data-pattern="bento-grid">
      <div className="bento__header">
        <h2 id={`${id}-title`} className="bento__title">
          {title}
        </h2>
        {intro ? <p className="bento__intro">{intro}</p> : null}
      </div>
      <ul className="bento__grid" role="list">
        {items.map((item) => (
          <li key={item.id} className={`bento__tile bento__tile--${item.size ?? "sm"}${item.accent ? " bento__tile--accent" : ""}`}>
            <article className="bento__card">
              {item.visual ? (
                <div className="bento__visual" aria-hidden="true">
                  {item.visual}
                </div>
              ) : null}
              <div className="bento__text">
                {item.kicker ? <p className="bento__kicker">{item.kicker}</p> : null}
                <h3 className="bento__card-title">{item.href ? <a href={item.href}>{item.title}</a> : item.title}</h3>
                <p className="bento__body">{item.body}</p>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default BentoGrid;
