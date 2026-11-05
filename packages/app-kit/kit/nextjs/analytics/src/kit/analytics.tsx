"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { buildPageview, sendPageview } from "./pageview";

/**
 * Cookieless pageview beacon (Plausible-compatible `POST /api/event`). No cookies, no
 * fingerprinting, no personal data; honours Do Not Track and Global Privacy Control.
 */
export function Analytics() {
  const pathname = usePathname();
  useEffect(() => {
    const endpoint = process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT;
    if (!endpoint) return;
    const event = buildPageview(window.location.href, document.referrer, process.env.NEXT_PUBLIC_ANALYTICS_DOMAIN ?? window.location.hostname);
    sendPageview(endpoint, event);
  }, [pathname]);
  return null;
}
