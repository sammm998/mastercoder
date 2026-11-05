import type { ReactNode } from "react";
import { site } from "@/lib/site";

/**
 * Extension point for @forge/app-kit. When kit features (analytics, cookie consent, i18n,
 * observability, ...) are added, Forge regenerates this file. With no features installed it is a
 * pass-through.
 */
export async function kitHtmlLang(): Promise<string> {
  return site.locale;
}

export function KitProviders({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Rendered once at the end of <body> (banners, beacons). No kit features installed. */
export function KitBody() {
  return null;
}
