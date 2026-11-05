/**
 * Design tokens for React Native (the native equivalent of tokens.css). @forge/design rewrites this
 * file to restyle the app; screens must only use these values.
 */
export const palette = {
  light: {
    bg: "#fafaf7",
    surface: "#ffffff",
    text: "#16161d",
    muted: "#5a5a66",
    accent: "#3349c7",
    accentContrast: "#ffffff",
    border: "#e2e2da",
  },
  dark: {
    bg: "#101014",
    surface: "#18181e",
    text: "#f2f2ee",
    muted: "#a3a3ad",
    accent: "#8c9dff",
    accentContrast: "#101014",
    border: "#2a2a33",
  },
} as const;

export type ColorScheme = keyof typeof palette;
export type Colors = (typeof palette)[ColorScheme];

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48, 16: 64 } as const;
export const radius = { sm: 4, md: 8, lg: 16, full: 9999 } as const;
export const fontSize = { body: 16, lead: 20, h2: 28, h1: 40 } as const;
export const duration = { fast: 150, base: 250, slow: 600 } as const;

export function colorsFor(scheme: string | null | undefined): Colors {
  return scheme === "dark" ? palette.dark : palette.light;
}
