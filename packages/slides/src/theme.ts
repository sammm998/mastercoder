import type { DeckTheme } from "./schema.js";

export const DEFAULT_THEME: DeckTheme = {
  colors: { bg: "#0f1115", surface: "#181b22", text: "#f3f4f6", muted: "#9ca3af", accent: "#7c5cff", accent2: "#2dd4bf", border: "#2a2f3a" },
  fonts: { display: "Inter", body: "Inter" },
};

export const LIGHT_THEME: DeckTheme = {
  colors: { bg: "#ffffff", surface: "#f4f5f7", text: "#111318", muted: "#5b6270", accent: "#3b5bfd", accent2: "#f59e0b", border: "#e3e6eb" },
  fonts: { display: "Inter", body: "Inter" },
};

type Loose = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : undefined;
}

function fontName(v: unknown): string | undefined {
  if (typeof v === "string") return v.split(",")[0]?.replace(/['"]/g, "").trim() || undefined;
  if (v && typeof v === "object" && "family" in v) return fontName((v as Loose).family);
  return undefined;
}

/**
 * Build a deck theme from design tokens. Accepts the loose shapes produced by @forge/design
 * (`{ colors | palette: { bg, surface, text, muted, accent, accent2, border } , fonts | typography: { display, body } }`),
 * so slides does not depend on the design package directly.
 */
export function themeFromTokens(tokens: Loose | undefined, fallback: DeckTheme = DEFAULT_THEME): DeckTheme {
  if (!tokens) return fallback;
  const c = ((tokens.colors ?? tokens.palette ?? tokens.color) as Loose | undefined) ?? {};
  const f = ((tokens.fonts ?? tokens.typography ?? tokens.font) as Loose | undefined) ?? {};
  return {
    colors: {
      bg: str(c.bg) ?? str(c.background) ?? fallback.colors.bg,
      surface: str(c.surface) ?? fallback.colors.surface,
      text: str(c.text) ?? str(c.foreground) ?? fallback.colors.text,
      muted: str(c.muted) ?? fallback.colors.muted,
      accent: str(c.accent) ?? str(c.primary) ?? fallback.colors.accent,
      accent2: str(c.accent2) ?? str(c.secondary) ?? fallback.colors.accent2,
      border: str(c.border) ?? fallback.colors.border,
    },
    fonts: {
      display: fontName(f.display) ?? fontName(f.heading) ?? fallback.fonts.display,
      body: fontName(f.body) ?? fontName(f.text) ?? fallback.fonts.body,
    },
  };
}

/** Series colours derived from the theme. */
export function seriesColors(theme: DeckTheme): string[] {
  return [theme.colors.accent, theme.colors.accent2, theme.colors.muted, "#f472b6", "#facc15", "#60a5fa", "#a3e635", "#fb923c"];
}

export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  const ch = (i: number) => {
    const s = parseInt(full.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

export function onColor(bg: string): string {
  return luminance(bg) > 0.4 ? "#111111" : "#ffffff";
}

export function cssFontStack(name: string): string {
  return `'${name.replace(/'/g, "")}', 'Inter', 'Helvetica Neue', Arial, sans-serif`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
