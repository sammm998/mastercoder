/**
 * 3D hero. The headline and a static token gradient poster render immediately (LCP-safe, no layout
 * shift: the canvas is absolutely positioned inside a fixed-height stage). The WebGL scene is code-split
 * with React.lazy and mounted only after window load + idle, and never when the user prefers reduced
 * motion, is on a low-power / save-data device, lacks hardware-accelerated WebGL, or the viewport is
 * narrower than `minViewport` (phones get the poster: no 250 kB 3D chunk on cellular).
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { afterLoadIdle, isLowPowerDevice, supportsWebGL, useInView, usePrefersReducedMotion } from "../_shared/motion";

const Hero3DScene = lazy(() => import("./Hero3DScene"));

export interface Hero3DProps {
  id?: string;
  eyebrow?: string;
  title: ReactNode;
  lede?: string;
  actions?: ReactNode;
  /** Extra content under the actions (e.g. stats). */
  footer?: ReactNode;
  /** Minimum viewport width (px) for the WebGL scene; narrower screens keep the static poster. */
  minViewport?: number;
}

export function Hero3D({ id = "top", eyebrow, title, lede, actions, footer, minViewport = 768 }: Hero3DProps) {
  const ref = useRef<HTMLElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const visible = useInView(ref, { once: false, rootMargin: "0px" });
  const [allowed, setAllowed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (reducedMotion || window.innerWidth < minViewport || isLowPowerDevice() || !supportsWebGL()) {
      setAllowed(false);
      return;
    }
    return afterLoadIdle(() => setAllowed(true), 4000);
  }, [reducedMotion, minViewport]);

  const show3d = allowed && !reducedMotion;
  return (
    <section ref={ref} id={id} className="hero3d" aria-labelledby={`${id}-title`} data-pattern="hero-3d" data-motion={show3d ? "webgl" : "static"}>
      <div className="hero3d__stage" aria-hidden="true">
        <div className="hero3d__poster" />
        {show3d ? (
          <div className={`hero3d__canvas${ready ? " is-ready" : ""}`}>
            <Suspense fallback={null}>
              <Hero3DScene active={visible} onReady={() => setReady(true)} />
            </Suspense>
          </div>
        ) : null}
      </div>
      <div className="hero3d__content">
        {eyebrow ? <p className="hero3d__eyebrow">{eyebrow}</p> : null}
        <h1 id={`${id}-title`} className="hero3d__title">
          {title}
        </h1>
        {lede ? <p className="hero3d__lede">{lede}</p> : null}
        {actions ? <div className="hero3d__actions">{actions}</div> : null}
        {footer}
      </div>
    </section>
  );
}

export default Hero3D;
