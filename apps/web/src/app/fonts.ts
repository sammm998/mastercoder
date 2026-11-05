import localFont from "next/font/local";

/**
 * Self-hosted from @fontsource-variable packages (no network at build time). next/font/local adds
 * size-adjusted fallbacks so the swap does not shift layout.
 */
export const fraunces = localFont({
  src: [
    { path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-opsz-normal.woff2", weight: "100 900", style: "normal" },
    { path: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-wght-italic.woff2", weight: "100 900", style: "italic" },
  ],
  variable: "--font-fraunces",
  display: "swap",
  fallback: ["Georgia", "serif"],
  adjustFontFallback: "Times New Roman",
});

export const interTight = localFont({
  src: [{ path: "../../node_modules/@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter-tight",
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
