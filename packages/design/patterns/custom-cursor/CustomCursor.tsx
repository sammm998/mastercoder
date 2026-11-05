/**
 * Custom cursor follower: a ring that trails the pointer (lerped with rAF, transform only) and grows over
 * interactive elements. Purely decorative (aria-hidden, pointer-events: none) and it never hides the native
 * cursor. Not mounted on touch / coarse pointers or when the user prefers reduced motion.
 */
import { useEffect, useRef } from "react";
import { useCoarsePointer, usePrefersReducedMotion } from "../_shared/motion";

const INTERACTIVE = "a, button, [role='button'], input, select, textarea, summary, [data-cursor]";

function CursorRing() {
  const ring = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ring.current;
    if (!el) return;
    let x = window.innerWidth / 2, y = window.innerHeight / 2, tx = x, ty = y, scale = 1, ts = 1;
    let raf = 0;
    let visible = false;
    const tick = () => {
      x += (tx - x) * 0.18;
      y += (ty - y) * 0.18;
      scale += (ts - scale) * 0.2;
      el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      raf = Math.abs(tx - x) + Math.abs(ty - y) + Math.abs(ts - scale) > 0.1 ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      tx = e.clientX;
      ty = e.clientY;
      const target = e.target instanceof Element ? e.target.closest(INTERACTIVE) : null;
      ts = target ? 2.4 : 1;
      if (!visible) {
        visible = true;
        el.dataset.visible = "true";
      }
      kick();
    };
    const onLeave = () => {
      visible = false;
      el.dataset.visible = "false";
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);
  return <div ref={ring} className="cursor" aria-hidden="true" data-visible="false" data-pattern="custom-cursor" data-motion="pointer" />;
}

export function CustomCursor() {
  const reducedMotion = usePrefersReducedMotion();
  const coarse = useCoarsePointer();
  if (reducedMotion || coarse) return null;
  return <CursorRing />;
}

export default CustomCursor;
