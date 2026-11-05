import { z } from "zod";

/** Brand tokens used by every composition (subset of @forge/design tokens). */
export const VideoThemeSchema = z.object({
  colors: z.object({
    bg: z.string(),
    surface: z.string(),
    text: z.string(),
    muted: z.string(),
    accent: z.string(),
    accent2: z.string(),
  }),
  fonts: z.object({ display: z.string(), body: z.string() }),
});
export type VideoTheme = z.infer<typeof VideoThemeSchema>;

export const DEFAULT_VIDEO_THEME: VideoTheme = {
  colors: { bg: "#0b0d12", surface: "#161a23", text: "#f4f5f7", muted: "#9aa3b2", accent: "#6d5dfc", accent2: "#22d3a6" },
  fonts: { display: "Inter Display, Inter, sans-serif", body: "Inter, DejaVu Sans, sans-serif" },
};

/** Map loose brand tokens ({ colors: {...}, fonts: {...} } or a palette list) onto a VideoTheme. */
export function videoThemeFrom(tokens: { colors?: Partial<VideoTheme["colors"]> & Record<string, string | undefined>; fonts?: Partial<VideoTheme["fonts"]> }): VideoTheme {
  const c = tokens.colors ?? {};
  return {
    colors: {
      bg: c.bg ?? c.background ?? DEFAULT_VIDEO_THEME.colors.bg,
      surface: c.surface ?? DEFAULT_VIDEO_THEME.colors.surface,
      text: c.text ?? c.foreground ?? DEFAULT_VIDEO_THEME.colors.text,
      muted: c.muted ?? DEFAULT_VIDEO_THEME.colors.muted,
      accent: c.accent ?? c.primary ?? DEFAULT_VIDEO_THEME.colors.accent,
      accent2: c.accent2 ?? c.secondary ?? DEFAULT_VIDEO_THEME.colors.accent2,
    },
    fonts: { display: tokens.fonts?.display ?? DEFAULT_VIDEO_THEME.fonts.display, body: tokens.fonts?.body ?? DEFAULT_VIDEO_THEME.fonts.body },
  };
}

export const ExplainerPropsSchema = z.object({
  theme: VideoThemeSchema,
  title: z.string().min(1),
  subtitle: z.string().optional(),
  sections: z.array(z.object({ heading: z.string(), bullets: z.array(z.string()).max(6) })).min(1).max(10),
});
export type ExplainerProps = z.infer<typeof ExplainerPropsSchema>;

export const ProductDemoPropsSchema = z.object({
  theme: VideoThemeSchema,
  title: z.string().min(1),
  /** Screenshot sources: data:image URIs or http(s) URLs. */
  screenshots: z.array(z.object({ src: z.string(), caption: z.string() })).min(1).max(12),
  device: z.enum(["laptop", "phone", "browser"]).default("browser"),
});
export type ProductDemoProps = z.infer<typeof ProductDemoPropsSchema>;

export const AnimatedTextPropsSchema = z.object({
  theme: VideoThemeSchema,
  lines: z.array(z.string().min(1)).min(1).max(8),
  animation: z.enum(["rise", "typewriter", "scale"]).default("rise"),
});
export type AnimatedTextProps = z.infer<typeof AnimatedTextPropsSchema>;

export const COMPOSITIONS = {
  Explainer: ExplainerPropsSchema,
  ProductDemo: ProductDemoPropsSchema,
  AnimatedText: AnimatedTextPropsSchema,
} as const;
export type CompositionId = keyof typeof COMPOSITIONS;

/** Render settings passed through inputProps so calculateMetadata can size the composition. */
export interface RenderSettings {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
}
