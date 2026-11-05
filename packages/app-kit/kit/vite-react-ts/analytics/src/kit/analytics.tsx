import { useEffect } from "react";
import { buildPageview, sendPageview } from "./pageview";

/**
 * Cookieless pageview beacon (Plausible-compatible). Sends on load and on history navigation
 * (pushState/replaceState/popstate). Honours Do Not Track and Global Privacy Control.
 */
export function Analytics() {
  useEffect(() => {
    const endpoint = import.meta.env.VITE_ANALYTICS_ENDPOINT as string | undefined;
    if (!endpoint) return;
    const domain = (import.meta.env.VITE_ANALYTICS_DOMAIN as string | undefined) ?? window.location.hostname;
    let last = "";
    const track = () => {
      if (window.location.pathname === last) return;
      last = window.location.pathname;
      sendPageview(endpoint, buildPageview(window.location.href, document.referrer, domain));
    };
    const { pushState, replaceState } = window.history;
    window.history.pushState = function (...args: Parameters<History["pushState"]>) {
      pushState.apply(this, args);
      track();
    };
    window.history.replaceState = function (...args: Parameters<History["replaceState"]>) {
      replaceState.apply(this, args);
      track();
    };
    window.addEventListener("popstate", track);
    track();
    return () => {
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
      window.removeEventListener("popstate", track);
    };
  }, []);
  return null;
}
