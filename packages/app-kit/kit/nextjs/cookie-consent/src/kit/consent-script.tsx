"use client";

import Script from "next/script";
import { useSyncExternalStore } from "react";
import { hasConsent, subscribeConsent, type ConsentCategory } from "./consent";

/**
 * Third-party script that only loads after the visitor granted `category`:
 * <ConsentScript category="marketing" src="https://example.com/pixel.js" />
 */
export function ConsentScript({ category, src, id, children }: { category: ConsentCategory; src?: string; id?: string; children?: string }) {
  const allowed = useSyncExternalStore(subscribeConsent, () => hasConsent(category), () => false);
  if (!allowed) return null;
  return src ? <Script id={id} src={src} strategy="afterInteractive" /> : <Script id={id ?? `consent-${category}`} strategy="afterInteractive">{children}</Script>;
}
