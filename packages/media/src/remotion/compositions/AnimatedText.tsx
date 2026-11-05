import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { AnimatedTextProps } from "../props.js";

/** Kinetic typography: lines rise in, type on, or scale in, one after another. */
export function AnimatedText(props: AnimatedTextProps) {
  const frame = useCurrentFrame();
  const { fps, width, durationInFrames } = useVideoConfig();
  const { theme, lines } = props;
  const animation = props.animation ?? "rise";
  const per = Math.max(1, Math.floor((durationInFrames * 0.8) / lines.length));
  const bg = interpolate(frame, [0, durationInFrames], [0, 40]);
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${135 + bg}deg, ${theme.colors.bg}, ${theme.colors.surface})`,
        justifyContent: "center",
        alignItems: "center",
        padding: width * 0.08,
      }}
    >
      {lines.map((line, i) => {
        const local = frame - i * per;
        const p = spring({ frame: local, fps, config: { damping: 180 } });
        const common = { fontFamily: theme.fonts.display, fontSize: width * 0.055, fontWeight: 800, lineHeight: 1.15, margin: 0, color: i % 2 ? theme.colors.accent : theme.colors.text, textAlign: "center" as const };
        if (animation === "typewriter") {
          const chars = Math.floor(interpolate(local, [0, per * 0.8], [0, line.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
          return (
            <p key={i} style={common}>
              {line.slice(0, chars)}
              <span style={{ opacity: local >= 0 && chars < line.length && Math.floor(frame / (fps / 4)) % 2 === 0 ? 1 : 0, color: theme.colors.accent2 }}>|</span>
            </p>
          );
        }
        const transform = animation === "scale" ? `scale(${0.6 + 0.4 * p})` : `translateY(${(1 - p) * 60}px)`;
        return (
          <p key={i} style={{ ...common, opacity: p, transform }}>
            {line}
          </p>
        );
      })}
    </AbsoluteFill>
  );
}
