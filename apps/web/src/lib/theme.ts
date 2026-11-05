import { preferenceCookie } from "./consent";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = "forge_theme";

export function parseTheme(v: string | undefined | null): Theme {
  return v === "light" || v === "dark" ? v : "system";
}

/** Apply a theme without reload: data-theme drives the CSS tokens; "system" defers to the OS. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  document.cookie = preferenceCookie(THEME_COOKIE, theme);
}
