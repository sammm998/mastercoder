/**
 * Scroll reveal built on Motion (`motion/react`, the successor of framer-motion). Uses the slim `m`
 * component with LazyMotion and *asynchronously loaded* animation features, so the animation engine is a
 * separate chunk that never blocks first render. Animates opacity + y transform only, once, when the
 * element enters the viewport; duration/easing come from the --dur-slow / --ease tokens. Use below the fold
 * (above-the-fold content should paint immediately for LCP). With reduced motion children render statically.
 */
import { LazyMotion, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import type { ReactNode } from "react";
import { durationVar, easeVar } from "../_shared/motion";

const loadFeatures = () => import("./features").then((mod) => mod.default);

export interface RevealProps {
  children: ReactNode;
  /** Delay in seconds (use index * stagger for sequences). */
  delay?: number;
  /** Travel distance in px (defaults to --distance token). */
  y?: number;
  className?: string;
}

export function Reveal({ children, delay = 0, y, className }: RevealProps) {
  const reducedMotion = useReducedMotion();
  if (reducedMotion || typeof document === "undefined") {
    return (
      <div className={className} data-pattern="motion-reveal" data-motion="static">
        {children}
      </div>
    );
  }
  const distance = y ?? (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--distance")) || 24);
  return (
    <LazyMotion features={loadFeatures} strict>
      <m.div
        className={className}
        data-pattern="motion-reveal"
        data-motion="motion"
        initial={{ opacity: 0, y: distance }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "0px 0px -12% 0px" }}
        transition={{ duration: durationVar("--dur-slow", 800) / 1000, ease: easeVar(), delay }}
      >
        {children}
      </m.div>
    </LazyMotion>
  );
}

export default Reveal;
