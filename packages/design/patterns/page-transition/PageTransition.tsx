/**
 * Page transitions with the View Transitions API and a graceful fallback. `useHashRoute` is a tiny
 * hash router; `navigate()` wraps the DOM update in `document.startViewTransition` when supported and the
 * user has not asked for reduced motion, otherwise it updates instantly. After every navigation focus moves
 * to the new view's main heading (announced by screen readers), and scroll resets to the top.
 */
import { useCallback, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "../_shared/motion";

type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

/** Run a synchronous DOM update inside a view transition when available. */
export function withViewTransition(update: () => void): void {
  const doc = document as ViewTransitionDoc;
  if (typeof doc.startViewTransition !== "function" || prefersReducedMotion()) {
    update();
    return;
  }
  doc.startViewTransition(() => flushSync(update));
}

const currentHash = () => (typeof window === "undefined" ? "" : window.location.hash.replace(/^#\/?/, ""));

/** Focus the first [data-route-focus] element (usually the view's h1). */
function focusView() {
  const target = document.querySelector<HTMLElement>("[data-route-focus]");
  if (target) {
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
}

/** Hash route ("#/work/slug" -> "work/slug"). Only routes that start with "/" are handled, so in-page anchors keep working. */
export function useHashRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(currentHash);
  useEffect(() => {
    const onPop = () => {
      if (window.location.hash.startsWith("#/") || window.location.hash === "") withViewTransition(() => setRoute(currentHash()));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    const next = to.replace(/^#?\/?/, "");
    withViewTransition(() => {
      history.pushState(null, "", next ? `#/${next}` : window.location.pathname);
      setRoute(next);
      window.scrollTo(0, 0);
    });
    requestAnimationFrame(focusView);
  }, []);
  return [route, navigate];
}

export interface TransitionLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> {
  to: string;
  navigate: (to: string) => void;
  children: ReactNode;
}

/** A real link (works with middle-click / new tab) that uses a view transition for same-tab navigation. */
export function TransitionLink({ to, navigate, children, ...rest }: TransitionLinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={`#/${to.replace(/^#?\/?/, "")}`} onClick={onClick} data-pattern="page-transition" {...rest}>
      {children}
    </a>
  );
}

export default TransitionLink;
