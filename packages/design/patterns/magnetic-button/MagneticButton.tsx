/**
 * Magnetic button/link: the element and its label drift toward the pointer (transform only) and spring
 * back on leave. Disabled for touch/coarse pointers and reduced motion. Renders a real <a> or <button>,
 * so it is keyboard accessible with a visible focus ring; the hit area is at least 48px tall.
 */
import { useRef, type MouseEvent, type ReactNode } from "react";
import { useCoarsePointer, usePrefersReducedMotion } from "../_shared/motion";

export interface MagneticButtonProps {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  variant?: "solid" | "ghost";
  /** 0..1 pull strength. */
  strength?: number;
  ariaLabel?: string;
}

export function MagneticButton({ children, href, onClick, variant = "solid", strength = 0.35, ariaLabel }: MagneticButtonProps) {
  const ref = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const frame = useRef(0);
  const reducedMotion = usePrefersReducedMotion();
  const coarse = useCoarsePointer();
  const enabled = !reducedMotion && !coarse;

  const move = (e: MouseEvent<HTMLElement>) => {
    if (!enabled) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) * strength;
    const y = (e.clientY - (r.top + r.height / 2)) * strength;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      if (label.current) label.current.style.transform = `translate3d(${x * 0.4}px, ${y * 0.4}px, 0)`;
    });
  };
  const reset = (e: MouseEvent<HTMLElement>) => {
    cancelAnimationFrame(frame.current);
    e.currentTarget.style.transform = "";
    if (label.current) label.current.style.transform = "";
  };

  const common = {
    className: `magnetic magnetic--${variant}`,
    onMouseMove: move,
    onMouseLeave: reset,
    "data-pattern": "magnetic-button",
    "data-motion": enabled ? "pointer" : "static",
    "aria-label": ariaLabel,
  } as const;
  const inner = (
    <span ref={label} className="magnetic__label">
      {children}
    </span>
  );
  return href ? (
    <a ref={ref} href={href} {...common}>
      {inner}
    </a>
  ) : (
    <button ref={ref} type="button" onClick={onClick} {...common}>
      {inner}
    </button>
  );
}

export default MagneticButton;
