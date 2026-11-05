/**
 * Sticky scroll storytelling. A sticky visual stage swaps scenes while narrative steps scroll past.
 * GSAP + ScrollTrigger are dynamically imported (not in the initial bundle) and only on wide screens with
 * no reduced-motion preference; they drive the active scene, a scrubbed progress rail and a subtle
 * transform-only parallax. Otherwise an IntersectionObserver sets the active scene with no animation.
 * Content is plain semantic HTML (ordered list of articles) and fully readable without JS.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "../_shared/motion";

export interface StoryStep {
  id: string;
  kicker?: string;
  title: string;
  body: string;
  /** Decorative visual for the step (rendered inline on mobile and in the sticky stage on desktop). */
  visual?: ReactNode;
  /** Optional call to action under the body (e.g. a link to the case study). */
  action?: ReactNode;
}

export interface StickyStoryProps {
  id?: string;
  title: string;
  intro?: string;
  steps: StoryStep[];
  /** Heading level of the section title (step titles are one level deeper). */
  level?: 2 | 3;
}

/** GSAP is only fetched when this matches (wide screen, motion allowed). */
const ENHANCE = "(min-width: 56em) and (prefers-reduced-motion: no-preference)";

export function StickyStory({ id = "story", title, intro, steps, level = 2 }: StickyStoryProps) {
  const root = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<"static" | "scrolltrigger">("static");
  const enhance = useMediaQuery(ENHANCE);

  // Baseline (and reduced-motion) behaviour: IntersectionObserver picks the step in the middle band.
  useEffect(() => {
    const el = root.current;
    if (!el || mode === "scrolltrigger" || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.index ?? 0));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    el.querySelectorAll<HTMLElement>(".story__step").forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [mode]);

  // Enhancement: GSAP ScrollTrigger (lazy) on wide screens without reduced motion. Phones and
  // reduced-motion users never download GSAP.
  useEffect(() => {
    const el = root.current;
    if (!el || !enhance) return;
    let cancelled = false;
    let revert = () => {};
    void Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([{ gsap }, { ScrollTrigger }]) => {
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);
      const mm = gsap.matchMedia();
      mm.add(ENHANCE, () => {
        setMode("scrolltrigger");
        const stepEls = gsap.utils.toArray<HTMLElement>(".story__step", el);
        stepEls.forEach((step, i) => {
          ScrollTrigger.create({
            trigger: step,
            start: "top 55%",
            end: "bottom 45%",
            onToggle: (self) => {
              if (self.isActive) setActive(i);
            },
          });
        });
        const rail = el.querySelector(".story__rail-fill");
        const list = el.querySelector(".story__steps");
        if (rail && list) {
          gsap.fromTo(rail, { scaleY: 0 }, { scaleY: 1, ease: "none", scrollTrigger: { trigger: list, start: "top 55%", end: "bottom 55%", scrub: true } });
        }
        const stage = el.querySelector(".story__stage-inner");
        if (stage && list) {
          gsap.fromTo(stage, { yPercent: 4 }, { yPercent: -4, ease: "none", scrollTrigger: { trigger: list, start: "top bottom", end: "bottom top", scrub: 0.6 } });
        }
        return () => setMode("static");
      });
      revert = () => mm.revert();
    });
    return () => {
      cancelled = true;
      revert();
    };
  }, [enhance]);

  const H = level === 2 ? "h2" : "h3";
  const StepH = level === 2 ? "h3" : "h4";
  return (
    <section ref={root} id={id} className="story" aria-labelledby={`${id}-title`} data-pattern="sticky-story" data-motion={mode}>
      <header className="story__header">
        <H id={`${id}-title`} className="story__title">
          {title}
        </H>
        {intro ? <p className="story__intro">{intro}</p> : null}
      </header>
      <div className="story__layout">
        <div className="story__stage" aria-hidden="true">
          <div className="story__stage-inner">
            {steps.map((s, i) => (
              <div key={s.id} className={`story__layer${i === active ? " is-active" : ""}`}>
                {s.visual}
              </div>
            ))}
          </div>
          <div className="story__counter">
            <span>{String(active + 1).padStart(2, "0")}</span> / {String(steps.length).padStart(2, "0")}
          </div>
        </div>
        <div className="story__rail" aria-hidden="true">
          <div className="story__rail-fill" />
        </div>
        <ol className="story__steps">
          {steps.map((s, i) => (
            <li key={s.id} className={`story__step${i === active ? " is-active" : ""}`} data-index={i} aria-current={i === active ? "step" : undefined}>
              <article>
                {s.visual ? (
                  <div className="story__step-visual" aria-hidden="true">
                    {s.visual}
                  </div>
                ) : null}
                {s.kicker ? <p className="story__kicker">{s.kicker}</p> : null}
                <StepH className="story__step-title">{s.title}</StepH>
                <p className="story__step-body">{s.body}</p>
                {s.action ? <div className="story__action">{s.action}</div> : null}
              </article>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export default StickyStory;
