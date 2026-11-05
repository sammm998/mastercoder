/**
 * Horizontal scroll section. Baseline: a keyboard-focusable, scroll-snapping horizontal list (works on
 * touch, with reduced motion and without JS). Enhancement on wide screens without reduced motion: the
 * section grows by the track's overflow and an inner CSS `position: sticky` stage holds the viewport while
 * GSAP ScrollTrigger (lazy-loaded) scrubs a transform-only horizontal pan. Sticky instead of a
 * ScrollTrigger pin means no fixed/relative toggling and therefore no layout shifts while scrolling.
 * Focusing a card while enhanced scrolls the page so that card is in view (keyboard users never get lost).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "../_shared/motion";

/** GSAP is only fetched when this matches (wide screen, motion allowed). */
const ENHANCE = "(min-width: 56em) and (prefers-reduced-motion: no-preference)";

export interface HorizontalItem {
  id: string;
  title: string;
  body: string;
  meta?: string;
  visual?: ReactNode;
  href?: string;
}

export interface HorizontalScrollProps {
  id?: string;
  title: string;
  intro?: string;
  items: HorizontalItem[];
}

export function HorizontalScroll({ id = "horizontal", title, intro, items }: HorizontalScrollProps) {
  const root = useRef<HTMLElement>(null);
  const track = useRef<HTMLUListElement>(null);
  const enhance = useMediaQuery(ENHANCE);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const el = root.current;
    const list = track.current;
    if (!el || !list || !enhance) return;
    let cancelled = false;
    let revert = () => {};
    void Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([{ gsap }, { ScrollTrigger }]) => {
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);
      const mm = gsap.matchMedia();
      mm.add(ENHANCE, () => {
        const distance = () => Math.max(0, list.scrollWidth - list.clientWidth);
        const setDistance = () => el.style.setProperty("--hscroll-distance", `${distance()}px`);
        el.classList.add("is-pinned");
        setPinned(true);
        setDistance();
        ScrollTrigger.addEventListener("refreshInit", setDistance);
        const tween = gsap.to(list, {
          x: () => -distance(),
          ease: "none",
          scrollTrigger: { trigger: el, start: "top top", end: "bottom bottom", scrub: 0.8, invalidateOnRefresh: true },
        });
        const onFocus = (e: FocusEvent) => {
          const st = tween.scrollTrigger;
          const card = (e.target as HTMLElement).closest<HTMLElement>(".hscroll__item");
          if (!st || !card) return;
          const progress = Math.min(1, Math.max(0, (card.offsetLeft - list.clientWidth * 0.1) / (distance() || 1)));
          window.scrollTo({ top: st.start + (st.end - st.start) * progress, behavior: "auto" });
        };
        list.addEventListener("focusin", onFocus);
        ScrollTrigger.refresh();
        return () => {
          list.removeEventListener("focusin", onFocus);
          ScrollTrigger.removeEventListener("refreshInit", setDistance);
          el.classList.remove("is-pinned");
          el.style.removeProperty("--hscroll-distance");
          setPinned(false);
        };
      });
      revert = () => mm.revert();
    });
    return () => {
      cancelled = true;
      revert();
    };
  }, [enhance]);

  return (
    <section ref={root} id={id} className="hscroll" aria-labelledby={`${id}-title`} data-pattern="horizontal-scroll" data-motion={pinned ? "scrolltrigger" : "static"}>
      <div className="hscroll__sticky">
        <div className="hscroll__header">
          <h2 id={`${id}-title`} className="hscroll__title">
            {title}
          </h2>
          {intro ? <p className="hscroll__intro">{intro}</p> : null}
        </div>
        <ul
          ref={track}
          className="hscroll__track"
          // Focusable scroll container so keyboard users can scroll it with arrow keys when not enhanced.
          tabIndex={pinned ? undefined : 0}
          aria-label={`${title} — scroll horizontally`}
        >
          {items.map((item, i) => (
            <li key={item.id} className="hscroll__item">
              <article className="hscroll__card">
                {item.visual ? (
                  <div className="hscroll__visual" aria-hidden="true">
                    {item.visual}
                  </div>
                ) : null}
                <p className="hscroll__index" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </p>
                <h3 className="hscroll__card-title">{item.href ? <a href={item.href}>{item.title}</a> : item.title}</h3>
                {item.meta ? <p className="hscroll__meta">{item.meta}</p> : null}
                <p className="hscroll__body">{item.body}</p>
              </article>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default HorizontalScroll;
