import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { ExplainerProps, VideoTheme } from "../props.js";

function TitleCard({ theme, title, subtitle }: { theme: VideoTheme; title: string; subtitle?: string }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const bar = interpolate(frame, [0, fps * 0.8], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: theme.colors.bg, justifyContent: "center", padding: width * 0.08 }}>
      <div style={{ width: `${bar * 18}%`, height: width * 0.006, background: theme.colors.accent, marginBottom: width * 0.02 }} />
      <h1
        style={{
          fontFamily: theme.fonts.display,
          color: theme.colors.text,
          fontSize: width * 0.065,
          lineHeight: 1.05,
          margin: 0,
          opacity: enter,
          transform: `translateY(${(1 - enter) * 40}px)`,
        }}
      >
        {title}
      </h1>
      {subtitle ? (
        <p style={{ fontFamily: theme.fonts.body, color: theme.colors.muted, fontSize: width * 0.025, marginTop: width * 0.02, opacity: interpolate(frame, [fps * 0.4, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
          {subtitle}
        </p>
      ) : null}
    </AbsoluteFill>
  );
}

function SectionCard({ theme, heading, bullets, index }: { theme: VideoTheme; heading: string; bullets: string[]; index: number }) {
  const frame = useCurrentFrame();
  const { fps, width, durationInFrames } = useVideoConfig();
  const head = spring({ frame, fps, config: { damping: 200 } });
  const stagger = Math.max(4, Math.floor((durationInFrames * 0.5) / Math.max(1, bullets.length)));
  return (
    <AbsoluteFill style={{ background: index % 2 ? theme.colors.surface : theme.colors.bg, padding: width * 0.08, justifyContent: "center" }}>
      <div style={{ fontFamily: theme.fonts.body, color: theme.colors.accent2, fontSize: width * 0.016, letterSpacing: 4, textTransform: "uppercase" }}>
        {String(index + 1).padStart(2, "0")}
      </div>
      <h2 style={{ fontFamily: theme.fonts.display, color: theme.colors.text, fontSize: width * 0.045, margin: `${width * 0.01}px 0 ${width * 0.03}px`, opacity: head, transform: `translateX(${(1 - head) * -30}px)` }}>
        {heading}
      </h2>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {bullets.map((b, i) => {
          const p = spring({ frame: frame - fps * 0.3 - i * stagger, fps, config: { damping: 200 } });
          return (
            <li key={i} style={{ display: "flex", alignItems: "center", gap: width * 0.015, marginBottom: width * 0.015, opacity: p, transform: `translateY(${(1 - p) * 24}px)` }}>
              <span style={{ width: width * 0.012, height: width * 0.012, borderRadius: "50%", background: theme.colors.accent, flex: "none" }} />
              <span style={{ fontFamily: theme.fonts.body, color: theme.colors.text, fontSize: width * 0.026 }}>{b}</span>
            </li>
          );
        })}
      </ul>
    </AbsoluteFill>
  );
}

/** Title card followed by one card per section with staggered bullet reveals. */
export function Explainer(props: ExplainerProps) {
  const { durationInFrames } = useVideoConfig();
  const parts = props.sections.length + 1;
  const per = Math.max(1, Math.floor(durationInFrames / parts));
  return (
    <AbsoluteFill style={{ background: props.theme.colors.bg }}>
      <Sequence durationInFrames={per}>
        <TitleCard theme={props.theme} title={props.title} subtitle={props.subtitle} />
      </Sequence>
      {props.sections.map((s, i) => (
        <Sequence key={i} from={per * (i + 1)} durationInFrames={i === props.sections.length - 1 ? durationInFrames - per * (i + 1) : per}>
          <SectionCard theme={props.theme} heading={s.heading} bullets={s.bullets} index={i} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
