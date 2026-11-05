import { Platform } from "react-native";

/**
 * Forge dark editorial look: warm near-black paper, off-white ink, a single ember accent, serif display type.
 * Contrast (WCAG): text on bg 16.9:1, muted on bg 7.4:1, accent on bg 7.0:1, onAccent on accent 7.6:1.
 */
export const colors = {
  bg: "#0E0D0B",
  surface: "#171613",
  surface2: "#201E1A",
  border: "#2F2C26",
  borderStrong: "#45413A",
  text: "#F3EFE7",
  muted: "#ADA79B",
  faint: "#7D776C",
  accent: "#FF7A45",
  onAccent: "#1A0B04",
  accentWash: "rgba(255,122,69,0.12)",
  success: "#6CCB8A",
  successWash: "rgba(108,203,138,0.12)",
  warning: "#F2C25C",
  warningWash: "rgba(242,194,92,0.12)",
  danger: "#FF7B7B",
  dangerWash: "rgba(255,123,123,0.12)",
  overlay: "rgba(0,0,0,0.6)",
} as const;

export const fonts = {
  display: Platform.select({ ios: "Georgia", android: "serif", default: "Georgia, 'Times New Roman', serif" }),
  body: Platform.select({ ios: "System", android: "sans-serif", default: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" }),
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, Consolas, monospace" }),
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

/** Type scale. Sizes scale with the OS text size setting (allowFontScaling stays on everywhere). */
export const type = {
  display: { fontFamily: fonts.display, fontSize: 34, lineHeight: 40, color: colors.text, letterSpacing: -0.5 },
  title: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, color: colors.text, letterSpacing: -0.3 },
  heading: { fontFamily: fonts.body, fontSize: 17, lineHeight: 22, fontWeight: "600" as const, color: colors.text },
  body: { fontFamily: fonts.body, fontSize: 16, lineHeight: 23, color: colors.text },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.muted },
  caption: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16, color: colors.muted, letterSpacing: 0.6, textTransform: "uppercase" as const },
  mono: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 18, color: colors.muted },
} as const;

/** Minimum touch target (Apple HIG 44pt, Material 48dp). */
export const MIN_TOUCH = 48;

/** Cap extreme font scaling on dense UI chrome only (body text is never capped). */
export const CHROME_MAX_SCALE = 1.6;
