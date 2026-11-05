import localFont from "next/font/local";

/**
 * Self-hosted from @fontsource-variable packages (no network at build time). next/font/local adds
 * size-adjusted fallbacks so the swap does not shift layout. One friendly geometric grotesk for display
 * and text (DM Sans, variable weight) plus a mono for code; the mono is not preloaded.
 */
export const dmSans = localFont({
  src: [{ path: "../../node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2", weight: "100 1000", style: "normal" }],
  variable: "--font-sans",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  adjustFontFallback: "Arial",
});

export const jetbrainsMono = localFont({
  src: [{ path: "../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-jetbrains",
  display: "swap",
  preload: false,
  fallback: ["ui-monospace", "monospace"],
  adjustFontFallback: false,
});
