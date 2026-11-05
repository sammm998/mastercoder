/**
 * Animated counter: counts up (expo-out) when scrolled into view. The final formatted value is always in
 * the DOM for assistive tech (visually hidden); the animated digits are aria-hidden and sit in a box whose
 * width is reserved with `ch` units + tabular figures, so nothing shifts while counting. With reduced
 * motion the final value is shown immediately.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { durationVar, useInView, usePrefersReducedMotion } from "../_shared/motion";

export interface AnimatedCounterProps {
  value: number;
  label: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  locale?: string;
  /** Override duration in ms (defaults to --dur-slow x 1.5). */
  duration?: number;
}

export function AnimatedCounter({ value, label, prefix = "", suffix = "", decimals = 0, locale, duration }: AnimatedCounterProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const inView = useInView(ref, { rootMargin: "0px 0px -20% 0px" });
  const [current, setCurrent] = useState(0);
  const fmt = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const finalText = `${prefix}${fmt.format(value)}${suffix}`;

  useEffect(() => {
    if (!inView || reducedMotion) return;
    const total = duration ?? Math.max(600, durationVar("--dur-slow", 900) * 1.5);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / total);
      const eased = t === 1 ? 1 : 1 - 2 ** (-10 * t);
      setCurrent(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, reducedMotion, value, duration]);

  const shown = reducedMotion ? value : current;
  return (
    <div ref={ref} className="counter" data-pattern="animated-counter" data-motion={reducedMotion ? "static" : "raf"}>
      <p className="counter__value">
        <span className="sr-only">{finalText}</span>
        <span aria-hidden="true" className="counter__digits" style={{ "--chars": finalText.length } as CSSProperties}>
          {prefix}
          {fmt.format(shown)}
          {suffix}
        </span>
      </p>
      <p className="counter__label">{label}</p>
    </div>
  );
}

export interface CounterRowProps {
  id?: string;
  title?: string;
  stats: AnimatedCounterProps[];
}

export function CounterRow({ id = "numbers", title, stats }: CounterRowProps) {
  return (
    <section id={id} className="counters" aria-label={title ? undefined : "Key numbers"} aria-labelledby={title ? `${id}-title` : undefined}>
      {title ? (
        <h2 id={`${id}-title`} className="counters__title">
          {title}
        </h2>
      ) : null}
      <div className="counters__grid">
        {stats.map((s, i) => (
          <AnimatedCounter key={i} {...s} />
        ))}
      </div>
    </section>
  );
}

export default AnimatedCounter;
