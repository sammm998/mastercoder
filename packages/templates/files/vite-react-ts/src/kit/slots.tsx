import type { ReactNode } from "react";

/**
 * Extension point for @forge/app-kit. When kit features (analytics, cookie consent, i18n, ...) are
 * added, Forge regenerates this file to wrap the app with their providers. With no features
 * installed it renders the app unchanged.
 */
export function KitProviders({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Rendered once at the end of <body> (banners, beacons). No kit features installed. */
export function KitBody() {
  return null;
}
