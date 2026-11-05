/** Decide how to show a project preview: Expo Go deep link + QR for Expo projects, WebView for web projects. */

export type PreviewTarget =
  | { kind: "expo"; /** exp:// or exps:// URL that Expo Go opens. */ expoUrl: string; sourceUrl: string }
  | { kind: "web"; url: string };

const EXPO_TEMPLATES = new Set(["expo", "mobile", "react-native", "expo-router"]);

export function isExpoTemplate(template: string | null | undefined): boolean {
  return !!template && EXPO_TEMPLATES.has(template.toLowerCase());
}

/**
 * - exp:// / exps:// URLs (from preview.ready for Expo sandboxes) open in Expo Go as-is.
 * - An http(s) URL for an Expo project (dev server behind the sandbox proxy) becomes exp:// (http) or exps:// (https).
 * - Anything else http(s) is a web preview.
 */
export function classifyPreview(url: string | null | undefined, template?: string | null): PreviewTarget | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === "exp:" || u.protocol === "exps:") return { kind: "expo", expoUrl: url, sourceUrl: url };
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (isExpoTemplate(template)) return { kind: "expo", expoUrl: toExpoUrl(u), sourceUrl: url };
  return { kind: "web", url: u.toString() };
}

function toExpoUrl(u: URL): string {
  const scheme = u.protocol === "https:" ? "exps:" : "exp:";
  return `${scheme}//${u.host}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
}

/** Only http(s) pages may be loaded in the in-app WebView (blocks file:, javascript:, intent: …). */
export function isSafeWebUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
